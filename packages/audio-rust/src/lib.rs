pub mod analysis;
pub mod compute;
pub mod dsp;
/// C ABI used by the iOS app (see ffi.rs); the desktop shell does not link it.
pub mod ffi;
pub(crate) mod js_json;
pub mod mixer;
pub mod phrase_mix;
pub mod plan;
mod playback;
pub mod render;
pub mod render_metrics;
pub mod source;
mod vocal;
pub mod wsola;
