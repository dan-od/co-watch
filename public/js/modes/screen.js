// Screen share (Mode A).
// Symmetric: either side may share, one at a time. Clicking Share claims the
// baton from the server; capture starts only on share-granted (handled in
// signaling). Owns the local capture stream and the remote-screen stream id.

import { $, tryPlay } from '../lib/dom.js';

const SCREEN_MAX_BITRATE = 2_500_000; // bps for the shared-screen video sender (Phase 4a) — adjust here
const SCREEN_CONSTRAINTS = {
  // Cap capture at 1080p30 (Phase 4a). selfBrowserSurface:'exclude' keeps the
  // CoWatch tab out of the picker (no hall-of-mirrors, and the Document PiP
  // companion stays out of a tab/window share). preferCurrentTab:false nudges
  // toward sharing another tab. audio:true adds the "share audio" checkbox.
  video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 30 } },
  audio: true,
  selfBrowserSurface: 'exclude',
  preferCurrentTab: false,
};

export function createScreen(ctx) {
  let screenStream = null;
  let screenSenders = [];
  let remoteScreenStreamId = null;

  const { signal } = ctx.signaling;
  const notice = (text, kind, ms) => ctx.controls.notice(text, kind, ms);

  function updateShareButton() {
    const btn = $('share-screen');
    if (screenStream) {
      btn.disabled = false;
      btn.textContent = 'Stop sharing';
      btn.title = '';
    } else if (ctx.signaling.getShareBaton() === 'peer') {
      btn.disabled = true;
      btn.textContent = 'Partner is sharing';
      btn.title = 'Only one person can share at a time';
    } else {
      btn.disabled = !ctx.signaling.isPeerPresent();
      btn.textContent = 'Share a tab';
      btn.title = ctx.signaling.isPeerPresent() ? '' : 'Available once your friend joins';
    }
  }

  $('share-screen').addEventListener('click', () => {
    if (screenStream) {
      stopScreenShare();
      return;
    }
    if (ctx.signaling.getShareBaton() === 'peer' || !ctx.signaling.isPeerPresent()) return;
    signal({ type: 'share-claim' }); // reply arrives as share-granted / share-denied
  });

  async function startScreenShare() {
    const pc = ctx.media.getPc();
    if (!pc || screenStream) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(SCREEN_CONSTRAINTS);
    } catch (err) {
      if (err.name !== 'NotAllowedError')
        notice(`Could not start screen share: ${err.message || err.name}`, 'error', 6000);
      return;
    }
    screenStream = stream;
    const videoTrack = stream.getVideoTracks()[0];
    videoTrack.contentHint = 'motion';
    signal({ type: 'screen-share', on: true, streamId: stream.id });
    for (const track of stream.getTracks()) {
      const sender = pc.addTrack(track, stream);
      screenSenders.push(sender);
      if (track.kind === 'video') capSenderBitrate(sender, SCREEN_MAX_BITRATE);
    }
    videoTrack.addEventListener('ended', stopScreenShare);
    showScreen(stream, true);
    showShareInfo(videoTrack);
    updateShareButton();
  }

  async function capSenderBitrate(sender, bps) {
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0].maxBitrate = bps;
      await sender.setParameters(params);
    } catch (err) {
      console.warn('could not cap screen bitrate:', err);
    }
  }

  function showShareInfo(track) {
    const s = track.getSettings ? track.getSettings() : {};
    const names = { browser: 'a browser tab', window: 'an app window', monitor: 'your whole screen' };
    let text = `Sharing ${names[s.displaySurface] || 'your screen'}`;
    if (s.width && s.height) text += ` at ${s.width}×${s.height}`;
    text += '.';
    if (s.displaySurface === 'monitor')
      text += ' Heads-up: a whole-screen share includes the popped-out partner cam. Share a tab to keep it private.';
    notice(text, s.displaySurface === 'monitor' ? 'warn' : 'ok', s.displaySurface === 'monitor' ? 0 : 4000);
  }

  function stopScreenShare() {
    if (!screenStream) return;
    signal({ type: 'screen-share', on: false });
    const pc = ctx.media.getPc();
    if (pc) {
      for (const sender of screenSenders) {
        try {
          pc.removeTrack(sender);
        } catch {}
      }
    }
    screenSenders = [];
    for (const track of screenStream.getTracks()) track.stop();
    screenStream = null;
    if (ctx.signaling.getShareBaton() === 'mine') {
      ctx.signaling.setShareBaton('free');
      signal({ type: 'share-release' });
    }
    clearScreen();
    updateShareButton();
  }

  function showScreen(stream, mine) {
    const sv = $('screen-video');
    sv.muted = mine;
    sv.srcObject = stream;
    sv.hidden = false;
    $('share-placeholder').hidden = true;
    tryPlay(sv);
  }

  function clearScreen() {
    const sv = $('screen-video');
    sv.srcObject = null;
    sv.hidden = true;
    $('share-placeholder').hidden = false;
  }

  return {
    isSharing: () => !!screenStream,
    getRemoteScreenStreamId: () => remoteScreenStreamId,
    setRemoteScreenStreamId: (id) => (remoteScreenStreamId = id),
    startScreenShare,
    stopScreenShare,
    showScreen,
    clearScreen,
    updateShareButton,
    dispose: () => screenStream?.getTracks().forEach((t) => t.stop()),
  };
}
