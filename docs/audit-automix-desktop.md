# Planner audit before the desktop shell

Date: 2026-10-20. Scope: existing v7 planner, no new transition techniques.

## Confirmed fixes

1. **Drum-phase corrections bypassed entry restrictions.** The candidate search
   respected `maxEntrySkipSeconds`, but a later kick/snare alignment rotation
   could move B outside that search window. With a 0.2-second skip budget the
   synthetic 120 BPM case actually entered at 0.5 seconds. The reverse rotation
   also allowed positions before `audibleStart`, inside trimmed leading silence.
   Both directions now respect the audible opening and the same absolute skip
   ceiling, including preserve mode and the 45%-of-audible-duration cap.
   If neither direction is allowed, the existing entry remains in place.

2. **A tight downbeat cut could fade past the source ending.** Exit selection
   accepted `exit + duration <= audibleEnd + 0.25`. The outgoing deck remains
   audible through that fade, so this tolerance could read beyond its available
   audio. A reproduced 120→156 BPM case ended at 176.05 seconds but the plan
   requested audio through 176.096 seconds. Exit selection now requires the
   complete fade inside the audible recording and selects an earlier boundary.

## Changes and checks

- `packages/core/src/plan/planner.ts`: the two bounded eligibility checks above.
- `packages/core/test/drum-alignment.test.ts`: two regressions, verified failing
  before the fix (0.5 > 0.2, and 2.5 > 2.2) and passing afterwards.
- `packages/core/test/transition-techniques.test.ts`: de-click ending regression,
  verified failing before the fix (176.096 > 176.051) and passing afterwards.
- Five relevant test files: **99/99 tests passed**, exit code 0.
  `npx vitest run packages/core/test/drum-alignment.test.ts packages/core/test/local-transition.test.ts packages/core/test/transition-techniques.test.ts packages/core/test/DJplanning.test.ts packages/core/test/planner.test.ts --maxWorkers=2`
  Machine-readable result: `tools/.cache/audit-planner-desktop-tests.json`.
- `npx tsc -p packages/core`: exit code 0.
- Real saved 24-track analysis selection (local and Yandex), both normal and tight
  styles, with a restrictive 0.2-second skip ceiling: **1,104 plans, 16 phrase
  cuts, no checked entry-limit or phrase-cut source-ending violations**.
  Script: `tools/.cache/audit-planner-limits.ts`.
  Result: `data-dev/reports/audit-planner-desktop-limits.json`.

## Limits and integration

The known `debug.vocalBudget` regression was not present in the current checkout:
the existing DJplanning test already permits v7's directly selected short blend.
No test was weakened to hide that failure; all existing assertions pass.

No PCM rendering or listening was performed in this audit: these fixes enforce
source/entry constraints, and the saved-library check verifies plan geometry.
They are not a claim about subjective sound quality or current runtime analysis
availability. Full application build/browser checks and planner version/cache
invalidation belong to the root integrator. No version, type contract, DSP,
vocal policy, server process, user queue, reactions, or account was changed.
