import { beforeEach, expect, it, vi } from 'vitest';
import { Children, createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const h = vi.hoisted(() => ({ phone: true, nativeShell: true, enable: vi.fn() }));
vi.mock('../src/store/app.ts', () => ({ get phone() { return h.phone; }, useApp: (select: any) => select({ playlists: [] }) }));
vi.mock('../src/lib/desktop.ts', () => ({ desktop: null }));
vi.mock('../src/lib/native-ui.ts', () => ({ enableNativeUi: () => h.enable() }));
vi.mock('../src/lib/playback-trace.ts', () => ({ nativePlaybackControls: () => h.nativeShell ? { uiState: vi.fn() } : undefined }));
vi.mock('../src/lib/splash.ts', () => ({ setSplashEnabled: vi.fn(), splashEnabled: () => true }));
vi.mock('../src/lib/api.ts', () => ({ api: {} }));
vi.mock('../src/components/common.tsx', () => ({ ConfirmModal: () => null, Switch: () => null }));
vi.mock('../src/components/TransitionSummary.tsx', () => ({ TransitionSummary: () => null }));
vi.mock('../src/components/PlaylistBackup.tsx', () => ({ PlaylistBackup: () => null }));
vi.mock('../src/components/AppUpdates.tsx', () => ({ AppUpdates: () => null }));
vi.mock('../src/components/DiskManagement.tsx', () => ({ DiskManagement: () => null }));
import { MorePage } from '../src/pages/Settings.tsx';

beforeEach(() => { h.phone = true; h.nativeShell = true; h.enable.mockClear(); });

it('renders an actionable way back to Swift even when More was already mounted before the shell was disabled', () => {
  const html = renderToStaticMarkup(createElement(MorePage));
  expect(html).toContain('Включить нативный интерфейс');
  expect(html).toContain('#/settings');
  const page = MorePage();
  const button = Children.toArray(page.props.children).find(child => isValidElement(child) && child.type === 'button');
  expect(button).toBeDefined();
  if (!isValidElement<{ onClick: () => void }>(button)) throw Error('Recovery button missing');
  button.props.onClick();
  expect(h.enable).toHaveBeenCalledOnce();
});

it('keeps the desktop and browser More page unchanged', () => {
  h.phone = false;
  expect(renderToStaticMarkup(createElement(MorePage))).not.toContain('Включить нативный интерфейс');
  h.phone = true; h.nativeShell = false;
  expect(renderToStaticMarkup(createElement(MorePage))).not.toContain('Включить нативный интерфейс');
});
