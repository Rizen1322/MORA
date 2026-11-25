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
    json_response(|| {
        let file = File::open(path).map_err(|e| e.to_string())?;
        analyze_interleaved(BufReader::new(file), frames, || {
            cancelled.is_some_and(|f| f(context as *mut c_void))
        })
    })
}

/// Plans a transition across the same JSON boundary used by the desktop worker.
///
/// # Safety
/// The caller keeps `length` bytes at `input` readable until this returns.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mora_plan_json(input: *const u8, length: usize) -> *mut c_char {
    if input.is_null() || length == 0 || length > 16 * 1024 * 1024 {
        return std::ptr::null_mut();
    }
    json_response(|| {
        let input = unsafe { std::slice::from_raw_parts(input, length) };
        let request = serde_json::from_slice(input).map_err(|e| e.to_string())?;
        crate::plan::plan(&request)
    })
}

struct PcmAnalysis {
    accumulator: Option<AnalysisAccumulator>,
    channels: (Vec<f32>, Vec<f32>),
    frames: usize,
}

const MAX_PCM_FRAMES: usize = 384 * 1024 * 1024 / 8;

/// Starts a single-threaded analysis. Release its handle with `mora_analysis_free`.
#[unsafe(no_mangle)]
pub extern "C" fn mora_analysis_new(expected_frames: usize) -> *mut c_void {
    if !(1..=MAX_PCM_FRAMES).contains(&expected_frames) {
        return std::ptr::null_mut();
    }
    Box::into_raw(Box::new(PcmAnalysis {
        accumulator: Some(AnalysisAccumulator::new(expected_frames as f64 / 44100. + 5.)),
        channels: (Vec::new(), Vec::new()),
        frames: 0,
    })).cast()
}

/// Adds a block of interleaved stereo f32 PCM at 44100 Hz.
///
/// # Safety
/// `handle` is live and exclusively borrowed for this call. `pcm` is aligned and
/// points to at least `frames * 2` readable floats for the duration of this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mora_analysis_push(handle: *mut c_void, pcm: *const f32, frames: usize) -> bool {
    if handle.is_null() || pcm.is_null() || !(1..=32768).contains(&frames) {
        return false;
    }
    let handle = unsafe { &mut *handle.cast::<PcmAnalysis>() };
    if handle.frames + frames > MAX_PCM_FRAMES {
        return false;
    }
    let Some(accumulator) = handle.accumulator.as_mut() else { return false };
    let pcm = unsafe { std::slice::from_raw_parts(pcm, frames * 2) };
    let (left, right) = &mut handle.channels;
    left.clear();
    right.clear();
    for pair in pcm.chunks_exact(2) {
        left.push(pair[0]);
        right.push(pair[1]);
    }
    if accumulator.push(left, right).is_err() {
        return false;
    }
    handle.frames += frames;
    true
}

/// Completes the analysis once. The handle still needs to be freed, as does the returned JSON.
///
/// # Safety
/// `handle` is live and exclusively borrowed for this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mora_analysis_finish(handle: *mut c_void) -> *mut c_char {
    if handle.is_null() {
        return std::ptr::null_mut();
    }
    let handle = unsafe { &mut *handle.cast::<PcmAnalysis>() };
    if handle.frames == 0 {
        return std::ptr::null_mut();
    }
    let Some(accumulator) = handle.accumulator.take() else { return std::ptr::null_mut() };
    // The accumulator is owned by this closure and discarded on error or panic.
    json_response(move || accumulator.finish())
}

/// # Safety
/// `handle` is null or a live pointer returned by `mora_analysis_new`, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mora_analysis_free(handle: *mut c_void) {
    if !handle.is_null() {
        drop(unsafe { Box::from_raw(handle.cast::<PcmAnalysis>()) });
    }
}

fn json_response(work: impl FnOnce() -> Result<serde_json::Value, String> + std::panic::UnwindSafe) -> *mut c_char {
    match std::panic::catch_unwind(|| work().and_then(|value| serde_json::to_string(&value).map_err(|e| e.to_string()))) {
        Ok(Ok(json)) => CString::new(json).map_or(std::ptr::null_mut(), CString::into_raw),
        _ => std::ptr::null_mut(),
    }
}

/// # Safety
/// `value` is null or a JSON pointer returned by this module, freed once.
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
    #[test]
    fn pcm_blocks_match_file_analysis_and_finish_once() {
        let frames = 44100 * 5;
        let bytes = fixture(frames);
        let expected = analyze_interleaved(bytes.as_slice(), frames as u64, || false).unwrap();
        let pcm: Vec<f32> = bytes.chunks_exact(4)
            .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap())).collect();
        let analysis = mora_analysis_new(frames);
        assert!(!analysis.is_null());
        unsafe {
            assert!(!mora_analysis_push(analysis, [f32::NAN, 0.].as_ptr(), 1));
            for block in pcm.chunks(4094) {
                assert!(mora_analysis_push(analysis, block.as_ptr(), block.len() / 2));
            }
            let raw = mora_analysis_finish(analysis);
            assert!(!raw.is_null());
            let actual = serde_json::from_slice(CStr::from_ptr(raw).to_bytes()).unwrap();
            mora_free_string(raw);
            assert_eq!(without_time(actual), without_time(expected));
            assert!(mora_analysis_finish(analysis).is_null());
            mora_analysis_free(analysis);
        }
    }

    #[test]
    fn planner_c_abi_accepts_desktop_requests() {
        let input = serde_json::json!({
            "from": {"id":"A","duration":120,"mixingAllowed":true},
            "to": {"id":"B","duration":95,"mixingAllowed":true},
            "settings": {}
        });
        let expected = crate::plan::plan(&input).unwrap();
        let bytes = serde_json::to_vec(&input).unwrap();
        unsafe {
            let raw = mora_plan_json(bytes.as_ptr(), bytes.len());
            assert!(!raw.is_null());
            let actual: serde_json::Value = serde_json::from_slice(CStr::from_ptr(raw).to_bytes()).unwrap();
            mora_free_string(raw);
            assert_eq!(actual, expected);
            assert!(mora_plan_json(b"[]".as_ptr(), 2).is_null());
        }
    }

}
