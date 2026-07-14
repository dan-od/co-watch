// Screen share (Mode A, mesh Part 2).
// Symmetric: anyone can share, one at a time — the server-owned baton
// arbitrates. The capture's tracks are added to EVERY peer connection (and to
// connections created mid-share), tuned so the movie is the main event:
// encoding/network priority 'high' + a generous bitrate, while camera senders
// run 'low' — a congested receiver link starves cameras before the screen,
// and audio (high) is never touched.

import { $, tryPlay } from '../lib/dom.js';
import { tuneSender } from '../core/media.js';

const SCREEN_MAX_BITRATE = 2_500_000; // bps for the shared-screen video sender — adjust here
const SCREEN_CONSTRAINTS = {
  // Cap capture at 1080p30. selfBrowserSurface:'exclude' keeps the CoWatch tab
  // out of the picker (no hall-of-mirrors, and the Document PiP companion
  // stays out of a tab/window share). preferCurrentTab:false nudges toward
  // sharing another tab. audio:true adds the "share audio" checkbox.
  video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 30 } },
  audio: true,
  selfBrowserSurface: 'exclude',
  preferCurrentTab: false,
};

export function createScreen(ctx) {
  let screenStream = null;
  const senders = new Map(); // peerId → RTCRtpSender[] for our screen tracks
  let remoteSharerId = null;
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
      btn.textContent = `${ctx.signaling.getMemberName(ctx.signaling.getShareHolderId())} is sharing`;
      btn.title = 'Only one person can share at a time';
    } else {
      btn.disabled = !ctx.signaling.isPeerPresent();
      btn.textContent = 'Share a tab';
      btn.title = ctx.signaling.isPeerPresent() ? '' : 'Available once someone joins';
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
    if (screenStream) return;
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
    signal({ type: 'screen-share', on: true, streamId: stream.id }); // broadcast
    for (const [peerId, pc] of ctx.media.getPcs()) addScreenTracksTo(peerId, pc);
    videoTrack.addEventListener('ended', stopScreenShare);
    showScreen(stream, true);
    showShareInfo(videoTrack);
    updateShareButton();
  }

  // Attach our live screen capture to one peer connection. Also called by
  // media when a connection is created mid-share (a late joiner).
  function addScreenTracksTo(peerId, pc) {
    if (!screenStream || senders.has(peerId)) return;
    const list = [];
    for (const track of screenStream.getTracks()) {
      const sender = pc.addTrack(track, screenStream);
      list.push(sender);
      // The movie holds quality as long as the link allows; audio priority is
      // already high by default policy in media.addLocalTracks for mics — the
      // share's own audio rides high too.
      tuneSender(
        sender,
        track.kind === 'video'
          ? { maxBitrate: SCREEN_MAX_BITRATE, priority: 'high' }
          : { priority: 'high' }
      );
    }
    senders.set(peerId, list);
  }

  function showShareInfo(track) {
    const s = track.getSettings ? track.getSettings() : {};
    const names = { browser: 'a browser tab', window: 'an app window', monitor: 'your whole screen' };
    let text = `Sharing ${names[s.displaySurface] || 'your screen'}`;
    if (s.width && s.height) text += ` at ${s.width}×${s.height}`;
    text += '.';
    if (s.displaySurface === 'monitor')
      text += ' Heads-up: a whole-screen share includes the popped-out cameras. Share a tab to keep them private.';
    notice(text, s.displaySurface === 'monitor' ? 'warn' : 'ok', s.displaySurface === 'monitor' ? 0 : 4000);
  }

  function stopScreenShare() {
    if (!screenStream) return;
    signal({ type: 'screen-share', on: false }); // broadcast
    const pcs = ctx.media.getPcs();
    for (const [peerId, list] of senders) {
      const pc = pcs.get(peerId);
      if (!pc) continue;
      for (const sender of list) {
        try {
          pc.removeTrack(sender);
        } catch {}
      }
    }
    senders.clear();
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
    ctx.controls.updateLayout(); // theater: movie big, cameras shrink to a strip
    tryPlay(sv);
  }

  function clearScreen() {
    const sv = $('screen-video');
    sv.srcObject = null;
    sv.hidden = true;
    $('share-placeholder').hidden = false;
    ctx.controls.updateLayout(); // back to the full camera grid
  }

  return {
    isSharing: () => !!screenStream,
    getStreamId: () => screenStream?.id ?? null,
    getRemoteScreenStreamId: () => remoteScreenStreamId,
    getRemoteSharerId: () => remoteSharerId,
    setRemoteScreen: (sharerId, streamId) => {
      remoteSharerId = sharerId;
      remoteScreenStreamId = streamId;
    },
    addScreenTracksTo,
    detachPeer: (peerId) => senders.delete(peerId), // its pc is closing; senders die with it
    startScreenShare,
    stopScreenShare,
    showScreen,
    clearScreen,
    updateShareButton,
    dispose: () => screenStream?.getTracks().forEach((t) => t.stop()),
  };
}
