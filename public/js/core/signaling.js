// Signaling socket + room state (Phase 1/5, mesh Part 2).
// Owns the WebSocket (with auto-reconnect), the server-authoritative room
// state (member list with names, share baton), and the inbound message
// dispatcher. Every relayed message carries a server-stamped `from`; we
// address per-peer messages with `to`. Membership diffs drive the media
// mesh (one connection per member) via media.syncMembers().

export function createSignaling(ctx) {
  // Stable identity (mesh Part 1): assigned by the server on first join and
  // kept per-tab so reloads/reconnects present the same id — the server then
  // replaces our lingering old socket instead of counting us twice, and
  // negotiation roles derived from ids stay consistent across reconnects.
  let selfId = sessionStorage.getItem('cowatch_peer_id') || null;
  let members = new Map(); // peerId → { name } (others only, not self)
  let shareHolderId = null;
  let seenRoomState = false; // first room-state = our own arrival, not others joining
  let rejected = false;
  let shareBaton = 'free'; // 'free' | 'mine' | 'peer' — one active sharer, server-arbitrated
  let netSignaling = 'connecting'; // 'connecting' | 'connected' | 'reconnecting'

  // ---- Signaling socket with auto-reconnect (Phase 5) ----
  // The socket can idle out (Cloudflare tunnel) or drop on a network blip.
  // Reconnect with exponential backoff (1s,2s,4s,8s… cap 15s), rejoin the same
  // room, and resume. Only the Leave button (or room-full) stops retrying.
  // Where the room lives. In the browser that is wherever the page came from.
  // In the desktop app the page is served by a local server on 127.0.0.1, which
  // no friend can reach — so the room has to be somewhere shared, and the shell
  // supplies it. Everything ELSE (stream lookup, audio repair) deliberately
  // stays local: that is what makes debrid links work, since they are issued to
  // the viewer's own machine.
  const signalingBase = () => {
    const configured = window.__cowatchSignaling;
    if (configured) {
      try {
        const u = new URL(configured);
        return `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}`;
      } catch {
        // malformed setting — fall through to this origin
      }
    }
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  };
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
    ws = new WebSocket(signalingBase());

    ws.addEventListener('open', () => {
      reconnectAttempts = 0;
      netSignaling = 'connected';
      const join = { type: 'join', room: ctx.roomId, name: ctx.displayName };
      if (selfId) join.peerId = selfId; // reconnect as ourselves, not another person
      signal(join); // server replies with 'room-state'
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

  const nameOf = (peerId) => members.get(peerId)?.name || 'Someone';

  async function handleSignal(msg) {
    switch (msg.type) {
      case 'room-state': {
        // Server-authoritative occupancy: rebuild members, roles, and baton
        // state from this message on every join/reconnect/change — never from
        // pre-drop memory.
        selfId = msg.you || selfId;
        if (selfId) sessionStorage.setItem('cowatch_peer_id', selfId);
        const prev = members;
        members = new Map();
        for (const m of msg.members || []) {
          if (!m?.peerId || m.isYou || m.peerId === selfId) continue;
          members.set(m.peerId, { name: m.name || 'Someone' });
          ctx.tiles.ensureTile(m.peerId, m.name);
        }
        shareHolderId = msg.shareHolder || null;

        // Baton convergence.
        if (shareHolderId && shareHolderId !== selfId) {
          shareBaton = 'peer';
          if (ctx.screen.isSharing()) ctx.screen.stopScreenShare(); // server says someone else holds it
        } else if (shareHolderId === selfId) {
          shareBaton = 'mine';
        } else if (ctx.screen.isSharing()) {
          // Still capturing but the server forgot us (our socket died
          // mid-share) — re-claim the baton.
          shareBaton = 'free';
          signal({ type: 'share-claim' });
        } else {
          shareBaton = 'free';
        }

        // Chat log keeps a trace of arrivals/departures. The FIRST room-state
        // is our own arrival — announcing everyone already here would be noise.
        if (seenRoomState) {
          for (const [id, m] of members) if (!prev.has(id)) ctx.chat.appendSystem(`${m.name || 'Someone'} joined`);
          for (const [id, m] of prev) {
            if (members.has(id)) continue;
            ctx.chat.appendSystem(`${m.name || 'Someone'} left`);
            ctx.playerUi.onPeerGone(id); // drop their position mark
          }
        }
        seenRoomState = true;
        ctx.chat.setOnlineCount(members.size + 1); // + yourself

        // Mesh: connections follow membership (tiles are removed by media
        // after its per-peer grace window, not here).
        await ctx.media.syncMembers([...members.keys()]);

        // Bring newcomers up to speed: our live share and our mute state
        // travelled past them while they weren't in the room.
        for (const id of members.keys()) {
          if (prev.has(id)) continue;
          if (ctx.screen.isSharing()) {
            signal({ type: 'screen-share', on: true, streamId: ctx.screen.getStreamId(), to: id });
          }
          if (ctx.controls.getMicMuted()) signal({ type: 'mic-state', muted: true, to: id });
          if (ctx.netstats.isSelfWeak()) signal({ type: 'net-weak', weak: true, to: id });
        }

        ctx.controls.setStatus(
          members.size
            ? ctx.controls.getMode() === 'sync'
              ? 'Synced'
              : 'Connected'
            : 'Waiting for others to join…',
          members.size ? 'ok' : ''
        );
        ctx.screen.updateShareButton();
        break;
      }
      case 'room-full':
        rejected = true;
        ctx.controls.setStatus('Room is full (six people max).', 'error');
        break;
      case 'offer':
      case 'answer':
        await ctx.media.handleDescription(msg.from, msg.sdp);
        break;
      case 'ice-candidate':
        await ctx.media.addIceCandidate(msg.from, msg.candidate);
        break;
      case 'screen-share':
        if (msg.on) {
          ctx.screen.setRemoteScreen(msg.from, msg.streamId);
          shareBaton = 'peer'; // belt & braces alongside room-state
          ctx.screen.updateShareButton();
          ctx.controls.setMode('screen');
        } else if (ctx.screen.getRemoteSharerId() === msg.from) {
          ctx.screen.setRemoteScreen(null, null);
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
        ctx.controls.notice(`${nameOf(shareHolderId)} is already sharing.`, 'warn', 4000);
        ctx.screen.updateShareButton();
        break;
      case 'sync-load':
        ctx.spectate.hide(); // the movie is starting — browsing mirror closes
        // loadSource switches to the watch view itself once the player exists.
        await ctx.syncMode.handleRemoteLoad(msg.source, nameOf(msg.from));
        break;
      case 'browse':
        // Host's Stremio browsing, mirrored read-only (modes/spectate.js).
        ctx.spectate.show(msg.data, nameOf(msg.from));
        break;
      case 'sync':
        ctx.playerUi.onRemoteSync(msg, nameOf(msg.from)); // "Paused by <name>"
        await ctx.syncCore.applyRemoteSync(msg);
        break;
      case 'pos':
        // Lightweight position beat → peer marks + the in-sync/drift readout.
        ctx.playerUi.onRemotePos(msg.from, msg, nameOf(msg.from));
        break;
      case 'mic-state':
        ctx.tiles.setMuted(msg.from, !!msg.muted);
        break;
      case 'net-weak':
        ctx.netstats.setRemoteWeak(msg.from, !!msg.weak);
        break;
      case 'reaction':
        ctx.reactions.showReaction(msg.emoji, nameOf(msg.from)); // validated against the preset list inside
        break;
      case 'chat':
        ctx.chat.appendMessage(nameOf(msg.from), msg.text);
        ctx.immersive?.notifyChat(nameOf(msg.from), msg.text); // peek while chrome hidden
        break;
    }
  }

  return {
    signal,
    isOpen: () => ws?.readyState === WebSocket.OPEN,
    isPeerPresent: () => members.size > 0,
    getSelfId: () => selfId,
    getMemberIds: () => [...members.keys()],
    getMemberName: nameOf,
    getShareHolderId: () => shareHolderId,
    getNetSignaling: () => netSignaling,
    getShareBaton: () => shareBaton,
    setShareBaton: (v) => (shareBaton = v),
    start: connectWs,
    dispose: () => {
      leaving = true; // stop the auto-reconnect loop
      clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}
