# Local transition recovery, 20 October 2026

## Problem

The planner previously consulted measured local rhythm regions only if at least
one global beat grid was unstable. Two tracks with stable but incompatible
whole-song BPM estimates therefore fell back immediately, even when a measured
outro and intro were compatible. Local search also lacked the existing global
8–10% long-glide policy. Independently fitted incoming regions could be rejected
because every existing entry cue belonged to the old global phase.

## Change

- After an unsuccessful global beatmatch, search the already measured local
  regions regardless of global stability. Successful global plans are unchanged.
- Offer the first measured downbeat of an incoming region as an additional cue.
  Existing skip costs, maximum skip, and preserve-opening mode still apply.
- Apply the existing gradual glide allowance to local grids: at most the user's
  stretch cap and 10%, at least eight bars and twelve seconds, never tight style.
- Keep the entire overlap inside each selected measured region. No extrapolation
  across an unmeasured gap, no newly generated BPM hypothesis, no extra stretching
  or 1–2 bar tricks. The existing vocal handoff decorator still runs afterward.

This recovers opportunities from existing analysis. It does not guarantee a
beatmatch for arbitrary BPM differences or replace the source separator.

## Regression checks

`packages/core/test/local-transition.test.ts` covers stable-but-incompatible global
BPM recovery, a locally measured entry at 12.37 seconds with a different phase,
entry preservation/skip limits, long-glide duration/stretch/tight-style guards,
numerical beat-phase agreement throughout the actual piecewise tempo maps,
half-time matching, unchanged successful global plans, and low-confidence rejection.

## Primary references

[Mixxx DJing manual](https://manual.mixxx.org/2.4/en/chapters/djing_with_mixxx)
describes matching both tempo and beat phase and the need for accurate grids.
[Mixxx beat detection](https://manual.mixxx.org/2.4/en/chapters/preferences/beat_detection)
describes the constant-tempo assumption and accumulated beatgrid drift. Those
principles motivate using independently validated local windows; the recovery
policy and numeric guardrails here are this project's own implementation.
