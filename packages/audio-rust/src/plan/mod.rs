//! Native transition planning. The TypeScript implementation remains the parity oracle.
pub(crate) mod beatmatch;
pub(crate) mod common;
pub(crate) mod context;
pub(crate) mod entries;
pub(crate) mod feedback;
mod fullmix;
pub(crate) mod human;
pub(crate) mod level_decorators;
pub(crate) mod local_rhythm;
mod planner;
mod primitives;
pub(crate) mod rhythm_overlap;
mod simple;
pub(crate) mod tempo_decorators;
pub(crate) mod unlocked;
pub(crate) mod voice_measure;

pub use common::{integrate_tempo, output_time_at, point_value};
pub use primitives::{
    bar_pattern, drum_alignment, grid_trust, natural_fade, normalization_gain, tempo_relation,
    verified_drum_shift,
};

use serde_json::Value;

/// JSON boundary used by the desktop worker and parity checks.
pub fn plan(input: &Value) -> Result<Value, String> {
    planner::dispatch(input)
}

pub(crate) mod first_words;
pub(crate) mod vocal_handoff;

pub(crate) mod musical_decorators;
