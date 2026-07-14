// Participant tile grid (mesh Part 2). One tile per person — self included —
// with a name label, a red mic-off icon, and an amber "speaking" ring driven
// by Web Audio levels. The grid fills the stage when nothing is shared and
// shrinks to a bottom strip in theater mode (share live / sync mode); that
// switch is CSS-only via #stage-main.theater (see controls.updateLayout).

import { $, tryPlay } from '../lib/dom.js';

const MIC_OFF_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">' +
  '<path d="M1 1l22 22M9 9v3a3 3 0 0 0 5 2.2M15 9V6a3 3 0 0 0-6-1M5 10v1a7 7 0 0 0 11 5.7M19 10v1a7 7 0 0 1-.6 2.8M12 18v4"/></svg>';

const SPEAKING_THRESHOLD = 0.045; // RMS deviation; tuned for typical mic levels
const LEVEL_POLL_MS = 200;

export function createTiles(ctx) {
  const grid = $('cam-grid');
  const tiles = new Map(); // key: peerId | 'self' → { root, video, nameEl, micEl, stream, source, analyser, data }
  let audioCtx = null;
  let levelTimer = null;

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
    root.append(video, nameEl, micEl, weakEl);
    grid.append(root);
    t = { root, video, nameEl, micEl, weakEl, stream: null, source: null, analyser: null, data: null };
    tiles.set(key, t);
    updateCount();
    return t;
  }

  function setStream(key, stream) {
    const t = ensureTile(key);
    if (t.stream === stream) return;
    t.stream = stream;
    t.video.srcObject = stream;
    tryPlay(t.video);
    attachAnalyser(t, stream);
  }

  function setName(key, name) {
    const t = tiles.get(key);
    if (!t || !name) return;
    t.nameEl.textContent = key === 'self' ? `${name} (you)` : name;
  }

  function setMuted(key, muted) {
    const t = tiles.get(key);
    if (!t) return;
    t.micEl.hidden = !muted;
    t.root.classList.toggle('muted', muted);
    if (muted) t.root.classList.remove('speaking'); // a muted mic can't be speaking
  }

  // Weak-connection dot (driven by netstats: outbound quality-limitation).
  function setWeak(key, weak) {
    const t = tiles.get(key);
    if (!t) return;
    t.weakEl.hidden = !weak;
    t.root.classList.toggle('weak', weak);
  }

  function removeTile(key) {
    const t = tiles.get(key);
    if (!t) return;
    try {
      t.source?.disconnect();
    } catch {}
    t.root.remove();
    tiles.delete(key);
    updateCount();
  }

  function updateCount() {
    grid.dataset.count = String(tiles.size);
    ctx.controls.updateLayout();
  }

  // ---- Active-speaker detection (amber ring) ----
  // One AnalyserNode per stream; every LEVEL_POLL_MS compute the RMS deviation
  // and toggle .speaking. Feature-detected: no AudioContext → no rings.
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
    for (const t of tiles.values()) {
      if (!t.analyser || t.root.classList.contains('muted')) continue;
      t.analyser.getByteTimeDomainData(t.data);
      let sum = 0;
      for (let i = 0; i < t.data.length; i++) {
        const d = (t.data[i] - 128) / 128;
        sum += d * d;
      }
      const rms = Math.sqrt(sum / t.data.length);
      t.root.classList.toggle('speaking', rms > SPEAKING_THRESHOLD);
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
