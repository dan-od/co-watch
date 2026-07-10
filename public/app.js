// CoWatch client — Phase 2: camera-to-camera call over the Phase 1 signaling channel.
//
// The RTCPeerConnection uses the "perfect negotiation" pattern: any track added
// later (Phase 3 screen share) fires onnegotiationneeded and renegotiates over
// the same connection — no teardown. Role asymmetry: whoever joins an occupied
// room is the polite peer; the occupant is impolite.

const $ = (id) => document.getElementById(id);

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

const roomMatch = location.pathname.match(/^\/r\/([\w-]{4,64})$/);

if (roomMatch) {
  enterRoom(roomMatch[1]);
} else {
  showLanding();
}

function showLanding() {
  $('landing').hidden = false;
  $('create-room').addEventListener('click', () => {
    const id = randomRoomId();
    location.href = `/r/${id}`;
  });
}

function randomRoomId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10);
}

function enterRoom(roomId) {
  $('room').hidden = false;
  const linkInput = $('room-link');
  linkInput.value = location.href;

  $('copy-link').addEventListener('click', async () => {
    await navigator.clipboard.writeText(linkInput.value);
    $('copy-link').textContent = 'Copied!';
    setTimeout(() => ($('copy-link').textContent = 'Copy link'), 1500);
  });

  const status = $('status');
  const setStatus = (text, kind = '') => {
    status.textContent = text;
    status.className = `status ${kind}`;
  };

  // ---- State ----
  const iceConfigPromise = fetchIceConfig(); // start early; awaited on pc creation
  let peerPresent = false;
  let polite = false;
  let rejected = false; // room-full: keep that status when the server closes the socket
  let localStream = null;
  let pc = null;
  let makingOffer = false;
  let ignoreOffer = false;
  let screenStream = null; // our outgoing screen share
  let screenSenders = []; // RTCRtpSenders for the screen tracks
  let remoteScreenStreamId = null; // announced by the sharer before addTrack

  // ---- Signaling socket ----
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);

  const signal = (msg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  ws.addEventListener('open', () => {
    signal({ type: 'join', room: roomId });
  });

  // Handle messages strictly in arrival order: SDP handling is async, and an
  // ice-candidate must not be processed before its offer finishes applying.
  let inbox = Promise.resolve();
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
    if (!rejected) setStatus('Disconnected from the server. Refresh to reconnect.', 'error');
  });

  ws.addEventListener('error', () => {
    setStatus('Could not reach the server.', 'error');
  });

  async function handleSignal(msg) {
    switch (msg.type) {
      case 'joined':
        peerPresent = msg.peers === 2;
        polite = peerPresent; // joined an occupied room -> polite peer
        if (peerPresent) {
          setStatus('Your friend is here — connecting cameras…', 'ok');
          await createPeerConnection();
          $('share-screen').disabled = false;
        } else {
          setStatus('Waiting for the other person to join…');
        }
        break;
      case 'peer-joined':
        peerPresent = true;
        polite = false; // we were here first -> impolite peer
        setStatus('Your friend is here — connecting cameras…', 'ok');
        await createPeerConnection();
        $('share-screen').disabled = false;
        break;
      case 'peer-left':
        peerPresent = false;
        teardownPeerConnection();
        setStatus('The other person left. Waiting for them to rejoin…', 'warn');
        break;
      case 'room-full':
        rejected = true;
        setStatus('This room already has two people. Rooms are limited to two.', 'error');
        break;
      case 'offer':
      case 'answer':
        if (!pc) await createPeerConnection();
        await handleDescription(msg.sdp);
        break;
      case 'ice-candidate':
        if (!pc) break;
        try {
          await pc.addIceCandidate(msg.candidate);
        } catch (err) {
          if (!ignoreOffer) console.warn('addIceCandidate failed:', err);
        }
        break;
      case 'screen-share':
        // Sent by the sharer just before addTrack, so (WS ordering) the stream
        // id is known here before the renegotiation offer arrives.
        if (msg.on) {
          remoteScreenStreamId = msg.streamId;
        } else {
          remoteScreenStreamId = null;
          clearScreen();
        }
        break;
      case 'chat':
        appendMessage('Them', msg.text);
        break;
    }
  }

  // ---- Local media ----
  startLocalMedia();

  async function startLocalMedia() {
    $('media-error').hidden = true;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      $('local-video').srcObject = localStream;
      addLocalTracks();
    } catch (err) {
      showMediaError(err);
    }
  }

  function showMediaError(err) {
    const box = $('media-error');
    let reason;
    if (err.name === 'NotAllowedError') {
      reason = 'Camera/microphone permission was denied. Allow access in your browser, then try again.';
    } else if (err.name === 'NotFoundError') {
      reason = 'No camera or microphone was found on this device.';
    } else if (err.name === 'NotReadableError') {
      reason = 'Your camera or microphone is in use by another app.';
    } else {
      reason = `Could not start camera/microphone: ${err.message || err.name}`;
    }
    $('media-error-text').textContent = reason;
    box.hidden = false;
  }

  $('retry-media').addEventListener('click', startLocalMedia);

  // ---- Peer connection (perfect negotiation) ----
  // Only called from handleSignal, which is serialized by the inbox queue,
  // so the await cannot double-create the connection.
  async function createPeerConnection() {
    if (pc) return;
    const { iceServers, forceRelay } = await iceConfigPromise;
    pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: forceRelay ? 'relay' : 'all',
    });

    pc.onnegotiationneeded = async () => {
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        signal({ type: pc.localDescription.type, sdp: pc.localDescription });
      } catch (err) {
        console.error('negotiation failed:', err);
      } finally {
        makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) signal({ type: 'ice-candidate', candidate });
    };

    pc.ontrack = ({ streams }) => {
      const stream = streams[0];
      if (!stream) return;
      if (stream.id === remoteScreenStreamId) {
        if ($('screen-video').srcObject !== stream) showScreen(stream, false);
      } else if ($('remote-video').srcObject !== stream) {
        $('remote-video').srcObject = stream;
        tryPlay($('remote-video'));
      }
    };

    pc.onconnectionstatechange = () => {
      switch (pc?.connectionState) {
        case 'connected':
          setStatus('Connected — cameras linked.', 'ok');
          break;
        case 'disconnected':
          setStatus('Connection unstable — trying to recover…', 'warn');
          break;
        case 'failed':
          setStatus('The peer-to-peer connection failed. Both of you may need to refresh.', 'error');
          break;
      }
    };

    addLocalTracks();
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
    ignoreOffer = !polite && offerCollision;
    if (ignoreOffer) return;

    await pc.setRemoteDescription(description);
    if (description.type === 'offer') {
      await pc.setLocalDescription();
      signal({ type: 'answer', sdp: pc.localDescription });
    }
  }

  function teardownPeerConnection() {
    if (pc) {
      pc.close();
      pc = null;
    }
    stopScreenShare(); // pc-null-safe; ends our share when the peer is gone
    remoteScreenStreamId = null;
    clearScreen();
    $('share-screen').disabled = true;
    $('remote-video').srcObject = null;
    $('tap-to-play').hidden = true;
    makingOffer = false;
    ignoreOffer = false;
  }

  // ---- Screen share ----
  $('share-screen').addEventListener('click', () => {
    if (screenStream) stopScreenShare();
    else startScreenShare();
  });

  async function startScreenShare() {
    if (!pc || screenStream) return;
    let stream;
    try {
      // audio:true just adds the browser's "share audio" checkbox to the
      // picker (PRD flow step 4); declining it is fine.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (err) {
      // NotAllowedError = the user cancelled the picker; not an error.
      if (err.name !== 'NotAllowedError') {
        setStatus(`Could not start screen share: ${err.message || err.name}`, 'error');
      }
      return;
    }
    screenStream = stream;
    // Announce the stream id BEFORE addTrack so the watcher can tell the
    // screen apart from the camera when ontrack fires after renegotiation.
    signal({ type: 'screen-share', on: true, streamId: stream.id });
    for (const track of stream.getTracks()) {
      screenSenders.push(pc.addTrack(track, stream)); // fires onnegotiationneeded
    }
    // The browser's own "Stop sharing" bar ends the track outside our UI.
    stream.getVideoTracks()[0].addEventListener('ended', stopScreenShare);
    showScreen(stream, true);
    $('share-screen').textContent = 'Stop sharing';
  }

  function stopScreenShare() {
    if (!screenStream) return;
    signal({ type: 'screen-share', on: false });
    if (pc) {
      for (const sender of screenSenders) {
        try {
          pc.removeTrack(sender); // fires onnegotiationneeded
        } catch {
          // pc may be closing; nothing to undo
        }
      }
    }
    screenSenders = [];
    for (const track of screenStream.getTracks()) track.stop();
    screenStream = null;
    clearScreen();
    $('share-screen').textContent = 'Share screen';
  }

  function showScreen(stream, mine) {
    const sv = $('screen-video');
    sv.muted = mine; // don't echo our own shared audio back at us
    sv.srcObject = stream;
    sv.hidden = false;
    $('videos').classList.add('screen-active');
    tryPlay(sv);
  }

  function clearScreen() {
    const sv = $('screen-video');
    sv.srcObject = null;
    sv.hidden = true;
    $('videos').classList.remove('screen-active');
  }

  // Autoplay with audio can be blocked when the page was opened without a user
  // gesture (the watcher just clicked a link elsewhere). Fail loudly: show a
  // button instead of a silently frozen video.
  async function tryPlay(video) {
    try {
      await video.play();
      $('tap-to-play').hidden = true;
    } catch {
      $('tap-to-play').hidden = false;
    }
  }

  $('tap-to-play').addEventListener('click', () => {
    tryPlay($('remote-video'));
    if (!$('screen-video').hidden) tryPlay($('screen-video'));
  });

  // ---- Relay-test message box (becomes the P1 chat sidebar) ----
  $('send-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('send-input');
    const text = input.value.trim();
    if (!text || ws.readyState !== WebSocket.OPEN) return;
    signal({ type: 'chat', text });
    appendMessage('You', text);
    input.value = '';
  });

  function appendMessage(who, text) {
    const div = document.createElement('div');
    div.className = `msg ${who === 'You' ? 'mine' : 'theirs'}`;
    const label = document.createElement('strong');
    label.textContent = `${who}: `;
    div.append(label, document.createTextNode(text));
    $('messages').append(div);
    $('messages').scrollTop = $('messages').scrollHeight;
  }
}
