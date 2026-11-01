//! C ABI for the iOS app: MIR analysis without JavaScriptCore, which runs without a JIT inside apps.
use crate::analysis::AnalysisAccumulator;
use std::{
    ffi::{CStr, CString, c_char, c_void},
    fs::File,
    io::{BufReader, Read},
};

pub type Cancelled = extern "C" fn(*mut c_void) -> bool;

/// Same output as the TypeScript `analyzeJSON` (both stream through the 44100 Hz accumulator).
pub fn analyze_interleaved(
    mut reader: impl Read,
    frames: u64,
    cancelled: impl Fn() -> bool,
) -> Result<serde_json::Value, String> {
    let mut accumulator = AnalysisAccumulator::new(frames as f64 / 44100. + 5.);
    let mut bytes = vec![0u8; 32768 * 8];
    let (mut left, mut right) = (vec![0f32; 32768], vec![0f32; 32768]);
    let mut carry = 0;
    let mut read = 0u64;
    loop {
        if cancelled() {
            return Err("cancelled".into());
        }
        let count = reader.read(&mut bytes[carry..]).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        let available = carry + count;
        let complete = available / 8;
        for i in 0..complete {
            left[i] = f32::from_le_bytes(bytes[i * 8..i * 8 + 4].try_into().unwrap());
            right[i] = f32::from_le_bytes(bytes[i * 8 + 4..i * 8 + 8].try_into().unwrap());
        }
        accumulator.push(&left[..complete], &right[..complete])?;
        read += complete as u64;
        carry = available - complete * 8;
        bytes.copy_within(complete * 8..available, 0);
    }
    if carry != 0 || read != frames {
        return Err("short_pcm".into());
    }
    accumulator.finish()
}

/// The analyzer version the output carries; callers compare it with the bundled script before use.
#[unsafe(no_mangle)]
pub extern "C" fn mora_analyzer_version() -> *const c_char {
    c"am-analyzer-14".as_ptr()
}

/// Analyzes interleaved stereo f32le PCM at 44100 Hz. Returns JSON to free with
/// `mora_free_string`, or null on invalid input, a read error or cancellation.
///
/// # Safety
/// `path` is a valid NUL-terminated string; `context` is passed only to `cancelled`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mora_analyze_f32le(
    path: *const c_char,
    frames: u64,
    cancelled: Option<Cancelled>,
    context: *mut c_void,
) -> *mut c_char {
    if path.is_null() || frames == 0 {
        return std::ptr::null_mut();
    }
    let Ok(path) = unsafe { CStr::from_ptr(path) }.to_str() else {
        return std::ptr::null_mut();
    };
    let context = context as usize;
    // A panic would abort the app at the C boundary: report it as a failed analysis instead.
    let result = std::panic::catch_unwind(|| {
        let file = File::open(path).map_err(|e| e.to_string())?;
        let value = analyze_interleaved(BufReader::new(file), frames, || {
            cancelled.is_some_and(|f| f(context as *mut c_void))
        })?;
        serde_json::to_string(&value).map_err(|e| e.to_string())
    });
    match result {
        Ok(Ok(json)) => CString::new(json).map_or(std::ptr::null_mut(), CString::into_raw),
        _ => std::ptr::null_mut(),
    }
}

/// # Safety
/// `value` is null or a pointer returned by `mora_analyze_f32le`, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mora_free_string(value: *mut c_char) {
    if !value.is_null() {
        drop(unsafe { CString::from_raw(value) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{f32::consts::PI, io::Write};

    fn fixture(frames: usize) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(frames * 8);
        for i in 0..frames {
            let beat = if i % 22050 < 600 { (1. - (i % 22050) as f32 / 600.) * 0.5 } else { 0. };
            let l = beat + (i as f32 * 2. * PI * 261.63 / 44100.).sin() * 0.08;
            bytes.extend_from_slice(&l.to_le_bytes());
            bytes.extend_from_slice(&(l * 0.8).to_le_bytes());
        }
        bytes
    }
    fn without_time(mut v: serde_json::Value) -> serde_json::Value {
        v.as_object_mut().unwrap().remove("elapsedMs");
        v
    }

    #[test]
    fn c_abi_matches_the_streaming_accumulator_and_cancels() {
        let frames = 44100 * 20;
        let bytes = fixture(frames);
        let path = std::env::temp_dir().join(format!("mora-ffi-{}.f32le", std::process::id()));
        File::create(&path).unwrap().write_all(&bytes).unwrap();
        let c_path = CString::new(path.to_str().unwrap()).unwrap();

        let mut direct = AnalysisAccumulator::new(0.);
        let (l, r): (Vec<f32>, Vec<f32>) = bytes
            .chunks_exact(8)
            .map(|b| (f32::from_le_bytes(b[..4].try_into().unwrap()), f32::from_le_bytes(b[4..].try_into().unwrap())))
            .unzip();
        direct.push(&l, &r).unwrap();
        let expected = without_time(direct.finish().unwrap());

        let raw = unsafe { mora_analyze_f32le(c_path.as_ptr(), frames as u64, None, std::ptr::null_mut()) };
        assert!(!raw.is_null());
        let actual: serde_json::Value = serde_json::from_str(unsafe { CStr::from_ptr(raw) }.to_str().unwrap()).unwrap();
        unsafe { mora_free_string(raw) };
        assert_eq!(without_time(actual.clone()), expected);
        let version = unsafe { CStr::from_ptr(mora_analyzer_version()) }.to_str().unwrap();
        assert_eq!(actual["version"], version);

        extern "C" fn stop(_: *mut c_void) -> bool {
            true
        }
        assert!(unsafe { mora_analyze_f32le(c_path.as_ptr(), frames as u64, Some(stop), std::ptr::null_mut()) }.is_null());
        assert!(unsafe { mora_analyze_f32le(c_path.as_ptr(), frames as u64 + 1, None, std::ptr::null_mut()) }.is_null());
        std::fs::remove_file(path).unwrap();
    }
}
