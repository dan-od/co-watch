// Local media + the WebRTC mesh (Part 2). One RTCPeerConnection per other
// participant, each running perfect negotiation independently with roles
// derived from stable id comparison. Membership diffs from room-state drive
// creation/teardown; a member whose socket dropped but whose P2P link is
// still up gets a grace window (their stable id lets them resume seamlessly).
//
// Sender quality policy (audio > screen > cameras):
//   camera video — maxBitrate ~1.2 Mbps, priority low, maintain-framerate
//                  (a struggling link softens resolution instead of freezing)
//   audio        — priority high; WebRTC starves video long before audio
//   screen       — tuned in modes/screen.js (high priority, 2.5 Mbps)
// Params are per-sender per-connection, so one bad link only affects what WE
// send THAT person — everyone else stays crisp.

import { $ } from '../lib/dom.js';

const CAM_MAX_BITRATE = 1_200_000; // generous ceiling — healthy links look crisp
const CAM_CONSTRAINTS = { video: { frameRate: { max: 30 } }, audio: true };
const PEER_GONE_GRACE_MS = 12_000; // socket-drop ≠ gone; P2P often survives the blip

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

// Apply per-sender quality params; browsers vary, so failures are non-fatal.
export async function tuneSender(sender, { maxBitrate, priority, degradationPreference } = {}) {
  try {
    const p = sender.getParameters();
    if (!p.encodings || p.encodings.length === 0) p.encodings = [{}];
    if (maxBitrate) p.encodings[0].maxBitrate = maxBitrate;
    if (priority) {
      p.encodings[0].priority = priority;
      p.encodings[0].networkPriority = priority;
    }
    if (degradationPreference) p.degradationPreference = degradationPreference;
    await sender.setParameters(p);
  } catch (err) {
    console.warn('could not tune sender:', err);
  }
}

export function createMedia(ctx) {
  const iceConfigPromise = fetchIceConfig();
  let localStream = null;
  const peers = new Map(); // peerId → { pc, polite, makingOffer, ignoreOffer, iceRestartTimer, goneTimer }

  const setStatus = (text, kind) => ctx.controls.setStatus(text, kind);

  // ---- Local media ----
  async function startLocalMedia() {
    $('media-error').hidden = true;
    try {
      localStream = await navigator.mediaDevices.getUserMedia(CAM_CONSTRAINTS);
      const cam = localStream.getVideoTracks()[0];
      if (cam) cam.contentHint = 'motion';
      ctx.tiles.setSelfStream(localStream);
      ctx.ptt.reapplyMic(); // a re-acquired mic honors PTT state
      ctx.controls.syncToggleButtons();
      for (const rec of peers.values()) addLocalTracks(rec.pc);
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

  // ---- Membership sync (called on every room-state) ----
  // New members get a connection; departed members get a grace window if their
  // P2P link still works (their socket blipped, not them), else torn down now.
  async function syncMembers(otherIds) {
    const present = new Set(otherIds);
    for (const [id, rec] of peers) {
      if (present.has(id)) {
        clearTimeout(rec.goneTimer); // they're back (or never left)
        rec.goneTimer = null;
      } else if (rec.pc.connectionState === 'connected' && !rec.goneTimer) {
        rec.goneTimer = setTimeout(() => {
          rec.goneTimer = null;
          if (peers.has(id)) removePeer(id);
        }, PEER_GONE_GRACE_MS);
      } else if (rec.pc.connectionState !== 'connected') {
        removePeer(id);
      }
    }
    for (const id of otherIds) {
      if (!peers.has(id)) await createPeer(id);
    }
  }

  async function createPeer(peerId) {
    if (peers.has(peerId)) return peers.get(peerId);
    const { iceServers, forceRelay } = await iceConfigPromise;
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: forceRelay ? 'relay' : 'all' });
    const rec = {
      pc,
      // Exactly one side of each pair is polite: the lexicographically larger
      // id. Stable ids → roles survive reconnects; no double-impolite glare.
      polite: ctx.signaling.getSelfId() > peerId,
      makingOffer: false,
      ignoreOffer: false,
      iceRestartTimer: null,
      goneTimer: null,
    };
    peers.set(peerId, rec);

    pc.onnegotiationneeded = async () => {
      try {
        rec.makingOffer = true;
        await pc.setLocalDescription();
        ctx.signaling.signal({ type: pc.localDescription.type, sdp: pc.localDescription, to: peerId });
      } catch (err) {
        console.error('negotiation failed:', err);
      } finally {
        rec.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) ctx.signaling.signal({ type: 'ice-candidate', candidate, to: peerId });
    };

    pc.ontrack = ({ streams }) => {
      const stream = streams[0];
      if (!stream) return;
      // The sharer announces its screen stream id over signaling before the
      // tracks arrive (renegotiation is slower than the ws), so we can route:
      // screen stream → stage, anything else → that person's camera tile.
      if (stream.id === ctx.screen.getRemoteScreenStreamId()) {
        if ($('screen-video').srcObject !== stream) ctx.screen.showScreen(stream, false);
      } else {
        ctx.tiles.setStream(peerId, stream);
      }
    };

    pc.onconnectionstatechange = () => refreshCallStatus();

    // ICE often self-heals within a couple of seconds; if it doesn't, restart
    // ICE over the (possibly reconnected) signaling channel instead of tearing
    // the link down. restartIce() fires onnegotiationneeded, so the offer
    // flows through the normal perfect-negotiation path. Per-peer: one bad
    // link never touches the others.
    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      if (st === 'disconnected' || st === 'failed') {
        scheduleIceRestart(peerId);
      } else if (st === 'connected' || st === 'completed') {
        clearTimeout(rec.iceRestartTimer);
        rec.iceRestartTimer = null;
      }
    };

    addLocalTracks(pc);
    ctx.screen.addScreenTracksTo(peerId, pc); // no-op unless we're mid-share
    return rec;
  }

  function scheduleIceRestart(peerId) {
    const rec = peers.get(peerId);
    if (!rec || rec.iceRestartTimer) return;
    rec.iceRestartTimer = setTimeout(() => {
      rec.iceRestartTimer = null;
      const cur = peers.get(peerId);
      if (!cur) return;
      const st = cur.pc.iceConnectionState;
      if (st !== 'disconnected' && st !== 'failed') return; // self-healed
      if (!ctx.signaling.getMemberIds().includes(peerId)) {
        removePeer(peerId); // nobody to restart with — wait for a rejoin
        return;
      }
      setStatus('Restarting a media connection…', 'warn');
      try {
        cur.pc.restartIce();
      } catch (err) {
        console.warn('restartIce failed:', err);
      }
    }, 3000);
  }

  function addLocalTracks(pc) {
    if (!localStream) return;
    const sending = new Set(pc.getSenders().map((s) => s.track));
    for (const track of localStream.getTracks()) {
      if (sending.has(track)) continue;
      const sender = pc.addTrack(track, localStream);
      if (track.kind === 'video') {
        tuneSender(sender, {
          maxBitrate: CAM_MAX_BITRATE,
          priority: 'low', // cameras starve before the shared screen
          degradationPreference: 'maintain-framerate', // soften, don't freeze
        });
      } else {
        tuneSender(sender, { priority: 'high' }); // audio is sacred
      }
    }
  }

  async function handleDescription(from, description) {
    const rec = peers.get(from) || (await createPeer(from));
    const { pc } = rec;
    const offerCollision =
      description.type === 'offer' && (rec.makingOffer || pc.signalingState !== 'stable');
    rec.ignoreOffer = !rec.polite && offerCollision;
    if (rec.ignoreOffer) return;
    await pc.setRemoteDescription(description);
    if (description.type === 'offer') {
      await pc.setLocalDescription();
      ctx.signaling.signal({ type: 'answer', sdp: pc.localDescription, to: from });
    }
  }

  async function addIceCandidate(from, candidate) {
    const rec = peers.get(from);
    if (!rec) return;
    try {
      await rec.pc.addIceCandidate(candidate);
    } catch (err) {
      if (!rec.ignoreOffer) console.warn('addIceCandidate failed:', err);
    }
  }

  function removePeer(peerId) {
    const rec = peers.get(peerId);
    if (!rec) return;
    clearTimeout(rec.iceRestartTimer);
    clearTimeout(rec.goneTimer);
    rec.pc.close();
    peers.delete(peerId);
    ctx.screen.detachPeer(peerId);
    ctx.tiles.removeTile(peerId);
    refreshCallStatus();
  }

  function refreshCallStatus() {
    const states = [...peers.values()].map((r) => r.pc.connectionState);
    if (!states.length) return; // signaling owns the "waiting" message
    if (states.some((s) => s === 'connected')) {
      if (ctx.signaling.isPeerPresent())
        setStatus(ctx.controls.getMode() === 'sync' ? 'Synced' : 'Connected', 'ok');
    } else if (states.some((s) => s === 'failed')) {
      setStatus('Connection lost — trying an ICE restart…', 'warn');
    } else if (states.some((s) => s === 'disconnected')) {
      setStatus('Connection unstable — recovering…', 'warn');
    }
  }

  return {
    getPcs: () => new Map([...peers].map(([id, rec]) => [id, rec.pc])),
    getAnyPc: () => peers.values().next().value?.pc || null,
    isPolite: (peerId) => peers.get(peerId)?.polite ?? null,
    getLocalStream: () => localStream,
    syncMembers,
    handleDescription,
    addIceCandidate,
    removePeer,
    start: startLocalMedia,
    dispose: () => {
      for (const id of [...peers.keys()]) removePeer(id);
      localStream?.getTracks().forEach((t) => t.stop());
    },
  };
}
