// CoWatch client.
// Phase 1: room join + relayed messages.  Phase 2: camera call (perfect
// negotiation).  Phase 3: screen share with mid-session renegotiation.
// Phase 4a: screen-share tuning + partner-cam PiP.  Phase 4b: sync mode
// (YouTube / Vimeo / direct video / TorBox) over the signaling channel.

const $ = (id) => document.getElementById(id);

// ---- Tunables ----
const SCREEN_MAX_BITRATE = 2_500_000; // bps for the shared-screen video sender (Phase 4a) — adjust here
const SCREEN_CONSTRAINTS = {
  // Cap capture at 1080p30 (Phase 4a); the picker's "share audio" checkbox
  // comes from audio:true.
  video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 30 } },
  audio: true,
};
const SYNC_DRIFT_TOLERANCE = 0.75; // seconds — follower seeks if further off than this
const SYNC_SUPPRESS_MS = 800; // echo-suppression window after applying a remote sync event

const UNSUPPORTED_MSG =
  'Sync mode supports YouTube, Vimeo, direct video links, and TorBox magnets. ' +
  'For anything else, use Share screen instead.';

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

// ---- Sync-source detection (Phase 4b) ----
function detectSource(raw) {
  const s = raw.trim();
  if (!s) return null;
  const btih = s.match(/^magnet:\?.*xt=urn:btih:([a-z0-9]{32,40})/i);
  if (btih) return { kind: 'torbox', magnet: s, hash: btih[1].toLowerCase() };
  if (/^[a-f0-9]{40}$/i.test(s)) {
    const hash = s.toLowerCase();
    return { kind: 'torbox', magnet: `magnet:?xt=urn:btih:${hash}`, hash };
  }
  let url;
  try {
    url = new URL(s);
  } catch {
    return { kind: 'unsupported' };
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return id ? { kind: 'youtube', videoId: id, url: s } : { kind: 'unsupported' };
  }
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    const id =
      url.searchParams.get('v') || url.pathname.match(/\/(?:embed|shorts|live)\/([\w-]{6,})/)?.[1];
    return id ? { kind: 'youtube', videoId: id, url: s } : { kind: 'unsupported' };
  }
  if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
    return { kind: 'vimeo', url: s };
  }
  if (/\.(mp4|webm|m3u8)$/i.test(url.pathname)) {
    return { kind: 'video', url: s };
  }
  return { kind: 'unsupported' };
}

// ---- Player adapters (Phase 4b) ----
// Uniform interface: { play, pause, seek(t), getTime()->number|Promise,
// isPaused()->bool|Promise, setRate(r), destroy(), el? }.
// Each adapter calls report(action, time, rate) on LOCAL user actions only;
// the caller handles echo suppression.

let ytApiPromise = null;
function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (!ytApiPromise) {
    ytApiPromise = new Promise((resolve) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (prev) prev();
        resolve();
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.append(s);
    });
  }
  return ytApiPromise;
}

async function createYouTubePlayer(container, videoId, report) {
  await loadYouTubeApi();
  const mount = document.createElement('div');
  container.append(mount);
  let onReady;
  const ready = new Promise((r) => (onReady = r));
  let lastT = 0;
  let lastWall = Date.now();
  const yt = new YT.Player(mount, {
    videoId,
    playerVars: { playsinline: 1, rel: 0 },
    events: {
      onReady: () => onReady(),
      onStateChange: (e) => {
        const t = yt.getCurrentTime();
        if (e.data === YT.PlayerState.PLAYING) report('play', t, yt.getPlaybackRate());
        else if (e.data === YT.PlayerState.PAUSED) report('pause', t, yt.getPlaybackRate());
      },
    },
  });
  await ready;
  // YouTube has no seek event — detect jumps by polling.
  const poll = setInterval(() => {
    if (typeof yt.getCurrentTime !== 'function') return;
    const t = yt.getCurrentTime();
    const wall = Date.now();
    const playing = yt.getPlayerState() === YT.PlayerState.PLAYING;
    const expected = lastT + (playing ? ((wall - lastWall) / 1000) * yt.getPlaybackRate() : 0);
    if (Math.abs(t - expected) > 2) report('seek', t, yt.getPlaybackRate());
    lastT = t;
    lastWall = wall;
  }, 700);
  return {
    play: () => yt.playVideo(),
    pause: () => yt.pauseVideo(),
    seek: (t) => {
      lastT = t; // keep the seek-poll from re-reporting a remote seek
      lastWall = Date.now();
      yt.seekTo(t, true);
    },
    getTime: () => yt.getCurrentTime(),
    isPaused: () => yt.getPlayerState() !== YT.PlayerState.PLAYING,
    setRate: (r) => yt.setPlaybackRate(r),
    destroy: () => {
      clearInterval(poll);
      try {
        yt.destroy();
      } catch {}
    },
  };
}

let vimeoApiPromise = null;
function loadVimeoApi() {
  if (window.Vimeo?.Player) return Promise.resolve();
  if (!vimeoApiPromise) {
    vimeoApiPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://player.vimeo.com/api/player.js';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('could not load the Vimeo SDK'));
      document.head.append(s);
    });
  }
  return vimeoApiPromise;
}

async function createVimeoPlayer(container, url, report) {
  await loadVimeoApi();
  const mount = document.createElement('div');
  container.append(mount);
  const v = new Vimeo.Player(mount, { url });
  await v.ready();
  v.on('play', async () => report('play', await v.getCurrentTime(), 1));
  v.on('pause', async () => report('pause', await v.getCurrentTime(), 1));
  v.on('seeked', (data) => report('seek', data.seconds, 1));
  return {
    play: () => v.play().catch(() => {}),
    pause: () => v.pause().catch(() => {}),
    seek: (t) => v.setCurrentTime(t).catch(() => {}),
    getTime: () => v.getCurrentTime(),
    isPaused: () => v.getPaused(),
    setRate: (r) => v.setPlaybackRate(r).catch(() => {}),
    destroy: () => v.destroy().catch(() => {}),
  };
}

function createNativePlayer(container, url, report, onError, onAutoplayBlocked) {
  const v = document.createElement('video');
  v.controls = true;
  v.playsInline = true;
  v.src = url;
  container.append(v);
  v.addEventListener('play', () => report('play', v.currentTime, v.playbackRate));
  v.addEventListener('pause', () => {
    if (!v.seeking) report('pause', v.currentTime, v.playbackRate);
  });
  v.addEventListener('seeked', () => report('seek', v.currentTime, v.playbackRate));
  v.addEventListener('ratechange', () => report('seek', v.currentTime, v.playbackRate));
  v.addEventListener('error', () => onError?.(v.error));
  return {
    el: v,
    play: () => v.play().catch(() => onAutoplayBlocked?.()),
    pause: () => v.pause(),
    seek: (t) => {
      v.currentTime = t;
    },
    getTime: () => v.currentTime,
    isPaused: () => v.paused,
    setRate: (r) => {
      v.playbackRate = r;
    },
    destroy: () => {
      v.pause();
      v.removeAttribute('src');
      v.remove();
    },
  };
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
  let mode = 'screen'; // 'screen' (Mode A) | 'sync' (Mode B)
  let player = null; // active sync player adapter
  let suppressUntil = 0; // echo suppression for sync events

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
          setMode('screen'); // follow the sharer
        } else {
          remoteScreenStreamId = null;
          clearScreen();
        }
        break;
      case 'sync-load':
        setMode('sync'); // follow the loader
        await handleRemoteLoad(msg.source);
        break;
      case 'sync':
        await applyRemoteSync(msg);
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

  // ---- Mode toggle (Phase 4b) ----
  function setMode(m) {
    if (mode === m) return;
    if (m !== 'screen' && screenStream) stopScreenShare();
    if (m !== 'sync' && player) {
      try {
        player.pause(); // pausing on mode switch is a real user action; let it broadcast
      } catch {}
    }
    mode = m;
    $('mode-screen').classList.toggle('active', m === 'screen');
    $('mode-sync').classList.toggle('active', m === 'sync');
    $('screen-pane').hidden = m !== 'screen';
    $('sync-pane').hidden = m !== 'sync';
  }

  $('mode-screen').addEventListener('click', () => setMode('screen'));
  $('mode-sync').addEventListener('click', () => setMode('sync'));

  // ---- Screen share (Mode A) ----
  $('share-screen').addEventListener('click', () => {
    if (screenStream) stopScreenShare();
    else startScreenShare();
  });

  async function startScreenShare() {
    if (!pc || screenStream) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(SCREEN_CONSTRAINTS);
    } catch (err) {
      // NotAllowedError = the user cancelled the picker; not an error.
      if (err.name !== 'NotAllowedError') {
        setStatus(`Could not start screen share: ${err.message || err.name}`, 'error');
      }
      return;
    }
    screenStream = stream;
    const videoTrack = stream.getVideoTracks()[0];
    videoTrack.contentHint = 'motion'; // favor framerate over sharpness (Phase 4a)
    // Announce the stream id BEFORE addTrack so the watcher can tell the
    // screen apart from the camera when ontrack fires after renegotiation.
    signal({ type: 'screen-share', on: true, streamId: stream.id });
    for (const track of stream.getTracks()) {
      const sender = pc.addTrack(track, stream); // fires onnegotiationneeded
      screenSenders.push(sender);
      if (track.kind === 'video') capSenderBitrate(sender, SCREEN_MAX_BITRATE);
    }
    // The browser's own "Stop sharing" bar ends the track outside our UI.
    videoTrack.addEventListener('ended', stopScreenShare);
    showScreen(stream, true);
    updateShareInfo(videoTrack);
    $('pip-partner').hidden = false;
    $('share-screen').textContent = 'Stop sharing';
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

  function updateShareInfo(track) {
    const settings = track.getSettings ? track.getSettings() : {};
    const names = { browser: 'a browser tab', window: 'an app window', monitor: 'your entire screen' };
    let text = `Sharing ${names[settings.displaySurface] || 'your screen'}`;
    if (settings.width && settings.height) text += ` at ${settings.width}×${settings.height}`;
    text += '.';
    if (settings.displaySurface === 'monitor') {
      text +=
        ' Heads-up: a full-screen share includes everything on that screen — including the popped-out ' +
        'partner cam. Share the video tab instead to keep it (and the rest of your screen) out of the feed.';
    }
    $('share-info').textContent = text;
    $('share-info').hidden = false;
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
    $('share-info').hidden = true;
    $('pip-partner').hidden = true;
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    $('share-screen').textContent = 'Share screen';
  }

  function showScreen(stream, mine) {
    const sv = $('screen-video');
    sv.muted = mine; // don't echo our own shared audio back at us
    sv.srcObject = stream;
    sv.hidden = false;
    $('main-placeholder').hidden = true;
    tryPlay(sv);
  }

  function clearScreen() {
    const sv = $('screen-video');
    sv.srcObject = null;
    sv.hidden = true;
    $('main-placeholder').hidden = false;
  }

  // Pop the PARTNER'S camera into a floating always-on-top window so the
  // sharer still sees their friend while a fullscreen video plays. A tab or
  // window share never captures it; a monitor share inherently would.
  $('pip-partner').addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return;
      }
      await $('remote-video').requestPictureInPicture();
    } catch (err) {
      setStatus(`Picture-in-picture failed: ${err.message || err.name}`, 'warn');
    }
  });

  // ---- Sync mode (Mode B) ----
  const syncStatus = (text, kind = '') => {
    $('sync-status').textContent = text;
    $('sync-status').className = `hint ${kind}`;
  };

  $('torbox-key').value = localStorage.getItem('torbox_api_key') || '';
  $('torbox-key').addEventListener('change', () => {
    localStorage.setItem('torbox_api_key', $('torbox-key').value.trim());
  });

  $('sync-form').addEventListener('submit', (e) => {
    e.preventDefault();
    loadFromInput($('sync-input').value);
  });

  async function loadFromInput(raw) {
    const source = detectSource(raw);
    if (!source) return;
    if (source.kind === 'unsupported') {
      syncStatus(UNSUPPORTED_MSG, 'warn');
      return;
    }
    if (source.kind === 'torbox') {
      const resolved = await resolveTorbox(source);
      if (!resolved) return; // status already explains why
      source.resolvedUrl = resolved;
    }
    await loadSource(source);
    // Share the source; for TorBox the peer prefers resolving the magnet
    // with their own key (IP-locked links), falling back to our URL.
    signal({ type: 'sync-load', source });
  }

  async function handleRemoteLoad(source) {
    if (source.kind === 'torbox') {
      const myKey = (localStorage.getItem('torbox_api_key') || '').trim();
      if (myKey) {
        syncStatus('Your friend loaded a TorBox video — resolving it with your own account…');
        const mine = await resolveTorbox(source);
        if (mine) {
          await loadSource({ ...source, resolvedUrl: mine });
          return;
        }
        // fall through to their URL (may be IP-locked; the player error explains)
      }
      if (source.resolvedUrl) {
        await loadSource(source);
        return;
      }
      syncStatus('Enter your TorBox API key to resolve magnets (TorBox settings below).', 'warn');
      $('torbox-settings').open = true;
      return;
    }
    await loadSource(source);
  }

  async function loadSource(source) {
    destroyPlayer();
    const container = $('sync-player');
    const report = (action, time, rate) => {
      if (Date.now() < suppressUntil) return;
      signal({ type: 'sync', action, time: time ?? 0, rate: rate ?? 1 });
    };
    try {
      if (source.kind === 'youtube') {
        syncStatus('Loading YouTube player…');
        player = await createYouTubePlayer(container, source.videoId, report);
        syncStatus('YouTube loaded — play, pause, and seek sync automatically.', 'ok');
      } else if (source.kind === 'vimeo') {
        syncStatus('Loading Vimeo player…');
        player = await createVimeoPlayer(container, source.url, report);
        syncStatus('Vimeo loaded — play, pause, and seek sync automatically.', 'ok');
      } else {
        const url = source.kind === 'torbox' ? source.resolvedUrl : source.url;
        const onError = () => {
          if (source.kind === 'torbox') {
            syncStatus(
              'This link requires your own TorBox account — paste the same link in your app to sync.',
              'error'
            );
          } else {
            syncStatus(
              'Could not load this video — the host may block cross-site playback (CORS) or the format is unsupported.',
              'error'
            );
          }
        };
        player = createNativePlayer(container, url, report, onError, () => {
          $('tap-to-play').hidden = false;
        });
        syncStatus(
          source.kind === 'torbox'
            ? 'TorBox video loaded — play, pause, and seek sync automatically.'
            : 'Video loaded — play, pause, and seek sync automatically.',
          'ok'
        );
      }
      $('resync').disabled = false;
    } catch (err) {
      syncStatus(`Could not load: ${err.message || err}`, 'error');
    }
  }

  function destroyPlayer() {
    if (player) {
      try {
        player.destroy();
      } catch {}
      player = null;
    }
    $('sync-player').replaceChildren();
    $('resync').disabled = true;
  }

  async function applyRemoteSync(msg) {
    if (!player) return;
    suppressUntil = Date.now() + SYNC_SUPPRESS_MS;
    const t = typeof msg.time === 'number' ? msg.time : 0;
    try {
      if (msg.rate) player.setRate?.(msg.rate);
      if (msg.action === 'play') {
        const cur = await player.getTime();
        if (Math.abs(cur - t) > SYNC_DRIFT_TOLERANCE) player.seek(t);
        await player.play();
      } else if (msg.action === 'pause') {
        await player.pause();
        const cur = await player.getTime();
        if (Math.abs(cur - t) > SYNC_DRIFT_TOLERANCE) player.seek(t);
      } else if (msg.action === 'seek') {
        player.seek(t);
      }
    } catch (err) {
      console.warn('applying remote sync failed:', err);
    }
    suppressUntil = Date.now() + SYNC_SUPPRESS_MS; // extend past the async work above
  }

  $('resync').addEventListener('click', async () => {
    if (!player) return;
    try {
      const time = await player.getTime();
      const paused = await player.isPaused();
      signal({ type: 'sync', action: 'seek', time, rate: 1 });
      signal({ type: 'sync', action: paused ? 'pause' : 'play', time, rate: 1 });
      syncStatus('Resync sent — your friend jumps to your position.', 'ok');
    } catch (err) {
      syncStatus(`Resync failed: ${err.message || err}`, 'error');
    }
  });

  // ---- TorBox resolution (via the server's CORS proxy) ----
  async function torboxPost(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    try {
      return await res.json();
    } catch {
      return { success: false, detail: `unexpected response (HTTP ${res.status})` };
    }
  }

  async function resolveTorbox(source) {
    const apiKey = (localStorage.getItem('torbox_api_key') || '').trim();
    if (!apiKey) {
      syncStatus('Enter your TorBox API key to resolve magnets (TorBox settings below).', 'warn');
      $('torbox-settings').open = true;
      return null;
    }
    try {
      syncStatus('Checking TorBox cache…');
      const cc = await torboxPost('/torbox/checkcached', { apiKey, hashes: [source.hash] });
      if (cc?.success === false && cc?.detail) throw new Error(cc.detail);
      const entry = cc?.data?.[source.hash] || null;

      // Add the torrent to the account either way — for uncached torrents this
      // is what makes TorBox start downloading.
      const ct = await torboxPost('/torbox/createtorrent', { apiKey, magnet: source.magnet });
      const torrentId = ct?.data?.torrent_id ?? ct?.data?.id;
      if (!entry) {
        syncStatus('Not cached — TorBox will download it first. Check back later.', 'warn');
        return null;
      }
      if (!torrentId) throw new Error(ct?.detail || 'TorBox did not return a torrent id');

      // Prefer the largest video file when the cache info lists files.
      const files = Array.isArray(entry.files) ? entry.files : [];
      const videoFile = files
        .filter((f) => /\.(mp4|mkv|webm|m4v|mov|avi)$/i.test(f?.name || f?.short_name || ''))
        .sort((a, b) => (b?.size || 0) - (a?.size || 0))[0];

      syncStatus('Cached — requesting download link…');
      const dl = await torboxPost('/torbox/requestdl', {
        apiKey,
        torrent_id: torrentId,
        file_id: videoFile?.id,
      });
      const url = typeof dl?.data === 'string' ? dl.data : dl?.data?.url;
      if (!url) throw new Error(dl?.detail || 'TorBox did not return a download URL');
      syncStatus('TorBox link resolved.', 'ok');
      return url;
    } catch (err) {
      syncStatus(`TorBox error: ${err.message || err}`, 'error');
      return null;
    }
  }

  // ---- Autoplay recovery ----
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
    if (player?.el) tryPlay(player.el);
  });

  // ---- Chat ----
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

  // Dev/debug handle (also used by automated smoke tests).
  window.__cowatch = {
    get pc() {
      return pc;
    },
    get player() {
      return player;
    },
    get mode() {
      return mode;
    },
  };
}
