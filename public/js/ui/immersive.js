// Immersive mode (Part 4): while content is playing (theater = live share or
// sync mode), all chrome — top bar, bottom control bar (incl. the "<name> is
// sharing" baton pill and reactions), camera overlays — hides as ONE group
// with a 200ms fade, and returns the same way.
//
// - Tap on the video/empty stage toggles chrome. Taps on actual controls
//   (buttons, tiles, chips, panels, chat) do their job and only reset the
//   auto-hide timer — a control is never made un-pressable.
// - Auto-hide after ~4s of no interaction while watching; any tap or mouse
//   move brings chrome back and re-arms the timer (desktop is idle-driven,
//   mobile is tap-driven — same state machine).
// - Hangout mode (no content) never hides chrome — nothing to immerse into.
// - Incoming chat briefly surfaces as a small peek bubble while chrome is
//   hidden (~3s), so banter isn't missed; reactions float on their own
//   always-visible layer already.

import { $ } from '../lib/dom.js';

const HIDE_AFTER_MS = 4000;
const PEEK_MS = 3000;

export function createImmersive(ctx) {
  let hidden = false;
  let hideTimer = null;
  let peekTimer = null;

  const isWatching = () => $('stage-main').classList.contains('theater');

  // Chat peek bubble (lives on the stage, outside the chrome group).
  const peekEl = document.createElement('p');
  peekEl.id = 'chat-peek';
  peekEl.hidden = true;
  $('stage-main').append(peekEl);

  function setHidden(on) {
    if (hidden === on) return;
    hidden = on;
    $('room').classList.toggle('chrome-hidden', on);
  }

  function arm() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (isWatching()) setHidden(true);
    }, HIDE_AFTER_MS);
  }

  function show() {
    setHidden(false);
    arm();
  }

  // Layout changed (mode switch, share started/stopped): leaving theater
  // always restores chrome; entering it starts the idle countdown.
  function onLayoutChange() {
    if (isWatching()) {
      arm();
    } else {
      clearTimeout(hideTimer);
      setHidden(false);
    }
  }

  const isControl = (el) =>
    !!el?.closest?.(
      'button, input, select, a, label, .tile, .chip, #chat-rail, #controlbar, #topbar, ' +
        '#tracks-panel, #settings-panel, #search-panel, #torlink-panel, #chat-peek'
    );

  // Tap on the stage: empty stage/video toggles; controls only reset the timer.
  $('stage-main').addEventListener('click', (e) => {
    if (!isWatching()) return;
    if (isControl(e.target)) {
      arm();
      return;
    }
    if (hidden) show();
    else setHidden(true);
  });

  // Desktop: mouse movement shows chrome and re-arms the idle timer.
  let lastMove = 0;
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const now = Date.now();
    if (now - lastMove < 250) return; // throttle
    lastMove = now;
    if (isWatching() && hidden) show();
    else if (isWatching()) arm();
  });

  // Any interaction anywhere (typing in chat, pressing controls) re-arms.
  window.addEventListener('pointerdown', () => {
    if (!hidden) arm();
  }, true);

  // Incoming chat while chrome is hidden → 3s peek bubble.
  function notifyChat(name, text) {
    if (!hidden) return;
    peekEl.textContent = `${name}: ${text}`;
    peekEl.hidden = false;
    peekEl.classList.add('show');
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => {
      peekEl.classList.remove('show');
      peekEl.hidden = true;
    }, PEEK_MS);
  }

  return { show, onLayoutChange, notifyChat };
}
