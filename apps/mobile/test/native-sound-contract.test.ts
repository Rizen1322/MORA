import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { BUILTIN_PRESETS, EQ_BANDS, EQ_MAX_DB } from '@automix/core';

it('keeps the native EQ frequencies, limits and built-in presets identical to core', () => {
  const source = readFileSync(new URL('../ios/App/App/NativeSoundState.swift', import.meta.url), 'utf8');
  expect(JSON.parse(source.match(/static let bands = (\[[^\]]+\])/)![1])).toEqual([...EQ_BANDS]);
  expect(Number(source.match(/static let maxDB = ([\d.]+)/)![1])).toBe(EQ_MAX_DB);
  const presets = [...source.matchAll(/Preset\(name: "([^"]+)", gains: (\[[^\]]+\])\)/g)]
    .map(([, name, gains]) => ({ name, gains: JSON.parse(gains) }));
  expect(presets).toEqual(BUILTIN_PRESETS);
});
