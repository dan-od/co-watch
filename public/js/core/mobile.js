// Mobile robustness (Part 4).
// - Screen Wake Lock while in a room (re-acquired on foreground; the OS
//   auto-releases it when the page hides) so the phone doesn't sleep mid-movie.
// - On backgrounding (mobile only): pause OUTGOING camera video, keep audio;
//   restore the camera's previous state on foreground. Desktop tab-switchers
//   are exempt — freezing the cam on every alt-tab would be hostile.
// - Fullscreen fallback on the first tap (mobile browser, not installed):
//   reclaims the URL bar on Android; iOS Safari is limited — the PWA install
//   is the real fix there, hence the one-time Add-to-Home-Screen hint.

import { isMobile, isStandalone } from '../lib/env.js';

export function createMobileGuards(ctx) {
  let sentinel = null;
  let camWasEnabled = null; // remembered across a backgrounding, null = not backgrounded

  async function acquireWakeLock() {
    try {
      sentinel = (await navigator.wakeLock?.request?.('screen')) ?? null;
    } catch {
      sentinel = null; // denied (battery saver etc.) — cosmetic, carry on
    }
  }
  acquireWakeLock();

  document.addEventListener('visibilitychange', () => {
    const camTrack = () => ctx.media.getLocalStream()?.getVideoTracks()[0];
    if (document.visibilityState === 'visible') {
      acquireWakeLock(); // auto-released on hide; take it back
      if (isMobile() && camWasEnabled !== null) {
        const t = camTrack();
        if (t) t.enabled = camWasEnabled;
        camWasEnabled = null;
        ctx.controls.syncToggleButtons();
      }
    } else if (isMobile()) {
      const t = camTrack();
      if (t) {
        camWasEnabled = t.enabled;
        t.enabled = false; // video pauses; audio keeps flowing
      }
    }
  });

  if (isMobile() && !isStandalone()) {
    // Fullscreen needs a user gesture — hook the first tap in the room.
    const once = () => {
      document.removeEventListener('pointerdown', once);
      document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })?.catch?.(() => {});
    };
    document.addEventListener('pointerdown', once);

    if (!localStorage.getItem('a2hs_hinted')) {
      localStorage.setItem('a2hs_hinted', '1');
      setTimeout(
        () => ctx.controls.notice('Tip: Add to Home Screen for true fullscreen (no browser bar).', '', 7000),
        3000
      );
    }
  }

  return {
    dispose: () => {
      try {
        sentinel?.release();
      } catch {}
      sentinel = null;
    },
  };
}
