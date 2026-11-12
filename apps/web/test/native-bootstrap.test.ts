import { afterEach, expect, it, vi } from 'vitest';

const bootstrap = vi.hoisted(() => ({ start: vi.fn(), render: vi.fn(), controller: {}, root: {} }));
vi.mock('../src/lib/native-ui.ts', () => ({ startNativeUi: bootstrap.start }));
vi.mock('react-dom/client', () => ({ createRoot: (root: unknown) => {
  expect(root).toBe(bootstrap.root);
  return { render: bootstrap.render };
} }));
vi.mock('../src/App.tsx', () => ({ App: () => null }));
vi.mock('../src/store/app.ts', () => ({ controller: bootstrap.controller, trackOf: vi.fn(), useApp: {} }));
vi.mock('../src/lib/desktop.ts', () => ({ desktop: null }));
vi.mock('../src/lib/splash.ts', () => ({ playSplash: vi.fn(), splashEnabled: vi.fn(() => false) }));

afterEach(() => { vi.unstubAllGlobals(); });

it('starts the native shell from the production entry before React renders', async () => {
  const page = {};
  vi.stubGlobal('window', page);
  vi.stubGlobal('location', { search: '' });
  vi.stubGlobal('document', { getElementById: () => bootstrap.root });
  await import('../src/main.tsx');
  expect(page).toMatchObject({ automix: bootstrap.controller });
  expect(bootstrap.start).toHaveBeenCalledOnce();
  expect(bootstrap.render).toHaveBeenCalledOnce();
  expect(bootstrap.start.mock.invocationCallOrder[0]).toBeLessThan(bootstrap.render.mock.invocationCallOrder[0]);
});
