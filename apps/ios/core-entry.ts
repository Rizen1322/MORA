/** Static, bundled JavaScriptCore API. Never evaluated on the real-time audio thread. */
export { PLANNER_VERSION, ANALYZER_VERSION, DEFAULT_AUTOMIX_SETTINGS } from '../../packages/core/src/types.ts';
import { planTransition, planRequestedTransition } from '../../packages/core/src/plan/planner.ts';
import { DEFAULT_AUTOMIX_SETTINGS, type PlannerTrack, type AutoMixSettings } from '../../packages/core/src/types.ts';

export function planJSON(input: string): string {
  const request = JSON.parse(input) as { a: PlannerTrack; b: PlannerTrack; settings?: Partial<AutoMixSettings>; position?: number };
  for (const track of [request.a, request.b]) {
    if (!track || typeof track.id !== 'string' || !track.id || !Number.isFinite(track.duration) || track.duration <= 0 || track.duration > 86400 || typeof track.mixingAllowed !== 'boolean') throw new Error('Invalid planner track');
    track.analysis ??= null;
  }
  if (request.position !== undefined && (!Number.isFinite(request.position) || request.position < 0)) throw new Error('Invalid playback position');
  const settings = { ...DEFAULT_AUTOMIX_SETTINGS, ...request.settings };
  return JSON.stringify(request.position === undefined
    ? planTransition(request.a, request.b, settings)
    : planRequestedTransition(request.a, request.b, request.position, settings));
}
