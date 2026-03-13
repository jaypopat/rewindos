use std::path::Path;
use std::sync::Mutex;

use image::DynamicImage;
use ndarray::Array4;
use ort::session::Session;
use ort::value::Tensor;
use tracing::{debug, info, warn};

use crate::error::{CoreError, Result};
use crate::ocr::OcrOutput;
use crate::schema::NewBoundingBox;

/// PaddleOCR engine running 3 ONNX models in-process via ONNX Runtime.
///
/// Models:
/// 1. Detection (DBNet) — locates text regions
/// 2. Classification — determines text angle (0/180)
/// 3. Recognition (CRNN) — reads characters from each region
///
/// Sessions are behind Mutex because `Session::run` requires `&mut self`.
pub struct PaddleOcrEngine {
    det_session: Mutex<Session>,
    cls_session: Mutex<Session>,
    rec_session: Mutex<Session>,
    char_dict: Vec<String>,
}

/// A detected text region with its bounding box.
struct TextRegion {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    cropped: DynamicImage,
}

/// Recognition model input dimensions.
const REC_HEIGHT: u32 = 48;
const REC_WIDTH: u32 = 320;

/// Detection model: images are resized to a multiple of this.
const DET_LIMIT_SIDE: u32 = 960;

/// Minimum confidence for detected text regions.
const DET_THRESHOLD: f32 = 0.3;

/// Minimum confidence for recognised characters.
const REC_THRESHOLD: f32 = 0.5;

/// Build an NCHW f32 tensor from an ndarray and convert to an ort Tensor.
fn make_tensor(input: Array4<f32>) -> Result<Tensor<f32>> {
    Tensor::from_array(input).map_err(|e| CoreError::Ocr(format!("tensor creation: {e}")))
}

impl PaddleOcrEngine {
    /// Load the three ONNX models + character dictionary from `model_dir`.
    ///
    /// Expected files:
    /// - `ch_PP-OCRv4_det_infer.onnx`
    /// - `ch_ppocr_mobile_v2.0_cls_infer.onnx`
    /// - `ch_PP-OCRv4_rec_infer.onnx`
    /// - `ppocr_keys_v1.txt`
    pub fn load(model_dir: &Path) -> Result<Self> {
        let det_path = model_dir.join("ch_PP-OCRv4_det_infer.onnx");
        let cls_path = model_dir.join("ch_ppocr_mobile_v2.0_cls_infer.onnx");
        let rec_path = model_dir.join("ch_PP-OCRv4_rec_infer.onnx");
        let dict_path = model_dir.join("ppocr_keys_v1.txt");

        for p in [&det_path, &cls_path, &rec_path, &dict_path] {
            if !p.exists() {
                return Err(CoreError::Ocr(format!(
                    "PaddleOCR model file not found: {}",
                    p.display()
                )));
            }
        }

        let det_session = Session::builder()
            .map_err(|e| CoreError::Ocr(format!("ort session builder: {e}")))?
            .with_intra_threads(2)
            .map_err(|e| CoreError::Ocr(format!("ort threads: {e}")))?
            .commit_from_file(&det_path)
            .map_err(|e| CoreError::Ocr(format!("load det model: {e}")))?;

        let cls_session = Session::builder()
            .map_err(|e| CoreError::Ocr(format!("ort session builder: {e}")))?
            .with_intra_threads(1)
            .map_err(|e| CoreError::Ocr(format!("ort threads: {e}")))?
            .commit_from_file(&cls_path)
            .map_err(|e| CoreError::Ocr(format!("load cls model: {e}")))?;

        let rec_session = Session::builder()
            .map_err(|e| CoreError::Ocr(format!("ort session builder: {e}")))?
            .with_intra_threads(2)
            .map_err(|e| CoreError::Ocr(format!("ort threads: {e}")))?
            .commit_from_file(&rec_path)
            .map_err(|e| CoreError::Ocr(format!("load rec model: {e}")))?;

        let dict_text = std::fs::read_to_string(&dict_path)
            .map_err(|e| CoreError::Ocr(format!("read dict: {e}")))?;
        let mut char_dict: Vec<String> = dict_text.lines().map(|l| l.to_string()).collect();
        // Prepend blank token for CTC decoding
        char_dict.insert(0, String::new());
        // Append space token
        char_dict.push(" ".to_string());

        info!(
            det = %det_path.display(),
            dict_size = char_dict.len(),
            "PaddleOCR engine loaded"
        );

        Ok(Self {
            det_session: Mutex::new(det_session),
            cls_session: Mutex::new(cls_session),
            rec_session: Mutex::new(rec_session),
            char_dict,
        })
    }

    /// Run OCR on an image file on disk.
    pub fn run_on_file(&self, path: &Path) -> Result<OcrOutput> {
        let img = image::open(path)
            .map_err(|e| CoreError::Ocr(format!("open image {}: {e}", path.display())))?;
        self.run(&img)
    }

    /// Run OCR on a `DynamicImage`.
    pub fn run(&self, image: &DynamicImage) -> Result<OcrOutput> {
        // Step 1: Detect text regions
        let regions = self.detect(image)?;

        if regions.is_empty() {
            return Ok(OcrOutput {
                full_text: String::new(),
                bounding_boxes: Vec::new(),
                word_count: 0,
            });
        }

        debug!(regions = regions.len(), "detected text regions");

        // Step 2: Classify orientation & correct if needed
        let regions = self.classify(regions)?;

        // Step 3: Recognise text in each region
        let mut full_text_parts: Vec<String> = Vec::new();
        let mut bounding_boxes: Vec<NewBoundingBox> = Vec::new();
        let mut word_count: i32 = 0;

        for region in &regions {
            match self.recognise(&region.cropped) {
                Ok(text) if !text.trim().is_empty() => {
                    let words: Vec<&str> = text.split_whitespace().collect();
                    word_count += words.len() as i32;
                    full_text_parts.push(text.clone());

                    bounding_boxes.push(NewBoundingBox {
                        text_content: text,
                        x: region.x,
                        y: region.y,
                        width: region.width,
                        height: region.height,
                        confidence: None,
                    });
                }
                Ok(_) => {} // empty text
                Err(e) => {
                    warn!(error = %e, "recognition failed for region");
                }
            }
        }

        let full_text = full_text_parts.join("\n");

        debug!(words = word_count, boxes = bounding_boxes.len(), "PaddleOCR done");

        Ok(OcrOutput {
            full_text,
            bounding_boxes,
            word_count,
        })
    }

    /// Step 1: Run detection model (DBNet) to find text regions.
    fn detect(&self, image: &DynamicImage) -> Result<Vec<TextRegion>> {
        let rgb = image.to_rgb8();
        let (orig_w, orig_h) = (rgb.width(), rgb.height());

        // Resize to multiple of 32 within DET_LIMIT_SIDE
        let ratio = (DET_LIMIT_SIDE as f32) / (orig_w.max(orig_h) as f32);
        let ratio = ratio.min(1.0);
        let new_w = ((orig_w as f32 * ratio) as u32).max(32);
        let new_h = ((orig_h as f32 * ratio) as u32).max(32);
        let new_w = (new_w + 31) / 32 * 32;
        let new_h = (new_h + 31) / 32 * 32;

        let resized = image::imageops::resize(
            &rgb,
            new_w,
            new_h,
            image::imageops::FilterType::Triangle,
        );

        // Normalise to NCHW float tensor: (mean=[0.485,0.456,0.406], std=[0.229,0.224,0.225])
        let mean = [0.485f32, 0.456, 0.406];
        let std_dev = [0.229f32, 0.224, 0.225];
        let mut input = Array4::<f32>::zeros((1, 3, new_h as usize, new_w as usize));
        for y in 0..new_h as usize {
            for x in 0..new_w as usize {
                let pixel = resized.get_pixel(x as u32, y as u32);
                for c in 0..3 {
                    input[[0, c, y, x]] = (pixel[c] as f32 / 255.0 - mean[c]) / std_dev[c];
                }
            }
        }

        let tensor = make_tensor(input)?;
        let mut det = self.det_session.lock()
            .map_err(|e| CoreError::Ocr(format!("det lock: {e}")))?;
        let outputs = det.run(ort::inputs![tensor])
            .map_err(|e| CoreError::Ocr(format!("det inference: {e}")))?;

        let (shape, data) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| CoreError::Ocr(format!("det output extract: {e}")))?;

        // The output is a probability map of shape [1, 1, H, W]
        // Shape derefs to [i64]
        let det_h = shape.get(2).map(|&d| d as usize).unwrap_or(new_h as usize);
        let det_w = shape.get(3).map(|&d| d as usize).unwrap_or(new_w as usize);

        // Extract bounding boxes from probability map
        let scale_x = orig_w as f32 / det_w as f32;
        let scale_y = orig_h as f32 / det_h as f32;

        // Create binary mask from flat data (layout: [1, 1, H, W])
        let mut mask = vec![false; det_h * det_w];
        for y in 0..det_h {
            for x in 0..det_w {
                let idx = y * det_w + x;
                if idx < data.len() {
                    mask[idx] = data[idx] > DET_THRESHOLD;
                }
            }
        }

        let boxes = extract_boxes_from_mask(&mask, det_w, det_h);

        let mut regions = Vec::new();
        for (bx, by, bw, bh) in boxes {
            // Scale back to original image coords
            let x = (bx as f32 * scale_x) as u32;
            let y = (by as f32 * scale_y) as u32;
            let w = ((bw as f32 * scale_x) as u32).max(1);
            let h = ((bh as f32 * scale_y) as u32).max(1);

            // Clamp to image bounds
            let x = x.min(orig_w.saturating_sub(1));
            let y = y.min(orig_h.saturating_sub(1));
            let w = w.min(orig_w - x);
            let h = h.min(orig_h - y);

            if w < 4 || h < 4 {
                continue;
            }

            let cropped = image.crop_imm(x, y, w, h);

            regions.push(TextRegion {
                x: x as i32,
                y: y as i32,
                width: w as i32,
                height: h as i32,
                cropped,
            });
        }

        // Sort by y then x (reading order: top-to-bottom, left-to-right)
        regions.sort_by(|a, b| {
            let y_cmp = a.y.cmp(&b.y);
            if y_cmp == std::cmp::Ordering::Equal {
                a.x.cmp(&b.x)
            } else {
                y_cmp
            }
        });

        Ok(regions)
    }

    /// Step 2: Classify text angle and rotate 180 if needed.
    fn classify(&self, mut regions: Vec<TextRegion>) -> Result<Vec<TextRegion>> {
        for region in &mut regions {
            let rgb = region.cropped.to_rgb8();
            let resized = image::imageops::resize(
                &rgb,
                192,
                48,
                image::imageops::FilterType::Triangle,
            );

            let mean = [0.5f32, 0.5, 0.5];
            let std_dev = [0.5f32, 0.5, 0.5];
            let mut input = Array4::<f32>::zeros((1, 3, 48, 192));
            for y in 0..48usize {
                for x in 0..192usize {
                    let pixel = resized.get_pixel(x as u32, y as u32);
                    for c in 0..3 {
                        input[[0, c, y, x]] = (pixel[c] as f32 / 255.0 - mean[c]) / std_dev[c];
                    }
                }
            }

            let tensor = make_tensor(input)?;
            let mut cls = self.cls_session.lock()
                .map_err(|e| CoreError::Ocr(format!("cls lock: {e}")))?;
            let outputs = cls.run(ort::inputs![tensor])
                .map_err(|e| CoreError::Ocr(format!("cls inference: {e}")))?;

            let (_shape, scores) = outputs[0]
                .try_extract_tensor::<f32>()
                .map_err(|e| CoreError::Ocr(format!("cls output: {e}")))?;

            // Index 1 = rotated 180, if score > 0.9 then flip
            if scores.len() >= 2 && scores[1] > 0.9 {
                region.cropped = region.cropped.rotate180();
            }
        }

        Ok(regions)
    }

    /// Step 3: Recognise text in a single cropped region using CRNN.
    fn recognise(&self, cropped: &DynamicImage) -> Result<String> {
        let rgb = cropped.to_rgb8();

        // Resize to fixed height, variable width (max REC_WIDTH)
        let aspect = rgb.width() as f32 / rgb.height() as f32;
        let new_w = ((REC_HEIGHT as f32 * aspect) as u32).min(REC_WIDTH).max(1);

        let resized = image::imageops::resize(
            &rgb,
            new_w,
            REC_HEIGHT,
            image::imageops::FilterType::Triangle,
        );

        // Pad to REC_WIDTH if needed
        let mean = [0.5f32, 0.5, 0.5];
        let std_dev = [0.5f32, 0.5, 0.5];
        let mut input = Array4::<f32>::zeros((1, 3, REC_HEIGHT as usize, REC_WIDTH as usize));

        // Fill with padding value (normalised 0 = (0 - 0.5) / 0.5 = -1.0)
        input.fill(-1.0);

        for y in 0..REC_HEIGHT as usize {
            for x in 0..new_w as usize {
                let pixel = resized.get_pixel(x as u32, y as u32);
                for c in 0..3 {
                    input[[0, c, y, x]] = (pixel[c] as f32 / 255.0 - mean[c]) / std_dev[c];
                }
            }
        }

        let tensor = make_tensor(input)?;
        let mut rec = self.rec_session.lock()
            .map_err(|e| CoreError::Ocr(format!("rec lock: {e}")))?;
        let outputs = rec.run(ort::inputs![tensor])
            .map_err(|e| CoreError::Ocr(format!("rec inference: {e}")))?;

        let (shape, data) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| CoreError::Ocr(format!("rec output: {e}")))?;

        // Shape: [1, seq_len, num_classes]
        let seq_len = shape.get(1).map(|&d| d as usize).unwrap_or(0);
        let num_classes = shape.get(2).map(|&d| d as usize).unwrap_or(0);

        // CTC greedy decode
        let mut text = String::new();
        let mut prev_idx: usize = 0;

        for t in 0..seq_len {
            // Find argmax
            let mut max_idx: usize = 0;
            let mut max_val = f32::NEG_INFINITY;
            let row_offset = t * num_classes;
            for c in 0..num_classes {
                let val = data[row_offset + c];
                if val > max_val {
                    max_val = val;
                    max_idx = c;
                }
            }

            // Apply softmax-like confidence check
            if max_idx != 0 && max_idx != prev_idx && max_val > REC_THRESHOLD {
                if max_idx < self.char_dict.len() {
                    text.push_str(&self.char_dict[max_idx]);
                }
            }
            prev_idx = max_idx;
        }

        Ok(text.trim().to_string())
    }
}

/// Extract bounding boxes from a binary mask using flood-fill connected components.
fn extract_boxes_from_mask(mask: &[bool], w: usize, h: usize) -> Vec<(u32, u32, u32, u32)> {
    let mut visited = vec![false; h * w];
    let mut boxes = Vec::new();

    for y in 0..h {
        for x in 0..w {
            let idx = y * w + x;
            if mask[idx] && !visited[idx] {
                // Flood-fill to find the connected component
                let mut min_x = x;
                let mut max_x = x;
                let mut min_y = y;
                let mut max_y = y;
                let mut stack = vec![(x, y)];
                visited[idx] = true;

                while let Some((cx, cy)) = stack.pop() {
                    min_x = min_x.min(cx);
                    max_x = max_x.max(cx);
                    min_y = min_y.min(cy);
                    max_y = max_y.max(cy);

                    for (dx, dy) in [(-1i32, 0), (1, 0), (0, -1i32), (0, 1)] {
                        let nx = cx as i32 + dx;
                        let ny = cy as i32 + dy;
                        if nx >= 0 && nx < w as i32 && ny >= 0 && ny < h as i32 {
                            let ni = ny as usize * w + nx as usize;
                            if mask[ni] && !visited[ni] {
                                visited[ni] = true;
                                stack.push((nx as usize, ny as usize));
                            }
                        }
                    }
                }

                let bw = (max_x - min_x + 1) as u32;
                let bh = (max_y - min_y + 1) as u32;
                // Filter tiny components (noise)
                if bw >= 3 && bh >= 3 {
                    boxes.push((min_x as u32, min_y as u32, bw, bh));
                }
            }
        }
    }

    boxes
}

/// Check if the PaddleOCR models exist at the given directory.
pub fn models_available(model_dir: &Path) -> bool {
    let files = [
        "ch_PP-OCRv4_det_infer.onnx",
        "ch_ppocr_mobile_v2.0_cls_infer.onnx",
        "ch_PP-OCRv4_rec_infer.onnx",
        "ppocr_keys_v1.txt",
    ];
    files.iter().all(|f| model_dir.join(f).exists())
}
