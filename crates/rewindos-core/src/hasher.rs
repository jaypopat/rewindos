use std::fs;
use std::path::Path;

use image::codecs::webp::WebPEncoder;
use image::{DynamicImage, ImageError, RgbaImage};
use image_hasher::{HashAlg, HasherConfig, ImageHash};

use crate::error::{CoreError, Result};

/// Perceptual image hasher using gradient hash (8x8).
///
/// Produces a 64-bit hash that can be compared via hamming distance
/// to detect near-duplicate screenshots.
pub struct PerceptualHasher {
    hasher: image_hasher::Hasher,
}

impl PerceptualHasher {
    pub fn new() -> Self {
        let hasher = HasherConfig::new()
            .hash_size(8, 8)
            .hash_alg(HashAlg::Gradient)
            .to_hasher();

        Self { hasher }
    }

    /// Compute a perceptual hash from an RGBA image.
    pub fn hash_image(&self, image: &DynamicImage) -> Vec<u8> {
        let hash = self.hasher.hash_image(image);
        hash.as_bytes().to_vec()
    }

    /// Compute hamming distance between two hashes.
    ///
    /// Returns the number of differing bits (0 = identical, 64 = maximally different).
    pub fn hamming_distance(hash_a: &[u8], hash_b: &[u8]) -> u32 {
        // 8x8 gradient hash = 8 bytes, use [u8; 8]
        let a = ImageHash::<[u8; 8]>::from_bytes(hash_a);
        let b = ImageHash::<[u8; 8]>::from_bytes(hash_b);

        match (a, b) {
            (Ok(a), Ok(b)) => a.dist(&b),
            _ => u32::MAX,
        }
    }

    /// Check if a frame is a duplicate of any recent hash.
    ///
    /// Returns `true` if the hamming distance to any recent hash
    /// is within `threshold` (i.e., the frame is a duplicate).
    pub fn is_duplicate(hash: &[u8], recent_hashes: &[(i64, Vec<u8>)], threshold: u32) -> bool {
        recent_hashes
            .iter()
            .any(|(_, prev)| Self::hamming_distance(hash, prev) <= threshold)
    }
}

impl Default for PerceptualHasher {
    fn default() -> Self {
        Self::new()
    }
}

/// Save an image as lossless WebP to the given path.
///
/// `_quality` is accepted for API compatibility but currently unused
/// because `image` 0.25 only supports lossless WebP encoding.
pub fn save_webp(image: &DynamicImage, path: &Path, _quality: u8) -> Result<u64> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let file = fs::File::create(path)?;
    let encoder = WebPEncoder::new_lossless(file);

    image
        .write_with_encoder(encoder)
        .map_err(|e: ImageError| CoreError::Io(std::io::Error::other(e)))?;

    let metadata = fs::metadata(path)?;
    Ok(metadata.len())
}

/// Create a thumbnail from an image, scaled to `max_width` preserving aspect ratio.
pub fn create_thumbnail(image: &DynamicImage, max_width: u32) -> DynamicImage {
    let (w, h) = (image.width(), image.height());
    if w <= max_width {
        return image.clone();
    }

    let new_height = (h as f64 * max_width as f64 / w as f64) as u32;
    image.resize(max_width, new_height, image::imageops::FilterType::Lanczos3)
}

/// Build the screenshot file path from a base directory and timestamp.
///
/// Format: `{base}/YYYY-MM-DD/{timestamp_ms}.webp`
pub fn screenshot_path(screenshots_dir: &Path, timestamp_ms: i64) -> std::path::PathBuf {
    let secs = timestamp_ms / 1000;
    let date = chrono::DateTime::from_timestamp(secs, 0)
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "unknown".to_string());

    screenshots_dir
        .join(&date)
        .join(format!("{timestamp_ms}.webp"))
}

/// Build the thumbnail file path from a base directory and timestamp.
///
/// Format: `{base}/YYYY-MM-DD/thumbs/{timestamp_ms}.webp`
pub fn thumbnail_path(screenshots_dir: &Path, timestamp_ms: i64) -> std::path::PathBuf {
    let secs = timestamp_ms / 1000;
    let date = chrono::DateTime::from_timestamp(secs, 0)
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "unknown".to_string());

    screenshots_dir
        .join(&date)
        .join("thumbs")
        .join(format!("{timestamp_ms}.webp"))
}

/// Create a `DynamicImage` from raw RGBA pixel data.
pub fn image_from_rgba(pixels: &[u8], width: u32, height: u32) -> Result<DynamicImage> {
    let img = RgbaImage::from_raw(width, height, pixels.to_vec())
        .ok_or_else(|| CoreError::Hash("invalid pixel buffer dimensions".to_string()))?;
    Ok(DynamicImage::ImageRgba8(img))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_solid_image(r: u8, g: u8, b: u8, width: u32, height: u32) -> DynamicImage {
        let mut img = RgbaImage::new(width, height);
        for pixel in img.pixels_mut() {
            *pixel = image::Rgba([r, g, b, 255]);
        }
        DynamicImage::ImageRgba8(img)
    }

    #[test]
    fn identical_images_should_have_zero_distance() {
        let hasher = PerceptualHasher::new();
        let img = make_solid_image(100, 150, 200, 64, 64);

        let hash_a = hasher.hash_image(&img);
        let hash_b = hasher.hash_image(&img);

        assert_eq!(
            PerceptualHasher::hamming_distance(&hash_a, &hash_b),
            0,
            "identical images should produce distance 0"
        );
    }

    #[test]
    fn similar_images_should_have_low_distance() {
        let hasher = PerceptualHasher::new();
        let img_a = make_solid_image(100, 150, 200, 64, 64);
        // Slightly different shade
        let img_b = make_solid_image(102, 152, 202, 64, 64);

        let hash_a = hasher.hash_image(&img_a);
        let hash_b = hasher.hash_image(&img_b);

        let dist = PerceptualHasher::hamming_distance(&hash_a, &hash_b);
        assert!(
            dist <= 5,
            "similar images should have low distance, got {dist}"
        );
    }

    #[test]
    fn different_images_should_have_high_distance() {
        let hasher = PerceptualHasher::new();
        // Create two visually distinct images: gradient vs inverse gradient
        let mut img_a = RgbaImage::new(64, 64);
        let mut img_b = RgbaImage::new(64, 64);
        for (x, y, pixel) in img_a.enumerate_pixels_mut() {
            let v = ((x * 4) as u8).wrapping_add((y * 4) as u8);
            *pixel = image::Rgba([v, v, v, 255]);
        }
        for (x, y, pixel) in img_b.enumerate_pixels_mut() {
            let v = 255u8.wrapping_sub(((x * 4) as u8).wrapping_add((y * 4) as u8));
            *pixel = image::Rgba([v, v, v, 255]);
        }

        let hash_a = hasher.hash_image(&DynamicImage::ImageRgba8(img_a));
        let hash_b = hasher.hash_image(&DynamicImage::ImageRgba8(img_b));

        let dist = PerceptualHasher::hamming_distance(&hash_a, &hash_b);
        assert!(
            dist > 10,
            "different images should have high distance, got {dist}"
        );
    }

    #[test]
    fn is_duplicate_should_detect_matching_hash() {
        let hasher = PerceptualHasher::new();
        let img = make_solid_image(100, 150, 200, 64, 64);
        let hash = hasher.hash_image(&img);

        let recent = vec![(1_i64, hash.clone())];
        assert!(PerceptualHasher::is_duplicate(&hash, &recent, 3));
    }

    #[test]
    fn is_duplicate_should_reject_different_hash() {
        let hasher = PerceptualHasher::new();

        // Use gradient vs inverse gradient — structurally different images
        let mut img_a = RgbaImage::new(64, 64);
        let mut img_b = RgbaImage::new(64, 64);
        for (x, y, pixel) in img_a.enumerate_pixels_mut() {
            let v = ((x * 4) as u8).wrapping_add((y * 4) as u8);
            *pixel = image::Rgba([v, v, v, 255]);
        }
        for (x, y, pixel) in img_b.enumerate_pixels_mut() {
            let v = 255u8.wrapping_sub(((x * 4) as u8).wrapping_add((y * 4) as u8));
            *pixel = image::Rgba([v, v, v, 255]);
        }

        let hash_a = hasher.hash_image(&DynamicImage::ImageRgba8(img_a));
        let hash_b = hasher.hash_image(&DynamicImage::ImageRgba8(img_b));

        let recent = vec![(1_i64, hash_b)];
        assert!(!PerceptualHasher::is_duplicate(&hash_a, &recent, 3));
    }

    #[test]
    fn create_thumbnail_should_preserve_aspect_ratio() {
        let img = make_solid_image(100, 100, 100, 1920, 1080);
        let thumb = create_thumbnail(&img, 320);

        assert_eq!(thumb.width(), 320);
        // 1080 * 320/1920 = 180
        assert_eq!(thumb.height(), 180);
    }

    #[test]
    fn create_thumbnail_should_not_upscale() {
        let img = make_solid_image(100, 100, 100, 200, 100);
        let thumb = create_thumbnail(&img, 320);

        assert_eq!(thumb.width(), 200);
        assert_eq!(thumb.height(), 100);
    }

    #[test]
    fn save_webp_should_create_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.webp");
        let img = make_solid_image(100, 150, 200, 64, 64);

        let size = save_webp(&img, &path, 80).unwrap();

        assert!(path.exists());
        assert!(size > 0);
    }

    #[test]
    fn save_webp_should_create_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("deep").join("test.webp");
        let img = make_solid_image(100, 150, 200, 32, 32);

        save_webp(&img, &path, 80).unwrap();

        assert!(path.exists());
    }

    #[test]
    fn image_from_rgba_should_handle_valid_buffer() {
        let pixels = vec![255u8; 64 * 64 * 4];
        let img = image_from_rgba(&pixels, 64, 64).unwrap();

        assert_eq!(img.width(), 64);
        assert_eq!(img.height(), 64);
    }

    #[test]
    fn image_from_rgba_should_reject_invalid_buffer() {
        let pixels = vec![0u8; 10]; // Too small for 64x64
        let result = image_from_rgba(&pixels, 64, 64);

        assert!(result.is_err());
    }

    #[test]
    fn screenshot_path_should_format_correctly() {
        let base = Path::new("/home/user/.rewindos/screenshots");
        let ts_ms = 1706137200_000_i64; // 2024-01-25 in UTC

        let path = screenshot_path(base, ts_ms);

        assert!(
            path.to_str().unwrap().contains("2024-01-2"),
            "path should contain date: {:?}",
            path
        );
        assert!(path.to_str().unwrap().ends_with(".webp"));
    }

    #[test]
    fn thumbnail_path_should_include_thumbs_dir() {
        let base = Path::new("/home/user/.rewindos/screenshots");
        let ts_ms = 1706137200_000_i64;

        let path = thumbnail_path(base, ts_ms);

        assert!(
            path.to_str().unwrap().contains("thumbs"),
            "path should contain thumbs dir: {:?}",
            path
        );
    }
}
