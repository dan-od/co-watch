// Tiny DOM helpers shared across modules.

export const $ = (id) => document.getElementById(id);

// Show a video element, revealing the "click to start" affordance if the
// browser blocks autoplay. Shared by media (remote cam), screen, and the
// stage controls (swap / pop-out / tap-to-play).
export async function tryPlay(video) {
  try {
    await video.play();
    $('tap-to-play').hidden = true;
  } catch {
    $('tap-to-play').hidden = false;
  }
}

// The sync-mode loading spinner (shared by sync-mode loads and TMDb search).
export const spinner = (on) => ($('sync-spinner').hidden = !on);
