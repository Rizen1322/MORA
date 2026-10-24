import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { planTransition, planRequestedTransition } from '../../../packages/core/src/plan/planner.ts';
import { DEFAULT_AUTOMIX_SETTINGS, PLANNER_VERSION, type PlannerTrack } from '../../../packages/core/src/types.ts';
import { fixture, plannerTrack } from '../../../packages/core/test/helpers.ts';

const root = path.resolve(__dirname, '../../..');
const code = buildSync({ entryPoints: [path.join(root, 'apps/ios/core-entry.ts')], bundle: true, format: 'iife', globalName: 'MoraCore', platform: 'neutral', target: 'es2019', legalComments: 'eof', write: false }).outputFiles[0].text;
// Standard ECMAScript globals only: no Node, browser, network or audio runtime.
const context = vm.createContext({});
vm.runInContext(code, context);
const bridge = context.MoraCore as { planJSON: (json: string) => string; PLANNER_VERSION: string };
const a: PlannerTrack = { id: 'a', duration: 180, mixingAllowed: true, analysis: null };
const b: PlannerTrack = { id: 'b', duration: 200, mixingAllowed: true, analysis: null };

describe('static iOS planner bundle', () => {
  it('ships the current core, with no Node/browser dependency', () => {
    expect(bridge.PLANNER_VERSION).toBe(PLANNER_VERSION);
    expect(fs.readFileSync(path.join(root, 'apps/ios/MORA/Resources/mora-core.js'), 'utf8')).toBe(code);
  });
  it('returns the same fallback plan as the desktop core', () => {
    expect(JSON.parse(bridge.planJSON(JSON.stringify({ a, b })))).toEqual(planTransition(a, b, DEFAULT_AUTOMIX_SETTINGS));
  });
  it('preserves measured musical planning across the JSON bridge', () => {
    const first = plannerTrack('measured-a', fixture({ style: 'house', bpm: 124, bars: 32, tonic: 9, mode: 'minor', seed: 901 }));
    const second = plannerTrack('measured-b', fixture({ style: 'house', bpm: 127, bars: 32, tonic: 9, mode: 'minor', seed: 902 }));
    const expected = planTransition(first, second, DEFAULT_AUTOMIX_SETTINGS);
    const actual = JSON.parse(bridge.planJSON(JSON.stringify({ a: first, b: second })));
    expect(actual).toEqual(expected);
    expect(actual.beatAlign).toBeDefined();
  });
  it('preserves a requested transition and custom settings', () => {
    const settings = { ...DEFAULT_AUTOMIX_SETTINGS, fallbackSeconds: 3 };
    expect(JSON.parse(bridge.planJSON(JSON.stringify({ a, b, position: 70, settings })))).toEqual(planRequestedTransition(a, b, 70, settings));
  });
  it('rejects malformed track and playback inputs', () => {
    expect(() => bridge.planJSON(JSON.stringify({ a: { ...a, duration: -1 }, b }))).toThrow('Invalid planner track');
    expect(() => bridge.planJSON(JSON.stringify({ a, b, position: -1 }))).toThrow('Invalid playback position');
  });
});
