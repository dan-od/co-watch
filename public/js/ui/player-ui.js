// Watching view: the custom transport from the mockups — scrub bar with a
// buffered track and peer position marks, play/pause, elapsed/duration, a
// live "in sync / nudging <name>" lock, the "Paused by <name>" plate, and the
// title strip.
//
// NATIVE VIDEO ONLY. YouTube/Vimeo render inside a cross-origin iframe that
// keeps its own chrome and swallows pointer events, so we can't overlay a
// scrubber on them — for those sources the overlay stays hidden and their own
// controls drive (play/pause/seek still sync through the adapter as before).
//
// Peer positions ride a lightweight 'pos' broadcast (~2s while loaded). Each
// peer's last report is extrapolated to "now" so the drift readout stays
// honest between beats.

import { $ } from '../lib/dom.js';

const POS_BROADCAST_MS = 2000;
const UI_TICK_MS = 250;
// Generous: browsers throttle timers hard in BACKGROUND tabs, so a watcher who
// tabs away still beats — just slowly. Dropping them after a few seconds made
// the lock flicker off constantly.
const PEER_STALE_MS = 45000;
const DRIFT_WARN = 0.4; // seconds before the lock turns amber

const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

export function createPlayerUi(ctx) {
  let source = null;
  let isNative = false;
  let tickTimer = null;
  let lastBroadcast = 0;
  let pausedBy = null; // name of whoever last paused, when it wasn't us
  const peers = new Map(); // peerId → { t, paused, at, name }

  const player = () => ctx.syncCore.getPlayer();

  // ---- lifecycle (called by core/sync.js) ----
  function onLoaded(src) {
    source = src || null;
    const p = player();
    isNative = !!p?.el;
    pausedBy = null;
    peers.clear();

    $('player-overlay').hidden = !isNative;
    $('sync-placeholder').hidden = true;
    $('player-frame').hidden = isNative; // native video paints its own black

    const title = src?.title || src?.fileName || src?.name || 'Now playing';
    $('watch-title').textContent = title;
    $('watch-sub').textContent = subtitleFor(src);
    $('watch-title-strip').hidden = false;
    $('paused-title').textContent = title;

    if (isNative) {
      const v = p.el;
      v.controls = false; // our overlay is the transport now
      for (const ev of ['play', 'pause', 'seeked', 'timeupdate', 'durationchange', 'progress']) {
        v.addEventListener(ev, paint);
      }
    }
    paint();
    start();
  }

  function onDestroyed() {
    stop();
    source = null;
    isNative = false;
    peers.clear();
    $('player-overlay').hidden = true;
    $('watch-title-strip').hidden = true;
    $('paused-plate').hidden = true;
    $('sync-placeholder').hidden = false;
    $('player-frame').hidden = false;
    $('syncLock').hidden = true;
    $('peerMark').hidden = true;
  }

  function subtitleFor(src) {
    if (!src) return '';
    const bits = [];
    if (src.kind === 'stremio') bits.push('Stremio');
    else if (src.kind === 'torbox') bits.push('TorBox');
    else if (src.kind === 'youtube') bits.push('YouTube');
    else if (src.kind === 'vimeo') bits.push('Vimeo');
    if (src.name && src.name !== src.title) bits.push(String(src.name).replace(/\s+/g, ' ').trim().slice(0, 60));
    return bits.join(' · ');
  }

  // ---- ticking ----
  function start() {
    stop();
    tickTimer = setInterval(tick, UI_TICK_MS);
  }
  function stop() {
    clearInterval(tickTimer);
    tickTimer = null;
  }

  async function tick() {
    const p = player();
    if (!p) return;
    paint();
    const now = Date.now();
    if (now - lastBroadcast >= POS_BROADCAST_MS) {
      lastBroadcast = now;
      try {
        const t = await p.getTime();
        const paused = await p.isPaused();
        ctx.signaling.signal({ type: 'pos', t: Number(t) || 0, paused: !!paused });
      } catch {
        // adapter not ready — skip this beat
      }
    }
    prunePeers(now);
    paintSync();
  }

  // ---- painting ----
  function paint() {
    if (!isNative) return;
    const v = player()?.el;
    if (!v) return;
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    const pct = dur ? Math.min(100, (v.currentTime / dur) * 100) : 0;
    $('fill').style.width = `${pct}%`;
    $('knob').style.left = `${pct}%`;
    $('cur').textContent = fmt(v.currentTime);
    $('dur').textContent = dur ? fmt(dur) : '—:—';

    // buffered head
    let buffered = 0;
    try {
      if (v.buffered.length) buffered = v.buffered.end(v.buffered.length - 1);
    } catch {}
    $('buf').style.width = dur ? `${Math.min(100, (buffered / dur) * 100)}%` : '0%';

    const paused = v.paused;
    $('playBtn').innerHTML = paused
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';
    $('playBtn').setAttribute('aria-label', paused ? 'Play' : 'Pause');

    // Paused plate: only meaningful once we know a duration (i.e. it loaded).
    $('paused-plate').hidden = !paused;
    if (paused) {
      $('paused-by').textContent = pausedBy ? `Paused by ${pausedBy}` : 'Paused';
      $('paused-at').textContent = `everyone is holding at ${fmt(v.currentTime)}`;
    }
  }

  function prunePeers(now) {
    for (const [id, p] of peers) if (now - p.at > PEER_STALE_MS) peers.delete(id);
  }

  // Extrapolate a peer's last report to now, then show the worst offender.
  function paintSync() {
    const v = isNative ? player()?.el : null;
    if (!v || !peers.size) {
      $('syncLock').hidden = true;
      $('peerMark').hidden = true;
      return;
    }
    const now = Date.now();
    const mine = v.currentTime;
    let worst = null;
    for (const [, p] of peers) {
      const elapsed = p.paused ? 0 : (now - p.at) / 1000;
      const theirs = p.t + elapsed;
      const diff = mine - theirs;
      if (!worst || Math.abs(diff) > Math.abs(worst.diff)) worst = { diff, theirs, name: p.name };
    }
    if (!worst) return;
    const mag = Math.abs(worst.diff);
    const lock = $('syncLock');
    lock.hidden = false;
    lock.classList.toggle('drift', mag > DRIFT_WARN);
    $('syncText').textContent =
      mag > DRIFT_WARN
        ? `${worst.name} is ${worst.diff > 0 ? 'behind' : 'ahead'} · ${mag.toFixed(1)}s`
        : `In sync · ±${mag.toFixed(1)}s`;

    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    if (dur) {
      $('peerMark').hidden = false;
      $('peerMark').style.left = `${Math.max(0, Math.min(100, (worst.theirs / dur) * 100))}%`;
    }
  }

  // ---- inbound signals ----
  function onRemotePos(peerId, msg, name) {
    peers.set(peerId, { t: Number(msg.t) || 0, paused: !!msg.paused, at: Date.now(), name: name || 'Someone' });
  }
  // A peer drove the transport — remember who, for the paused plate.
  function onRemoteSync(msg, name) {
    if (msg.action === 'pause') pausedBy = name || 'Someone';
    else if (msg.action === 'play') pausedBy = null;
    paint();
  }
  function onPeerGone(peerId) {
    peers.delete(peerId);
  }

  // ---- local transport controls ----
  $('playBtn').addEventListener('click', async () => {
    const p = player();
    if (!p) return;
    try {
      const paused = await p.isPaused();
      pausedBy = null; // it's ours now
      if (paused) await p.play();
      else await p.pause();
    } catch {}
    paint();
  });

  $('scrub').addEventListener('click', (e) => {
    const v = isNative ? player()?.el : null;
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    v.currentTime = ratio * v.duration; // 'seeked' reports it to the room
    paint();
  });

  return { onLoaded, onDestroyed, onRemotePos, onRemoteSync, onPeerGone };
}
