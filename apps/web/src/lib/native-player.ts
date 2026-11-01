import type { NativePlaybackControls } from './playback-trace.ts';

/** iPhone native playback: opens the SwiftUI player instead of the web one. false = show the web player now.
 * «Ещё» in the native player, or a native failure, opens the web player afterwards. */
export function presentNativePlayer(controls: NativePlaybackControls | undefined, showWeb: () => void): boolean {
  const present = controls?.mixActive ? controls.presentPlayer : undefined;
  if (!present) return false;
  Promise.resolve().then(present).then(r => { if (r.action === 'more') showWeb(); }, showWeb);
  return true;
}
