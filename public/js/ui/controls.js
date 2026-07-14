// Shared UI: status/notice, mode tabs, the mic/cam/chat/leave cluster, the
// grid↔theater stage layout, copy-link, and autoplay recovery. Owns the
// current mode ('screen' | 'sync').
//
// Layout rule: the camera grid fills the stage until there's content — a live
// share (either direction) or sync mode — then the stage flips to "theater":
// content large, cameras shrink to a bottom strip. Pure CSS via .theater.

import { $, tryPlay } from '../lib/dom.js';

export function createControls(ctx) {
  let mode = 'screen'; // 'screen' | 'sync'
  let noticeTimer = null;
  let lastMicSent = null; // broadcast mic-state only on change

  $('copy-link').addEventListener('click', async () => {
    await navigator.clipboard.writeText(location.href);
    $('copy-link').textContent = 'Copied';
    setTimeout(() => ($('copy-link').textContent = 'Copy'), 1500);
  });

  // ---- Status (top bar) + notice (stage overlay) ----
  const setStatus = (text, kind = '') => {
    $('status').textContent = text;
    $('status-dot').className = kind;
  };
  const notice = (text, kind = '', autoHideMs = 0) => {
    clearTimeout(noticeTimer);
    if (!text) {
      $('notice').hidden = true;
      return;
    }
    $('notice').textContent = text;
    $('notice').className = `notice ${kind}`;
    $('notice').hidden = false;
    if (autoHideMs) noticeTimer = setTimeout(() => ($('notice').hidden = true), autoHideMs);
  };

  // ---- Stage layout: camera grid vs theater ----
  function updateLayout() {
    const theater = mode === 'sync' || !$('screen-video').hidden;
    $('stage-main').classList.toggle('theater', theater);
  }

  // ---- Mode toggle ----
  function setMode(m) {
    if (mode === m) return;
    if (m !== 'screen' && ctx.screen.isSharing()) ctx.screen.stopScreenShare();
    if (m !== 'sync' && ctx.syncCore.getPlayer()) {
      try {
        ctx.syncCore.getPlayer().pause();
      } catch {}
    }
    mode = m;
    $('mode-screen').classList.toggle('active', m === 'screen');
    $('mode-sync').classList.toggle('active', m === 'sync');
    $('screen-pane').hidden = m !== 'screen';
    $('sync-pane').hidden = m !== 'sync';
    $('action-share').hidden = m !== 'screen';
    $('action-sync').hidden = m !== 'sync';
    updateLayout();
    if (ctx.signaling.isPeerPresent()) setStatus(m === 'sync' ? 'Synced' : 'Connected', 'ok');
  }

  $('mode-screen').addEventListener('click', () => setMode('screen'));
  $('mode-sync').addEventListener('click', () => setMode('sync'));

  // ---- Control cluster: mic / cam / chat / leave ----
  function getMicMuted() {
    const audio = ctx.media.getLocalStream()?.getAudioTracks()[0];
    return audio ? !audio.enabled : false;
  }

  function syncToggleButtons() {
    const localStream = ctx.media.getLocalStream();
    const audio = localStream?.getAudioTracks()[0];
    const video = localStream?.getVideoTracks()[0];
    $('toggle-mic').classList.toggle('off', audio ? !audio.enabled : false);
    $('toggle-mic').title = audio && !audio.enabled ? 'Unmute microphone' : 'Mute microphone';
    $('toggle-cam').classList.toggle('off', video ? !video.enabled : false);
    $('toggle-cam').title = video && !video.enabled ? 'Turn camera on' : 'Turn camera off';
    // Mirror our mute onto our own tile and tell the room (icon on their side).
    const muted = getMicMuted();
    ctx.tiles.setMuted('self', muted);
    if (muted !== lastMicSent) {
      lastMicSent = muted;
      ctx.signaling.signal({ type: 'mic-state', muted });
    }
  }

  $('toggle-mic').addEventListener('click', () => {
    const t = ctx.media.getLocalStream()?.getAudioTracks()[0];
    if (t) t.enabled = !t.enabled;
    syncToggleButtons();
  });
  $('toggle-cam').addEventListener('click', () => {
    const t = ctx.media.getLocalStream()?.getVideoTracks()[0];
    if (t) t.enabled = !t.enabled;
    syncToggleButtons();
  });

  $('toggle-chat').addEventListener('click', () => {
    const collapsed = $('chat-rail').classList.toggle('collapsed');
    $('toggle-chat').classList.toggle('active', !collapsed);
    $('toggle-chat').title = collapsed ? 'Show chat' : 'Hide chat';
  });
  $('leave').addEventListener('click', () => {
    try {
      ctx.signaling.dispose(); // stop the auto-reconnect loop + close the socket
      ctx.netstats.dispose();
      ctx.pip.close();
      ctx.media.dispose();
      ctx.screen.dispose();
      ctx.tiles.dispose();
    } finally {
      location.href = '/';
    }
  });

  // ---- Autoplay recovery ----
  $('tap-to-play').addEventListener('click', () => {
    ctx.tiles.playAll();
    if (!$('screen-video').hidden) tryPlay($('screen-video'));
    const player = ctx.syncCore.getPlayer();
    if (player?.el) tryPlay(player.el);
  });

  return {
    setStatus,
    notice,
    getMode: () => mode,
    setMode,
    updateLayout,
    getMicMuted,
    syncToggleButtons,
  };
}
