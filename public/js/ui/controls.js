// Shared UI: status/notice, mode tabs, the mic/cam/self/chat/leave cluster,
// stage swap-view, copy-link, and autoplay recovery. Owns the current mode
// ('screen' | 'sync') and the swapped-stage flag.

import { $, tryPlay } from '../lib/dom.js';

export function createControls(ctx) {
  const elRemote = ctx.els.remote;
  let mode = 'screen'; // 'screen' | 'sync'
  let swapped = false;
  let noticeTimer = null;

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
    if (ctx.signaling.isPeerPresent()) setStatus(m === 'sync' ? 'Synced' : 'Connected', 'ok');
  }

  $('mode-screen').addEventListener('click', () => setMode('screen'));
  $('mode-sync').addEventListener('click', () => setMode('sync'));

  // ---- Control cluster: mic / cam / chat / leave ----
  function syncToggleButtons() {
    const localStream = ctx.media.getLocalStream();
    const audio = localStream?.getAudioTracks()[0];
    const video = localStream?.getVideoTracks()[0];
    $('toggle-mic').classList.toggle('off', audio ? !audio.enabled : false);
    $('toggle-mic').title = audio && !audio.enabled ? 'Unmute microphone' : 'Mute microphone';
    $('toggle-cam').classList.toggle('off', video ? !video.enabled : false);
    $('toggle-cam').title = video && !video.enabled ? 'Turn camera on' : 'Turn camera off';
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
  // Hide/show the self-view thumbnail (partner tile always stays).
  $('toggle-self').addEventListener('click', () => {
    const hidden = $('cam-tiles').classList.toggle('self-hidden');
    $('toggle-self').textContent = hidden ? 'Self' : '×';
    $('toggle-self').title = hidden ? 'Show self-view' : 'Hide self-view';
    $('toggle-self').setAttribute('aria-label', $('toggle-self').title);
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
    } finally {
      location.href = '/';
    }
  });

  // ---- Swap view (Phase 6a) ----
  // Local-only: each person picks what fills their own stage. Promotes the
  // partner's camera to the main pane; the content pane shrinks to a corner
  // tile (pure CSS via .swapped — the panes keep working untouched).
  function setSwapped(on) {
    if (swapped === on) return;
    if (on && ctx.pip.getPipWindow()) return; // partner cam currently lives in the pop-out
    swapped = on;
    $('stage-main').classList.toggle('swapped', on);
    if (on) {
      elRemote.classList.add('main-cam');
      $('stage-main').append(elRemote);
      $('stage-label').textContent = "Showing: partner's camera — click to show shared content";
      $('stage-label').hidden = false;
    } else {
      elRemote.classList.remove('main-cam');
      $('partner-wrap').prepend(elRemote);
      $('stage-label').hidden = true;
    }
    tryPlay(elRemote);
  }

  $('swap-view').addEventListener('click', () => setSwapped(true));
  $('stage-label').addEventListener('click', () => setSwapped(false));

  // ---- Autoplay recovery ----
  $('tap-to-play').addEventListener('click', () => {
    tryPlay(elRemote);
    if (!$('screen-video').hidden) tryPlay($('screen-video'));
    const player = ctx.syncCore.getPlayer();
    if (player?.el) tryPlay(player.el);
  });

  return {
    setStatus,
    notice,
    getMode: () => mode,
    setMode,
    syncToggleButtons,
    setSwapped,
  };
}
