//! Shared validation for native capture backends.
use super::{CaptureViewport, PaneBounds, SelectedElement};
use serde::Deserialize;

#[derive(Deserialize)]
pub(super) struct CaptureMetadata { pub url: String, pub title: String, pub viewport: CaptureViewport, pub element: Option<SelectedElement> }
pub(super) fn validate_element(element: &SelectedElement) -> Result<(), String> {
    let rect = element.rect;
    if element.selector.len() > 8192 || element.tag_name.len() > 256 || element.text.len() > 8192
        || ![rect.x, rect.y, rect.width, rect.height].iter().all(|n| n.is_finite())
        || rect.width <= 0.0 || rect.height <= 0.0 {
        return Err("invalid native selection geometry".into());
    }
    Ok(())
}
pub(super) fn capture_rect(viewport: &CaptureViewport, element: Option<&SelectedElement>) -> Result<PaneBounds, String> {
    let CaptureViewport { width, height, device_scale_factor } = *viewport;
    if ![width, height, device_scale_factor].iter().all(|n| n.is_finite())
        || width < 1.0 || height < 1.0 || width > 16_384.0 || height > 16_384.0
        || device_scale_factor <= 0.0 || device_scale_factor > 8.0 {
        return Err("invalid native browser viewport".into());
    }
    let Some(element) = element else { return Ok(PaneBounds { x: 0.0, y: 0.0, width, height }); };
    validate_element(element)?;
    let rect = element.rect;
    let x = rect.x.max(0.0).min(width);
    let y = rect.y.max(0.0).min(height);
    let right = (rect.x + rect.width).max(0.0).min(width);
    let bottom = (rect.y + rect.height).max(0.0).min(height);
    if right - x < 1.0 || bottom - y < 1.0 { return Err("selected element is outside the visible page".into()); }
    Ok(PaneBounds { x, y, width: right - x, height: bottom - y })
}


/// Validate the actual encoded PNG size, independent of page-reported DPR.
#[cfg(any(windows, test))]
pub(super) fn png_pixel_width(data: &str) -> Result<f64, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    if data.len() > 32 * 1024 * 1024 { return Err("native snapshot exceeds 24 MB image limit".into()); }
    let bytes = STANDARD.decode(data).map_err(|_| "invalid native snapshot encoding")?;
    if bytes.len() > 24 * 1024 * 1024 || bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return Err("invalid native PNG snapshot".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().expect("PNG header width"));
    let height = u32::from_be_bytes(bytes[20..24].try_into().expect("PNG header height"));
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 32_000_000 { return Err("native snapshot exceeds pixel limit".into()); }
    Ok(f64::from(width))
}

/// CDP can already apply backing DPR (or an emulation override) to clip.scale.
/// Measure the PNG instead of multiplying DPR twice. Allow one pixel rounding.
#[cfg(any(windows, test))]
pub(super) fn capture_scale_adjustment(css_width: f64, expected_dpr: f64, pixel_width: f64) -> Option<f64> {
    let expected_width = css_width * expected_dpr;
    if (pixel_width - expected_width).abs() <= 1.0 { None }
    else { Some(expected_width / pixel_width) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    #[test]
    fn validates_encoded_backing_pixels_not_page_claims() {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        bytes.extend_from_slice(&1600u32.to_be_bytes()); bytes.extend_from_slice(&900u32.to_be_bytes());
        assert_eq!(png_pixel_width(&STANDARD.encode(&bytes)).unwrap(), 1600.0);
        bytes[16..20].copy_from_slice(&100_000u32.to_be_bytes());
        assert!(png_pixel_width(&STANDARD.encode(&bytes)).is_err());
        assert!(png_pixel_width("not png").is_err());
    }

    #[test]
    fn capture_scale_uses_actual_pixels_and_never_duplicates_existing_dpr() {
        assert_eq!(capture_scale_adjustment(200.0, 2.0, 400.0), None);
        assert_eq!(capture_scale_adjustment(200.0, 2.0, 200.0), Some(2.0));
        assert_eq!(capture_scale_adjustment(200.0, 2.0, 800.0), Some(0.5));
        assert_eq!(capture_scale_adjustment(101.0, 1.25, 126.0), None);
        assert_eq!(capture_scale_adjustment(200.0, 1.5, 300.0), None);
    }
}
