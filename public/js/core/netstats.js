// Network status indicator (Phase 5, mesh-aware) + weak-connection dots.
//
// Every 2s, aggregate across ALL peer connections: worst RTT from selected
// candidate pairs, packet loss + total bitrate from inbound-rtp deltas.
// Good <150ms & <2% · Fair 150–300ms or 2–5% · Poor above.
//
// Weak-connection dots: outbound-rtp reports qualityLimitationReason —
// 'bandwidth' means WebRTC had to downgrade our video on that link ('cpu' is
// excluded: not the network's fault; Firefox doesn't report it → no dots).
// Attribution on a mesh, with ~6s hysteresis both ways so it never flaps:
//   · a MINORITY of my links limited → those peers' connections are the
//     problem → dot THEIR tiles (local decision, no messages needed)
//   · MOST of my links limited (2+ links) → *I* am the problem (my uplink)
//     → dot MY tile and broadcast net-weak so everyone dots it too — only I
//     can see my own uplink congestion. Suppresses the per-peer dots, which
//     would otherwise light up the whole room.
//   · a single link total → can't attribute a side; dot the peer's tile.
// Purely informational: it makes visible whose wifi is the problem.

import { $ } from '../lib/dom.js';

const WEAK_ON_POLLS = 3; // ~6s at the 2s cadence before a dot appears
const WEAK_OFF_POLLS = 3; // ~6s clean before it clears

export function createNetStats(ctx) {
  let prevInbound = null;
  let statsTimer = null;

  // Weak-connection state (per peer id + self).
  const onStreak = new Map();
  const offStreak = new Map();
  const localWeak = new Set(); // flagged by MY outbound stats to that peer
  const remoteWeak = new Set(); // flagged by the peer's own net-weak broadcast
  let selfOn = 0;
  let selfOff = 0;
  let selfWeak = false;
  let lastSentWeak = false; // broadcast only on transitions (we start not-weak)

  function renderNet(text, kind, tooltip) {
    $('net-label').textContent = text;
    $('net-dot').className = kind;
    $('net-wrap').title = tooltip;
  }

  const effectiveWeak = (id) => remoteWeak.has(id) || (localWeak.has(id) && !selfWeak);

  function applyWeakUI(ids) {
    ctx.tiles.setWeak('self', selfWeak);
    for (const id of ids) ctx.tiles.setWeak(id, effectiveWeak(id));
  }

  function updateWeakState(limitedByPeer) {
    const ids = [...limitedByPeer.keys()];

    // Per-peer streaks → local flags.
    for (const [id, limited] of limitedByPeer) {
      if (limited) {
        onStreak.set(id, (onStreak.get(id) || 0) + 1);
        offStreak.set(id, 0);
        if (onStreak.get(id) >= WEAK_ON_POLLS) localWeak.add(id);
      } else {
        offStreak.set(id, (offStreak.get(id) || 0) + 1);
        onStreak.set(id, 0);
        if (offStreak.get(id) >= WEAK_OFF_POLLS) localWeak.delete(id);
      }
    }

    // Self rule: most links limited (needs 2+ links to attribute to us).
    const n = ids.length;
    const limitedNow = [...limitedByPeer.values()].filter(Boolean).length;
    if (n >= 2 && limitedNow * 2 > n) {
      selfOn++;
      selfOff = 0;
      if (selfOn >= WEAK_ON_POLLS) selfWeak = true;
    } else {
      selfOff++;
      selfOn = 0;
      if (selfOff >= WEAK_OFF_POLLS) selfWeak = false;
    }
    if (selfWeak !== lastSentWeak) {
      lastSentWeak = selfWeak;
      ctx.signaling.signal({ type: 'net-weak', weak: selfWeak });
    }

    // Prune members that left.
    const present = new Set(ids);
    for (const map of [onStreak, offStreak]) {
      for (const id of map.keys()) if (!present.has(id)) map.delete(id);
    }
    for (const set of [localWeak, remoteWeak]) {
      for (const id of set) if (!present.has(id)) set.delete(id);
    }

    applyWeakUI(ids);
  }

  async function pollNetStats() {
    const netSignaling = ctx.signaling.getNetSignaling();
    const sigText = netSignaling === 'reconnecting' ? 'reconnecting' : 'connected';
    if (netSignaling === 'reconnecting') {
      renderNet('Reconnecting', 'error', 'Signaling: reconnecting');
      return;
    }
    const entries = [...ctx.media.getPcs()].filter(([, pc]) => pc.connectionState === 'connected');
    if (!entries.length) {
      renderNet('No call', '', `Signaling: ${sigText} · no media connections`);
      prevInbound = null;
      return;
    }
    let rttMs = null; // worst link
    let recv = 0;
    let lost = 0;
    let bytes = 0;
    const limitedByPeer = new Map(); // peerId → outbound video bandwidth-limited?
    try {
      for (const [peerId, pc] of entries) {
        const stats = await pc.getStats();
        let pairId = null;
        let limited = false;
        stats.forEach((r) => {
          if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
        });
        stats.forEach((r) => {
          if (
            r.type === 'candidate-pair' &&
            (pairId ? r.id === pairId : r.nominated && r.state === 'succeeded') &&
            typeof r.currentRoundTripTime === 'number'
          ) {
            const ms = r.currentRoundTripTime * 1000;
            if (rttMs === null || ms > rttMs) rttMs = ms;
          }
          if (r.type === 'inbound-rtp') {
            recv += r.packetsReceived || 0;
            lost += r.packetsLost || 0;
            bytes += r.bytesReceived || 0;
          }
          if (
            r.type === 'outbound-rtp' &&
            (r.kind === 'video' || r.mediaType === 'video') &&
            r.qualityLimitationReason === 'bandwidth'
          ) {
            limited = true;
          }
        });
        limitedByPeer.set(peerId, limited);
      }
    } catch {
      return; // a pc closed mid-poll
    }
    updateWeakState(limitedByPeer);

    const now = Date.now();
    let lossPct = 0;
    let mbps = 0;
    if (prevInbound) {
      const dRecv = Math.max(0, recv - prevInbound.recv);
      const dLost = Math.max(0, lost - prevInbound.lost);
      if (dRecv + dLost > 0) lossPct = (dLost / (dRecv + dLost)) * 100;
      mbps = Math.max(0, ((bytes - prevInbound.bytes) * 8) / (now - prevInbound.ts) / 1000);
    }
    prevInbound = { ts: now, recv, lost, bytes };

    let quality = 'Good';
    let kind = 'ok';
    if ((rttMs ?? 0) > 300 || lossPct > 5) {
      quality = 'Poor';
      kind = 'error';
    } else if ((rttMs ?? 0) > 150 || lossPct > 2) {
      quality = 'Fair';
      kind = 'warn';
    }
    renderNet(
      quality,
      kind,
      `${entries.length} link${entries.length > 1 ? 's' : ''} · worst RTT ${rttMs != null ? `${Math.round(rttMs)} ms` : '—'} · ` +
        `loss ${lossPct.toFixed(1)}% · ↓ ${mbps.toFixed(1)} Mbps · signaling: ${sigText}`
    );
  }

  return {
    start: () => {
      statsTimer = setInterval(pollNetStats, 2000);
    },
    pollOnce: pollNetStats, // exposed for tests
    // A peer told the room its own uplink is weak (or recovered).
    setRemoteWeak: (peerId, weak) => {
      if (weak) remoteWeak.add(peerId);
      else remoteWeak.delete(peerId);
      ctx.tiles.setWeak(peerId, effectiveWeak(peerId));
    },
    isSelfWeak: () => selfWeak,
    dispose: () => clearInterval(statsTimer),
  };
}
