// Shared UI: status/notice, mode tabs, the control-bar clusters, the
// grid↔theater stage layout, copy-link, and autoplay recovery.
//
// Modes (per the approved mockups): three tabs — Share / Sync / Stremio —
// plus a fourth VIEW, 'watch', which the player takes over when something
// loads. The tab of whichever source you came from stays lit while watching,
// and "← Browse" in the control bar walks back to it.
//
// Layout rule: the camera grid fills the stage only while hanging out (Share
// tab, nobody sharing). Everywhere else cameras shrink to the floating strip
// the mockups show — pure CSS via .theater.

import { $, tryPlay } from '../lib/dom.js';

const VIEW_OF = { screen: 'view-share', sync: 'view-sync', stremio: 'view-stremio', watch: 'view-watch' };
const TAB_OF = { screen: 'mode-screen', sync: 'mode-sync', stremio: 'mode-stremio' };

export function createControls(ctx) {
  let mode = null; // 'screen' | 'sync' | 'stremio' | 'watch' — set by init()
  let lastSource = 'stremio'; // which tab stays lit while watching
  let noticeTimer = null;
  let lastMicSent = null; // broadcast mic-state only on change

  $('copy-link').addEventListener('click', async () => {
    // Whatever the field is showing — a URL in the browser, a room code in the
    // desktop app, where the URL points at this machine's own port.
    const text = $('room-link').value || location.href;
    try {
      // In the app, go through the shell: navigator.clipboard needs the
      // document focused and rejects silently when it isn't.
      if (window.__cowatchDesktop?.copy) await window.__cowatchDesktop.copy(text);
      else await navigator.clipboard.writeText(text);
      $('copy-link').textContent = 'Copied';
      setTimeout(() => ($('copy-link').textContent = 'Copy'), 1500);
    } catch {
      $('room-link').select?.();
    }
  });

  // ---- Status (top bar) + notice (stage overlay) ----
  const setStatus = (text, kind = '') => {
    $('status').textContent = text;
    $('status-dot').className = `dot ${kind}`;
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

  // ---- Stage layout: hangout grid vs theater strip ----
  function updateLayout() {
    const theater = mode !== 'screen' || !$('screen-video').hidden;
    $('stage-main').classList.toggle('theater', theater);
    ctx.immersive?.onLayoutChange(); // chrome auto-hide only applies while watching
  }

  // ---- Mode / view switching ----
  function setMode(m) {
    if (!VIEW_OF[m]) return;
    if (mode === m) return;
    if (m !== 'screen' && ctx.screen.isSharing()) ctx.screen.stopScreenShare();
    // Leaving the player entirely (back to a browse/load view) pauses playback
    // so a hidden video doesn't keep running under the UI.
    if (mode === 'watch' && m !== 'watch' && ctx.syncCore.getPlayer()) {
      try {
        ctx.syncCore.getPlayer().pause();
      } catch {}
    }
    mode = m;
    if (m !== 'watch') lastSource = m;

    for (const [key, viewId] of Object.entries(VIEW_OF)) {
      $(viewId).classList.toggle('active', key === m);
    }
    const litTab = TAB_OF[m === 'watch' ? lastSource : m] || TAB_OF.stremio;
    for (const tabId of Object.values(TAB_OF)) {
      $(tabId).setAttribute('aria-selected', String(tabId === litTab));
    }

    // Control-bar left slot follows the view.
    $('action-share').hidden = m !== 'screen';
    $('action-sync').hidden = m !== 'sync';
    $('stremio-chip').hidden = m !== 'stremio';
    $('watch-browse').hidden = m !== 'watch';

    updateLayout();
    if (m === 'stremio') ctx.stremio.activate();
    if (ctx.signaling.isPeerPresent()) {
      setStatus(m === 'watch' ? 'Synced' : 'Connected', 'ok');
    }
  }

  $('mode-screen').addEventListener('click', () => setMode('screen'));
  $('mode-sync').addEventListener('click', () => setMode('sync'));
  $('mode-stremio').addEventListener('click', () => setMode('stremio'));
  $('watch-browse').addEventListener('click', () => setMode(lastSource === 'watch' ? 'stremio' : lastSource));

  // ---- Popover plumbing (mixer / CC / settings all share .pop) ----
  for (const btn of document.querySelectorAll('.pop-close')) {
    btn.addEventListener('click', () => ($(btn.dataset.close).hidden = true));
  }

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

  // Chat is a slide-open rail (mockup): open on roomy screens, closed when tight.
  const chatOpen = () => $('chat-rail').classList.contains('open');
  function setChat(open) {
    $('chat-rail').classList.toggle('open', open);
    $('toggle-chat').classList.toggle('on', open);
    $('toggle-chat').title = open ? 'Hide chat' : 'Show chat';
  }
  setChat(window.innerWidth >= 1100);
  $('toggle-chat').addEventListener('click', () => setChat(!chatOpen()));

  $('leave').addEventListener('click', () => {
    try {
      ctx.signaling.dispose(); // stop the auto-reconnect loop + close the socket
      ctx.netstats.dispose();
      ctx.pip.close();
      ctx.media.dispose();
      ctx.screen.dispose();
      ctx.tiles.dispose();
      ctx.mixer.dispose();
      ctx.mobileGuards?.dispose(); // release the wake lock
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
    $('tap-to-play').hidden = true;
  });

  return {
    setStatus,
    notice,
    getMode: () => mode,
    setMode,
    // Called once from app.js after every module is constructed — setMode
    // reaches into ctx.stremio, so it can't run during construction.
    init: (startMode = 'stremio') => setMode(startMode),
    updateLayout,
    getMicMuted,
    syncToggleButtons,
  };
}
