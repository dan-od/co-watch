// Network status indicator (Phase 5, mesh-aware).
// Every 2s, aggregate across ALL peer connections: worst RTT from selected
// candidate pairs, packet loss + total bitrate from inbound-rtp deltas.
// Good <150ms & <2% · Fair 150–300ms or 2–5% · Poor above.

import { $ } from '../lib/dom.js';

export function createNetStats(ctx) {
  let prevInbound = null;
  let statsTimer = null;

  function renderNet(text, kind, tooltip) {
    $('net-label').textContent = text;
    $('net-dot').className = kind;
    $('net-wrap').title = tooltip;
  }

  async function pollNetStats() {
    const netSignaling = ctx.signaling.getNetSignaling();
    const sigText = netSignaling === 'reconnecting' ? 'reconnecting' : 'connected';
    if (netSignaling === 'reconnecting') {
      renderNet('Reconnecting', 'error', 'Signaling: reconnecting');
      return;
    }
    const pcs = [...ctx.media.getPcs().values()].filter((pc) => pc.connectionState === 'connected');
    if (!pcs.length) {
      renderNet('No call', '', `Signaling: ${sigText} · no media connections`);
      prevInbound = null;
      return;
    }
    let rttMs = null; // worst link
    let recv = 0;
    let lost = 0;
    let bytes = 0;
    try {
      for (const pc of pcs) {
        const stats = await pc.getStats();
        let pairId = null;
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
        });
      }
    } catch {
      return; // a pc closed mid-poll
    }
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
      `${pcs.length} link${pcs.length > 1 ? 's' : ''} · worst RTT ${rttMs != null ? `${Math.round(rttMs)} ms` : '—'} · ` +
        `loss ${lossPct.toFixed(1)}% · ↓ ${mbps.toFixed(1)} Mbps · signaling: ${sigText}`
    );
  }

  return {
    start: () => {
      statsTimer = setInterval(pollNetStats, 2000);
    },
    dispose: () => clearInterval(statsTimer),
  };
}
