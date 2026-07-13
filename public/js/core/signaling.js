// Signaling socket + room state (Phase 1/5).
// Owns the WebSocket (with auto-reconnect), the server-authoritative room state
// (peer presence, negotiation role, share baton), and the inbound message
// dispatcher that fans work out to media / screen / sync / chat / reactions.

export function createSignaling(ctx) {
  let peerPresent = false;
  let polite = false;
  let rejected = false;
  let shareBaton = 'free'; // 'free' | 'mine' | 'peer' — one active sharer, server-arbitrated
  let netSignaling = 'connecting'; // 'connecting' | 'connected' | 'reconnecting'
  let peerLeftGraceTimer = null; // peer-left may be a signaling blip; delay teardown

  // ---- Signaling socket with auto-reconnect (Phase 5) ----
  // The socket can idle out (Cloudflare tunnel) or drop on a network blip.
  // Reconnect with exponential backoff (1s,2s,4s,8s… cap 15s), rejoin the same
  // room, and resume. Only the Leave button (or room-full) stops retrying.
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws = null;
  let leaving = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;

  const signal = (msg) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  let inbox = Promise.resolve();

  function connectWs() {
    reconnectTimer = null;
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.addEventListener('open', () => {
      reconnectAttempts = 0;
      netSignaling = 'connected';
      signal({ type: 'join', room: ctx.roomId }); // server replies with 'room-state'
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      inbox = inbox.then(() => handleSignal(msg)).catch((err) => console.error('signal error:', err));
    });

    ws.addEventListener('close', () => {
      if (leaving || rejected) return;
      scheduleReconnect();
    });
    // Errors are followed by 'close'; reconnect is handled there.
    ws.addEventListener('error', () => {});
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    netSignaling = 'reconnecting';
    const delay = Math.min(15_000, 1000 * 2 ** reconnectAttempts);
    reconnectAttempts++;
    ctx.controls.setStatus(`Reconnecting… (attempt ${reconnectAttempts})`, 'warn');
    reconnectTimer = setTimeout(connectWs, delay);
  }

  // A restored network connection is a good moment to skip the backoff.
  window.addEventListener('online', () => {
    if (reconnectTimer && !leaving && !rejected) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      connectWs();
    }
  });

  async function handleSignal(msg) {
    switch (msg.type) {
      case 'room-state': {
        // Server-authoritative occupancy (Phase 5 fix): rebuild peer, role,
        // and baton state from this message on every join/reconnect/change —
        // never from pre-drop memory.
        peerPresent = msg.peerPresent;
        polite = msg.youAre === 'second'; // server-assigned; survives reconnects
        clearTimeout(peerLeftGraceTimer);
        peerLeftGraceTimer = null;

        if (msg.shareHolder === 'peer') {
          shareBaton = 'peer';
          if (ctx.screen.isSharing()) ctx.screen.stopScreenShare(); // converge: server says peer holds it
        } else if (msg.shareHolder === 'you') {
          shareBaton = 'mine';
        } else if (ctx.screen.isSharing()) {
          // Still capturing but the server forgot us (our socket died
          // mid-share) — re-claim the baton.
          shareBaton = 'free';
          signal({ type: 'share-claim' });
        } else {
          shareBaton = 'free';
        }

        if (peerPresent) {
          ctx.controls.setStatus(ctx.controls.getMode() === 'sync' ? 'Synced' : 'Connected', 'ok');
          await ctx.media.ensureHealthyPc();
        } else if (ctx.media.getPc() && ctx.media.getPc().connectionState === 'connected') {
          // Peer's socket dropped but P2P media still flows — likely just a
          // signaling blip on their side. Grace window before teardown.
          ctx.controls.setStatus('Your friend disconnected — waiting for them to return…', 'warn');
          peerLeftGraceTimer = setTimeout(() => {
            peerLeftGraceTimer = null;
            if (!peerPresent) {
              ctx.media.teardownPeerConnection();
              ctx.controls.setStatus('Your friend left — waiting for them to rejoin…', 'warn');
            }
          }, 12_000);
        } else {
          // Alone with a dead (or no) peer connection — clean up rather than
          // leaving a zombie pc endlessly attempting ICE restarts.
          if (ctx.media.getPc()) ctx.media.teardownPeerConnection();
          ctx.controls.setStatus('Waiting for your friend…');
        }
        ctx.screen.updateShareButton();
        break;
      }
      case 'room-full':
        rejected = true;
        ctx.controls.setStatus('Room is full (two people max).', 'error');
        break;
      case 'offer':
      case 'answer':
        if (!ctx.media.getPc()) await ctx.media.createPeerConnection();
        await ctx.media.handleDescription(msg.sdp);
        break;
      case 'ice-candidate':
        await ctx.media.addIceCandidate(msg.candidate);
        break;
      case 'screen-share':
        if (msg.on) {
          ctx.screen.setRemoteScreenStreamId(msg.streamId);
          shareBaton = 'peer'; // belt & braces alongside room-state
          ctx.screen.updateShareButton();
          ctx.controls.setMode('screen');
        } else {
          ctx.screen.setRemoteScreenStreamId(null);
          ctx.screen.clearScreen();
        }
        break;
      case 'share-granted':
        shareBaton = 'mine';
        ctx.screen.updateShareButton();
        // Not awaited: the picker can stay open for many seconds and must not
        // block the inbox queue (ICE candidates, offers…).
        ctx.screen.startScreenShare().then(() => {
          if (!ctx.screen.isSharing()) {
            // Picker cancelled or capture failed — hand the baton back.
            shareBaton = 'free';
            signal({ type: 'share-release' });
            ctx.screen.updateShareButton();
          }
        });
        break;
      case 'share-denied':
        shareBaton = 'peer';
        ctx.controls.notice('Your friend is already sharing.', 'warn', 4000);
        ctx.screen.updateShareButton();
        break;
      case 'sync-load':
        ctx.controls.setMode('sync');
        await ctx.syncMode.handleRemoteLoad(msg.source);
        break;
      case 'sync':
        await ctx.syncCore.applyRemoteSync(msg);
        break;
      case 'reaction':
        ctx.reactions.showReaction(msg.emoji); // validated against the preset list inside
        break;
      case 'chat':
        ctx.chat.appendMessage('Them', msg.text);
        break;
    }
  }

  return {
    signal,
    isOpen: () => ws?.readyState === WebSocket.OPEN,
    isPeerPresent: () => peerPresent,
    isPolite: () => polite,
    getNetSignaling: () => netSignaling,
    getShareBaton: () => shareBaton,
    setShareBaton: (v) => (shareBaton = v),
    start: connectWs,
    dispose: () => {
      leaving = true; // stop the auto-reconnect loop
      clearTimeout(reconnectTimer);
      clearTimeout(peerLeftGraceTimer);
      ws?.close();
    },
  };
}
