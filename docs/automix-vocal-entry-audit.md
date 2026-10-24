# AutoMix: vocal entry corrections

Two planner corrections, 2026-10-21. No change to the audio renderer, decoder,
limiter or live playback controller. These corrections do not diagnose the
reported distortion within a playing track.

## Tempo reset inside a quiet consonant

The short downbeat cut used local vocal-activity mean as its only voice veto.
A quiet consonant inside an otherwise measured sung phrase could pass that
check. The complete outgoing de-click interval, plus a 15 ms reserve at either
edge, now also has to avoid validated lyric edit spans or measured vocal phrases.
Without lyric timing, measured phrases with confidence below 0.35 are ignored.

Regression: incompatible 90/120 BPM grooves with low activity frames but a
confident vocal phrase spanning 160–180 s reject the phrase cut. Ending the
measured phrase at 171 s permits the instrumental downbeat cut again.

## Residual voice at the incoming attack

The outgoing mid/high bleed guard previously reached its target at the end of
B's vocal fade-in, sometimes later because of a 250 ms minimum guard ramp.
This could expose A's backing vocals and doubles under B's first consonant,
even though the main separated voices never overlap.

The smooth guard starts with A's vocal fade and now reaches its target by the
start of B's vocal fade. Existing stronger EQ reductions remain intact. The
target levels are unchanged: mid 0.35, high 0.5. No extra master gain is added.

Regression: a tight two-second blend of continuously singing tracks reaches
both guard targets before the first incoming vocal gain increase. The existing
separate-voice constraints and phrase-safe fade tests also pass.

Planner version is `am-planner-v7-vocal-entry-3`, invalidating cached plans.

## Validation and limits

- Core TypeScript compilation passed.
- DJplanning, transition-techniques and lyrics-handoff: 71 tests passed.
- Planner, local-transition and planner-render-golden: 33 tests passed.
- These are synthetic musical/timing regressions. No subjective listening claim.
- False positive phrase detection may choose a gentler fallback instead of a
  short cut. Missing vocal analysis preserves the previous energy-only behavior.
- The earlier guard can attenuate the outgoing voice band sooner; auditioning
  transitions with strong backing vocals remains useful.
