use std::path::Path;
use std::process::Output;
use std::time::Duration;

use tokio::process::Command;
use tracing::{debug, warn};

use crate::error::{CoreError, Result};
use crate::schema::NewBoundingBox;

/// Result of running OCR on a single screenshot.
pub struct TesseractOutput {
    pub full_text: String,
    pub bounding_boxes: Vec<NewBoundingBox>,
    pub word_count: i32,
}

/// Minimum confidence threshold for including a word (0-100).
const MIN_CONFIDENCE: f32 = 30.0;

/// Maximum time to wait for a tesseract process before killing it.
const TESSERACT_TIMEOUT: Duration = Duration::from_secs(10);

/// Run Tesseract OCR on an image file, returning extracted text and bounding boxes.
///
/// Spawns `tesseract` CLI as a subprocess with TSV output format.
/// Filters out low-confidence words (below 30%).
/// Times out after 10 seconds.
pub async fn run_tesseract(image_path: &Path, lang: &str) -> Result<TesseractOutput> {
    let output = spawn_tesseract(image_path, lang).await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(CoreError::Ocr(format!(
            "tesseract exited with {}: {stderr}",
            output.status
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_tsv_output(&stdout)
}

async fn spawn_tesseract(image_path: &Path, lang: &str) -> Result<Output> {
    let child = Command::new("tesseract")
        .arg(image_path)
        .arg("stdout")
        .args(["--oem", "1"])
        .args(["--psm", "3"])
        .args(["-l", lang])
        .arg("tsv")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| CoreError::Ocr(format!("failed to spawn tesseract: {e}")))?;

    let result = tokio::time::timeout(TESSERACT_TIMEOUT, child.wait_with_output()).await;

    match result {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(e)) => Err(CoreError::Ocr(format!("tesseract process error: {e}"))),
        Err(_) => Err(CoreError::Ocr("tesseract timed out after 10s".to_string())),
    }
}

/// Parse Tesseract TSV output into full text and bounding boxes.
///
/// TSV format (level 5 = individual words):
/// ```text
/// level  page_num  block_num  par_num  line_num  word_num  left  top  width  height  conf  text
/// ```
fn parse_tsv_output(tsv: &str) -> Result<TesseractOutput> {
    let mut full_text_parts: Vec<String> = Vec::new();
    let mut bounding_boxes = Vec::new();
    let mut current_line_num: i32 = -1;
    let mut word_count: i32 = 0;

    for line in tsv.lines().skip(1) {
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() < 12 {
            continue;
        }

        let level: i32 = match fields[0].parse() {
            Ok(v) => v,
            Err(_) => continue,
        };

        // Level 5 = individual words
        if level != 5 {
            continue;
        }

        let confidence: f32 = fields[10].parse().unwrap_or(-1.0);
        let text = fields[11].trim();

        if text.is_empty() || confidence < MIN_CONFIDENCE {
            continue;
        }

        let line_num: i32 = fields[4].parse().unwrap_or(0);

        // Insert newline when we move to a new line
        if current_line_num >= 0 && line_num != current_line_num && !full_text_parts.is_empty() {
            full_text_parts.push("\n".to_string());
        }
        current_line_num = line_num;

        full_text_parts.push(text.to_string());
        word_count += 1;

        let left: i32 = fields[6].parse().unwrap_or(0);
        let top: i32 = fields[7].parse().unwrap_or(0);
        let width: i32 = fields[8].parse().unwrap_or(0);
        let height: i32 = fields[9].parse().unwrap_or(0);

        bounding_boxes.push(NewBoundingBox {
            text_content: text.to_string(),
            x: left,
            y: top,
            width,
            height,
            confidence: Some(confidence as f64),
        });
    }

    let full_text = join_words(&full_text_parts);

    debug!(
        words = word_count,
        boxes = bounding_boxes.len(),
        "parsed tesseract output"
    );

    Ok(TesseractOutput {
        full_text,
        bounding_boxes,
        word_count,
    })
}

/// Join word parts with spaces, collapsing around newlines.
fn join_words(parts: &[String]) -> String {
    let mut result = String::new();
    for (i, part) in parts.iter().enumerate() {
        if part == "\n" {
            result.push('\n');
        } else {
            // Add space before word unless at start or after newline
            if i > 0 && !result.is_empty() && !result.ends_with('\n') {
                result.push(' ');
            }
            result.push_str(part);
        }
    }
    result
}

/// Check if tesseract is available on the system.
pub async fn is_tesseract_available() -> bool {
    match Command::new("tesseract").arg("--version").output().await {
        Ok(output) => {
            if output.status.success() {
                let version = String::from_utf8_lossy(&output.stdout);
                debug!(version = %version.lines().next().unwrap_or("unknown"), "tesseract found");
                true
            } else {
                warn!("tesseract found but returned non-zero status");
                false
            }
        }
        Err(e) => {
            warn!(error = %e, "tesseract not found");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_TSV: &str = "\
level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext
1\t1\t0\t0\t0\t0\t0\t0\t1920\t1080\t-1\t
2\t1\t1\t0\t0\t0\t100\t50\t500\t200\t-1\t
3\t1\t1\t1\t0\t0\t100\t50\t500\t100\t-1\t
4\t1\t1\t1\t1\t0\t100\t50\t500\t25\t-1\t
5\t1\t1\t1\t1\t1\t100\t50\t80\t20\t96.5\tHello
5\t1\t1\t1\t1\t2\t190\t50\t90\t20\t94.2\tWorld
4\t1\t1\t1\t2\t0\t100\t80\t500\t25\t-1\t
5\t1\t1\t1\t2\t1\t100\t80\t120\t20\t91.0\tSecond
5\t1\t1\t1\t2\t2\t230\t80\t60\t20\t88.3\tLine";

    const TSV_WITH_LOW_CONFIDENCE: &str = "\
level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext
5\t1\t1\t1\t1\t1\t100\t50\t80\t20\t95.0\tGood
5\t1\t1\t1\t1\t2\t190\t50\t90\t20\t10.0\tNoisy
5\t1\t1\t1\t1\t3\t290\t50\t70\t20\t85.0\tWord";

    #[test]
    fn parse_tsv_should_extract_text_and_boxes() {
        let result = parse_tsv_output(SAMPLE_TSV).unwrap();

        assert_eq!(result.full_text, "Hello World\nSecond Line");
        assert_eq!(result.word_count, 4);
        assert_eq!(result.bounding_boxes.len(), 4);
    }

    #[test]
    fn parse_tsv_should_populate_bounding_box_coordinates() {
        let result = parse_tsv_output(SAMPLE_TSV).unwrap();

        let first_box = &result.bounding_boxes[0];
        assert_eq!(first_box.text_content, "Hello");
        assert_eq!(first_box.x, 100);
        assert_eq!(first_box.y, 50);
        assert_eq!(first_box.width, 80);
        assert_eq!(first_box.height, 20);
        assert!(
            (first_box.confidence.unwrap() - 96.5).abs() < 0.1,
            "confidence should be ~96.5"
        );
    }

    #[test]
    fn parse_tsv_should_filter_low_confidence_words() {
        let result = parse_tsv_output(TSV_WITH_LOW_CONFIDENCE).unwrap();

        assert_eq!(result.full_text, "Good Word");
        assert_eq!(result.word_count, 2);
        assert_eq!(result.bounding_boxes.len(), 2);
    }

    #[test]
    fn parse_tsv_should_handle_empty_input() {
        let tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n";
        let result = parse_tsv_output(tsv).unwrap();

        assert!(result.full_text.is_empty());
        assert_eq!(result.word_count, 0);
        assert!(result.bounding_boxes.is_empty());
    }

    #[test]
    fn join_words_should_space_separate_on_same_line() {
        let parts = vec!["Hello".to_string(), "World".to_string()];
        assert_eq!(join_words(&parts), "Hello World");
    }

    #[test]
    fn join_words_should_newline_between_lines() {
        let parts = vec![
            "Line1".to_string(),
            "\n".to_string(),
            "Line2".to_string(),
        ];
        assert_eq!(join_words(&parts), "Line1\nLine2");
    }
}
