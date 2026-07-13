// Local media + the WebRTC peer connection (perfect negotiation, Phase 2/3/5).
// Owns getUserMedia, the RTCPeerConnection, renegotiation, and ICE restarts.
// Screen tracks are added/removed here on behalf of modes/screen.js.

import { $, tryPlay } from '../lib/dom.js';

// ICE servers come from the server (/ice-config), which reads TURN credentials
// from its environment. Falls back to STUN-only if the endpoint is unreachable.
async function fetchIceConfig() {
  try {
    const res = await fetch('/ice-config');
    if (res.ok) {
      const cfg = await res.json();
      if (Array.isArray(cfg.iceServers) && cfg.iceServers.length) {
        return { iceServers: cfg.iceServers, forceRelay: !!cfg.forceRelay };
      }
    }
  } catch {
    // fall through
  }
  console.warn('Could not fetch /ice-config — falling back to STUN-only.');
  return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], forceRelay: false };
}

export function createMedia(ctx) {
  const iceConfigPromise = fetchIceConfig();
  let localStream = null;
  let pc = null;
  let makingOffer = false;
  let ignoreOffer = false;
  let iceRestartTimer = null;

  const elRemote = ctx.els.remote;
  const setStatus = (text, kind) => ctx.controls.setStatus(text, kind);

  // ---- Local media ----
  async function startLocalMedia() {
    $('media-error').hidden = true;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      $('local-video').srcObject = localStream;
      ctx.ptt.reapplyMic(); // a re-acquired mic honors PTT state
      ctx.controls.syncToggleButtons();
      addLocalTracks();
    } catch (err) {
      showMediaError(err);
    }
  }

  function showMediaError(err) {
    let reason;
    if (err.name === 'NotAllowedError')
      reason = 'Camera/microphone permission was denied. Allow access, then try again.';
    else if (err.name === 'NotFoundError') reason = 'No camera or microphone was found.';
    else if (err.name === 'NotReadableError')
      reason = 'Your camera or microphone is in use by another app.';
    else reason = `Could not start camera/microphone: ${err.message || err.name}`;
    $('media-error-text').textContent = reason;
    $('media-error').hidden = false;
  }

  $('retry-media').addEventListener('click', startLocalMedia);

  // If the old peer connection survived the signaling blip (P2P media is
  // independent of the socket), keep it; otherwise start fresh.
  async function ensureHealthyPc() {
    if (pc && pc.connectionState === 'connected') return;
    if (pc) teardownPeerConnection();
    await createPeerConnection();
  }

  // ---- Peer connection (perfect negotiation) ----
  async function createPeerConnection() {
    if (pc) return;
    const { iceServers, forceRelay } = await iceConfigPromise;
    pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: forceRelay ? 'relay' : 'all' });

    pc.onnegotiationneeded = async () => {
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        ctx.signaling.signal({ type: pc.localDescription.type, sdp: pc.localDescription });
      } catch (err) {
        console.error('negotiation failed:', err);
      } finally {
        makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) ctx.signaling.signal({ type: 'ice-candidate', candidate });
    };

    pc.ontrack = ({ streams }) => {
      const stream = streams[0];
      if (!stream) return;
      if (stream.id === ctx.screen.getRemoteScreenStreamId()) {
        if ($('screen-video').srcObject !== stream) ctx.screen.showScreen(stream, false);
      } else if (elRemote.srcObject !== stream) {
        elRemote.srcObject = stream;
        tryPlay(elRemote);
      }
    };

    pc.onconnectionstatechange = () => {
      switch (pc?.connectionState) {
        case 'connected':
          if (ctx.signaling.isPeerPresent())
            setStatus(ctx.controls.getMode() === 'sync' ? 'Synced' : 'Connected', 'ok');
          break;
        case 'disconnected':
          setStatus('Connection unstable — recovering…', 'warn');
          break;
        case 'failed':
          setStatus('Connection lost — trying an ICE restart…', 'warn');
          break;
      }
    };

    // Phase 5: ICE often self-heals within a couple of seconds; if it doesn't,
    // restart ICE over the (possibly reconnected) signaling channel instead of
    // tearing the call down. restartIce() fires onnegotiationneeded, so the
    // offer flows through the normal perfect-negotiation path.
    pc.oniceconnectionstatechange = () => {
      const st = pc?.iceConnectionState;
      if (st === 'disconnected' || st === 'failed') {
        scheduleIceRestart();
      } else if (st === 'connected' || st === 'completed') {
        clearTimeout(iceRestartTimer);
        iceRestartTimer = null;
      }
    };

    addLocalTracks();
  }

  function scheduleIceRestart() {
    if (iceRestartTimer || !pc) return;
    iceRestartTimer = setTimeout(() => {
      iceRestartTimer = null;
      if (!pc) return;
      const st = pc.iceConnectionState;
      if (st !== 'disconnected' && st !== 'failed') return; // self-healed
      if (!ctx.signaling.isPeerPresent()) {
        // No peer on the signaling side — an ICE restart has nobody to talk
        // to. Tear down and wait for a rejoin instead of restarting forever.
        teardownPeerConnection();
        setStatus('Your friend left — waiting for them to rejoin…', 'warn');
        return;
      }
      setStatus('Restarting the media connection…', 'warn');
      try {
        pc.restartIce();
      } catch (err) {
        console.warn('restartIce failed:', err);
      }
      // If it's still down when this fires again, another restart is scheduled
      // by the next state change; the signaling reconnect keeps retrying too.
    }, 3000);
  }

  function addLocalTracks() {
    if (!pc || !localStream) return;
    const sending = new Set(pc.getSenders().map((s) => s.track));
    for (const track of localStream.getTracks()) {
      if (!sending.has(track)) pc.addTrack(track, localStream);
    }
  }

  async function handleDescription(description) {
    const offerCollision =
      description.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
    ignoreOffer = !ctx.signaling.isPolite() && offerCollision;
    if (ignoreOffer) return;
    await pc.setRemoteDescription(description);
    if (description.type === 'offer') {
      await pc.setLocalDescription();
      ctx.signaling.signal({ type: 'answer', sdp: pc.localDescription });
    }
  }

  async function addIceCandidate(candidate) {
    if (!pc) return;
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      if (!ignoreOffer) console.warn('addIceCandidate failed:', err);
    }
  }

  function teardownPeerConnection() {
    clearTimeout(iceRestartTimer);
    iceRestartTimer = null;
    if (pc) {
      pc.close();
      pc = null;
    }
    ctx.screen.stopScreenShare();
    ctx.controls.setSwapped(false); // a dead partner cam shouldn't own the stage
    ctx.screen.setRemoteScreenStreamId(null);
    ctx.screen.clearScreen();
    ctx.screen.updateShareButton();
    elRemote.srcObject = null;
    $('tap-to-play').hidden = true;
    makingOffer = false;
    ignoreOffer = false;
  }

  return {
    getPc: () => pc,
    getLocalStream: () => localStream,
    createPeerConnection,
    ensureHealthyPc,
    handleDescription,
    addIceCandidate,
    teardownPeerConnection,
    start: startLocalMedia,
    dispose: () => {
      clearTimeout(iceRestartTimer);
      iceRestartTimer = null;
      pc?.close();
      localStream?.getTracks().forEach((t) => t.stop());
    },
  };
}
