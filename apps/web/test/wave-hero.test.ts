import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const h = vi.hoisted(() => ({
  app: { player: { context: null as { type: string } | null, status: 'playing', waveLoading: false, error: null }, order: [] as string[], providers: [] },
  radio: { active: false, loading: false },
}));
vi.mock('../src/store/app.ts', () => ({ controller: {}, trackOf: vi.fn(), useApp: (select: any) => select(h.app) }));
vi.mock('../src/lib/radio.ts', () => ({ startRadio: vi.fn(), useRadio: () => h.radio }));
vi.mock('../src/components/WaveSculpture.tsx', () => ({ WaveSculpture: () => null }));
vi.mock('../src/components/RadioTuning.tsx', () => ({ RadioTuning: () => null }));
vi.mock('../src/components/YandexWaveTuning.tsx', () => ({ YandexWaveTuning: () => null }));
vi.mock('../src/components/ImportActions.tsx', () => ({ ImportActions: () => null }));
vi.mock('../src/components/common.tsx', () => ({ Cover: () => null, Swap: () => null }));
import { WaveHero } from '../src/pages/Home.tsx';

beforeEach(() => {
  h.app.player.context = { type: 'online-radio' };
  h.app.player.status = 'playing';
  h.app.order = ['liked-track'];
  h.radio.active = false;
});

describe('home radio playback control', () => {
  it.each(['playing', 'buffering', 'paused'])('recognizes native online radio while %s without a browser radio session', status => {
    h.app.player.status = status;
    const html = renderToStaticMarkup(createElement(WaveHero));
    expect(html).toContain(status === 'paused' ? 'Продолжить' : 'Пауза');
    expect(html).not.toContain('Включить радио');
    expect(html).toContain('aria-pressed="true" title="Радио YouTube Music без аккаунта"');
  });

  it('offers to start radio when another playback context is active', () => {
    h.app.player.context = { type: 'playlist' };
    h.app.order = [];
    const html = renderToStaticMarkup(createElement(WaveHero));
    expect(html).toContain('Включить радио');
    expect(html).not.toContain('Пауза');
  });
});
