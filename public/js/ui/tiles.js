// Participant tile grid (mesh Part 2, mobile paging Part 4). One tile per
// person — self included — with a name label, a red mic-off icon, a weak-
// connection dot, and an amber "speaking" ring driven by Web Audio levels.
//
// Desktop: the full grid, everyone visible (fills the stage; theater shrinks
// it to a bottom strip — CSS via #stage-main.theater, see controls.updateLayout).
//
// Mobile (pointer:coarse): active-speaker paging. At most MAX_BIG large tiles;
// everyone else collapses to small name chips (speaking-glow + mic/weak
// indicators). A chip speaking SUSTAINED for PROMOTE_MS swaps into a big slot
// (the longest-silent unpinned big tile demotes) — the debounce keeps banter
// from causing flicker. Tap a chip to promote & PIN; tap a big tile to toggle
// its pin; pinned tiles never get swapped out. Self stays a small corner
// thumbnail and never competes for a big slot.

import { $, tryPlay } from '../lib/dom.js';
import { isMobile } from '../lib/env.js';

const MIC_OFF_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">' +
  '<path d="M1 1l22 22M9 9v3a3 3 0 0 0 5 2.2M15 9V6a3 3 0 0 0-6-1M5 10v1a7 7 0 0 0 11 5.7M19 10v1a7 7 0 0 1-.6 2.8M12 18v4"/></svg>';

const SPEAKING_THRESHOLD = 0.045; // RMS deviation; tuned for typical mic levels
const LEVEL_POLL_MS = 200;
const MAX_BIG = 2; // mobile: large tiles at once
const PROMOTE_MS = 1600; // sustained speaking before a swap (anti-flicker)

export function createTiles(ctx) {
  const grid = $('cam-grid');
  const chipsEl = $('cam-chips');
  const mobile = isMobile();
  const tiles = new Map(); // key: peerId | 'self' → tile record
  let audioCtx = null;
  let levelTimer = null;

  // Mobile paging state.
  let bigIds = []; // remote ids currently in big slots
  const pinnedIds = new Set();

  // "+N" chip: in landscape-watching the chip strip hides behind this toggle.
  let moreBtn = null;
  if (mobile) {
    moreBtn = document.createElement('button');
    moreBtn.id = 'chips-toggle';
    moreBtn.hidden = true;
    moreBtn.addEventListener('click', () => chipsEl.classList.toggle('open'));
    grid.after(moreBtn);
  }

  // Web Audio needs a user gesture on some browsers; resume opportunistically.
  document.addEventListener('click', () => audioCtx?.resume?.().catch(() => {}), { capture: true });

  function ensureTile(key, name) {
    let t = tiles.get(key);
    if (t) {
      if (name) setName(key, name);
      return t;
    }
    const root = document.createElement('div');
    root.className = 'tile';
    root.dataset.peer = key;
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    if (key === 'self') {
      video.muted = true; // never monitor our own mic
      root.classList.add('self');
    }
    const nameEl = document.createElement('span');
    nameEl.className = 'tile-name';
    nameEl.textContent = key === 'self' ? `${name || 'You'} (you)` : name || '…';
    const micEl = document.createElement('span');
    micEl.className = 'tile-mic';
    micEl.innerHTML = MIC_OFF_SVG; // static trusted markup
    micEl.hidden = true;
    const weakEl = document.createElement('span');
    weakEl.className = 'tile-weak';
    weakEl.title = 'Weak connection';
    weakEl.hidden = true;
    // Per-person volume: adjusts THIS video element's loudness, locally only
    // (nothing is sent to the room). Self has no slider — it's muted.
    let volEl = null;
    if (key !== 'self') {
      volEl = document.createElement('input');
      volEl.type = 'range';
      volEl.className = 'tile-vol';
      volEl.min = '0';
      volEl.max = '1';
      volEl.step = '0.05';
      volEl.value = '1';
      volEl.title = 'Volume';
      volEl.setAttribute?.('aria-label', `Volume: ${name || 'participant'}`);
      const stop = (e) => e.stopPropagation(); // dragging must not pin/toggle the tile
      volEl.addEventListener('pointerdown', stop);
      volEl.addEventListener('click', stop);
      volEl.addEventListener('input', () => {
        t.vol = Number(volEl.value);
        t.video.volume = t.vol;
      });
    }
    root.append(video, nameEl, micEl, weakEl);
    if (volEl) root.append(volEl);
    grid.append(root);

    // Chip twin (mobile): name pill with the same indicators.
    let chip = null;
    if (mobile && key !== 'self') {
      chip = document.createElement('button');
      chip.className = 'chip';
      chip.dataset.peer = key;
      const chipName = document.createElement('span');
      chipName.className = 'chip-name';
      chipName.textContent = name || '…';
      const chipMic = document.createElement('span');
      chipMic.className = 'tile-mic';
      chipMic.innerHTML = MIC_OFF_SVG;
      chipMic.hidden = true;
      const chipWeak = document.createElement('span');
      chipWeak.className = 'tile-weak';
      chipWeak.hidden = true;
      chip.append(chipName, chipMic, chipWeak);
      chip.addEventListener('click', () => promoteAndPin(key));
      chipsEl.append(chip);
      root.addEventListener('click', () => togglePin(key)); // tap big tile → pin
    }

    t = {
      root, video, nameEl, micEl, weakEl, volEl, chip,
      vol: 1,
      stream: null, source: null, analyser: null, data: null,
      lastSpokeAt: 0, speakStart: 0,
    };
    tiles.set(key, t);
    if (mobile && key !== 'self' && bigIds.length < MAX_BIG) bigIds.push(key);
    applySlots();
    return t;
  }

  function setStream(key, stream) {
    const t = ensureTile(key);
    if (t.stream === stream) return;
    t.stream = stream;
    t.video.srcObject = stream;
    t.video.volume = t.vol ?? 1; // reapply the chosen volume to the new stream (e.g. after reconnect)
    tryPlay(t.video);
    attachAnalyser(t, stream);
  }

  function setName(key, name) {
    const t = tiles.get(key);
    if (!t || !name) return;
    t.nameEl.textContent = key === 'self' ? `${name} (you)` : name;
    if (t.chip) t.chip.querySelector('.chip-name').textContent = name;
  }

  function setMuted(key, muted) {
    const t = tiles.get(key);
    if (!t) return;
    t.micEl.hidden = !muted;
    t.root.classList.toggle('muted', muted);
    if (t.chip) {
      t.chip.querySelector('.tile-mic').hidden = !muted;
      t.chip.classList.toggle('muted', muted);
    }
    if (muted) {
      t.root.classList.remove('speaking'); // a muted mic can't be speaking
      t.chip?.classList.remove('speaking');
    }
  }

  // Weak-connection dot (driven by netstats: outbound quality-limitation).
  function setWeak(key, weak) {
    const t = tiles.get(key);
    if (!t) return;
    t.weakEl.hidden = !weak;
    t.root.classList.toggle('weak', weak);
    if (t.chip) t.chip.querySelector('.tile-weak').hidden = !weak;
  }

  function removeTile(key) {
    const t = tiles.get(key);
    if (!t) return;
    try {
      t.source?.disconnect();
    } catch {}
    t.root.remove();
    t.chip?.remove();
    tiles.delete(key);
    pinnedIds.delete(key);
    const slot = bigIds.indexOf(key);
    if (slot !== -1) {
      bigIds.splice(slot, 1);
      // Refill from the most recently active chip.
      const candidates = remoteIds().filter((id) => !bigIds.includes(id));
      candidates.sort((a, b) => (tiles.get(b).lastSpokeAt || 0) - (tiles.get(a).lastSpokeAt || 0));
      if (candidates.length) bigIds.push(candidates[0]);
    }
    applySlots();
  }

  const remoteIds = () => [...tiles.keys()].filter((k) => k !== 'self');

  // ---- Mobile paging ----
  function applySlots() {
    if (!mobile) {
      grid.dataset.count = String(tiles.size);
      ctx.controls.updateLayout();
      return;
    }
    for (const id of remoteIds()) {
      const t = tiles.get(id);
      const inBig = bigIds.includes(id);
      t.root.hidden = !inBig; // display:none — its <video> keeps playing audio
      t.root.classList.toggle('pinned', pinnedIds.has(id));
      if (t.chip) t.chip.hidden = inBig;
    }
    const chipCount = remoteIds().length - bigIds.length;
    if (moreBtn) {
      moreBtn.textContent = `+${chipCount}`;
      moreBtn.hidden = chipCount <= 0;
      if (chipCount <= 0) chipsEl.classList.remove('open');
    }
    chipsEl.hidden = remoteIds().length - bigIds.length <= 0;
    grid.dataset.count = String(bigIds.length + 1); // big tiles + self thumb
    ctx.controls.updateLayout();
  }

  function promote(id) {
    if (bigIds.includes(id)) return;
    if (bigIds.length < MAX_BIG) {
      bigIds.push(id);
    } else {
      // Demote the longest-silent unpinned big tile.
      const demotable = bigIds.filter((b) => !pinnedIds.has(b));
      if (!demotable.length) return; // everything pinned — no swaps
      demotable.sort((a, b) => (tiles.get(a).lastSpokeAt || 0) - (tiles.get(b).lastSpokeAt || 0));
      bigIds[bigIds.indexOf(demotable[0])] = id;
    }
    applySlots();
  }

  function promoteAndPin(id) {
    if (!bigIds.includes(id)) {
      if (bigIds.length >= MAX_BIG && bigIds.every((b) => pinnedIds.has(b))) {
        // All slots pinned: the oldest pin gives way to the explicit tap.
        const oldest = [...bigIds].sort(
          (a, b) => (tiles.get(a).lastSpokeAt || 0) - (tiles.get(b).lastSpokeAt || 0)
        )[0];
        pinnedIds.delete(oldest);
      }
      promote(id);
    }
    pinnedIds.add(id);
    applySlots();
  }

  function togglePin(id) {
    if (!bigIds.includes(id)) return;
    if (pinnedIds.has(id)) pinnedIds.delete(id);
    else pinnedIds.add(id);
    applySlots();
  }

  // ---- Active-speaker detection (amber ring + paging) ----
  function attachAnalyser(t, stream) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !stream?.getAudioTracks?.().length) return;
    try {
      audioCtx = audioCtx || new AC();
      try {
        t.source?.disconnect();
      } catch {}
      t.source = audioCtx.createMediaStreamSource(stream);
      t.analyser = audioCtx.createAnalyser();
      t.analyser.fftSize = 256;
      t.data = new Uint8Array(t.analyser.fftSize);
      t.source.connect(t.analyser); // analyser only — nothing routes to speakers
      if (!levelTimer) levelTimer = setInterval(pollLevels, LEVEL_POLL_MS);
    } catch {
      // no ring for this stream — cosmetic only
    }
  }

  function pollLevels() {
    const now = Date.now();
    for (const [key, t] of tiles) {
      if (!t.analyser || t.root.classList.contains('muted')) continue;
      t.analyser.getByteTimeDomainData(t.data);
      let sum = 0;
      for (let i = 0; i < t.data.length; i++) {
        const d = (t.data[i] - 128) / 128;
        sum += d * d;
      }
      const speaking = Math.sqrt(sum / t.data.length) > SPEAKING_THRESHOLD;
      t.root.classList.toggle('speaking', speaking);
      t.chip?.classList.toggle('speaking', speaking);
      if (speaking) {
        t.lastSpokeAt = now;
        if (!t.speakStart) t.speakStart = now;
      } else {
        t.speakStart = 0;
      }
      // Debounced promotion: sustained speech from a chip earns a big slot.
      if (mobile && key !== 'self' && !bigIds.includes(key) && t.speakStart && now - t.speakStart >= PROMOTE_MS) {
        promote(key);
      }
    }
  }

  return {
    ensureTile,
    setStream,
    setSelfStream: (stream) => setStream('self', stream),
    setName,
    setMuted,
    setWeak,
    removeTile,
    getGridEl: () => grid, // the PiP companion relocates the whole grid
    playAll: () => {
      for (const t of tiles.values()) if (t.stream) tryPlay(t.video);
    },
    dispose: () => {
      clearInterval(levelTimer);
      levelTimer = null;
      audioCtx?.close?.().catch(() => {});
    },
  };
}
