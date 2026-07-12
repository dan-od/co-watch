// CoWatch client.
// Phase 1: room join + relayed messages.  Phase 2: camera call (perfect
// negotiation).  Phase 3: screen share with mid-session renegotiation.
// Phase 4a: screen-share tuning + tab-capture self-exclude.  Phase 4b: sync
// mode (YouTube / Vimeo / direct video / TorBox).  Phase 4c: single-window
// restyle + Document Picture-in-Picture companion.

const $ = (id) => document.getElementById(id);

// ---- Tunables ----
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
    location.href = `/r/${randomRoomId()}`;
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
// Uniform interface: { play, pause, seek(t), getTime(), isPaused(), setRate(r),
// destroy(), el? }. Each adapter calls report(action, time, rate) on LOCAL
// user actions only; the caller handles echo suppression.

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
      lastT = t;
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
  $('room-link').value = location.href;

  // These three nodes get relocated into the Document PiP window, where
  // document.getElementById (main doc) can no longer find them — hold stable
  // references and use them everywhere instead of re-querying by id.
  const elRemote = $('remote-video');
  const elMessages = $('messages');
  const elSendForm = $('send-form');

  $('copy-link').addEventListener('click', async () => {
    await navigator.clipboard.writeText(location.href);
    $('copy-link').textContent = 'Copied';
    setTimeout(() => ($('copy-link').textContent = 'Copy'), 1500);
  });

  // ---- Status (top bar) + notice (stage overlay) ----
  const setStatus = (text, kind = '') => {
    $('status').textContent = text;
    $('status-dot').className = kind;
  };
  let noticeTimer = null;
  const notice = (text, kind = '', autoHideMs = 0) => {
    clearTimeout(noticeTimer);
    if (!text) {
      $('notice').hidden = true;
      return;
    }
    $('notice').textContent = text;
    $('notice').className = `notice ${kind}`;
    $('notice').hidden = false;
    if (autoHideMs) noticeTimer = setTimeout(() => ($('notice').hidden = true), autoHideMs);
  };

  // ---- State ----
  const iceConfigPromise = fetchIceConfig();
  let peerPresent = false;
  let polite = false;
  let rejected = false;
  let localStream = null;
  let pc = null;
  let makingOffer = false;
  let ignoreOffer = false;
  let screenStream = null;
  let screenSenders = [];
  let remoteScreenStreamId = null;
  let mode = 'screen'; // 'screen' | 'sync'
  let sourceMode = 'url'; // 'url' | 'torbox'
  let player = null;
  let suppressUntil = 0;
  let peerLeftGraceTimer = null; // peer-left may be a signaling blip; delay teardown
  let iceRestartTimer = null;
  let netSignaling = 'connecting'; // 'connecting' | 'connected' | 'reconnecting'
  let shareBaton = 'free'; // 'free' | 'mine' | 'peer' — one active sharer, server-arbitrated

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
      signal({ type: 'join', room: roomId }); // server replies with 'room-state'
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
    setStatus(`Reconnecting… (attempt ${reconnectAttempts})`, 'warn');
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

  connectWs();

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
          if (screenStream) stopScreenShare(); // converge: server says peer holds it
        } else if (msg.shareHolder === 'you') {
          shareBaton = 'mine';
        } else if (screenStream) {
          // Still capturing but the server forgot us (our socket died
          // mid-share) — re-claim the baton.
          shareBaton = 'free';
          signal({ type: 'share-claim' });
        } else {
          shareBaton = 'free';
        }

        if (peerPresent) {
          setStatus(mode === 'sync' ? 'Synced' : 'Connected', 'ok');
          await ensureHealthyPc();
        } else if (pc && pc.connectionState === 'connected') {
          // Peer's socket dropped but P2P media still flows — likely just a
          // signaling blip on their side. Grace window before teardown.
          setStatus('Your friend disconnected — waiting for them to return…', 'warn');
          peerLeftGraceTimer = setTimeout(() => {
            peerLeftGraceTimer = null;
            if (!peerPresent) {
              teardownPeerConnection();
              setStatus('Your friend left — waiting for them to rejoin…', 'warn');
            }
          }, 12_000);
        } else {
          // Alone with a dead (or no) peer connection — clean up rather than
          // leaving a zombie pc endlessly attempting ICE restarts.
          if (pc) teardownPeerConnection();
          setStatus('Waiting for your friend…');
        }
        updateShareButton();
        break;
      }
      case 'room-full':
        rejected = true;
        setStatus('Room is full (two people max).', 'error');
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
        if (msg.on) {
          remoteScreenStreamId = msg.streamId;
          shareBaton = 'peer'; // belt & braces alongside room-state
          updateShareButton();
          setMode('screen');
        } else {
          remoteScreenStreamId = null;
          clearScreen();
        }
        break;
      case 'share-granted':
        shareBaton = 'mine';
        updateShareButton();
        // Not awaited: the picker can stay open for many seconds and must not
        // block the inbox queue (ICE candidates, offers…).
        startScreenShare().then(() => {
          if (!screenStream) {
            // Picker cancelled or capture failed — hand the baton back.
            shareBaton = 'free';
            signal({ type: 'share-release' });
            updateShareButton();
          }
        });
        break;
      case 'share-denied':
        shareBaton = 'peer';
        notice('Your friend is already sharing.', 'warn', 4000);
        updateShareButton();
        break;
      case 'sync-load':
        setMode('sync');
        await handleRemoteLoad(msg.source);
        break;
      case 'sync':
        await applyRemoteSync(msg);
        break;
      case 'reaction':
        showReaction(msg.emoji); // validated against the preset list inside
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
      if (pttOn) setMicEnabled(pttSpeaking); // a re-acquired mic honors PTT state
      syncToggleButtons();
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
      } else if (elRemote.srcObject !== stream) {
        elRemote.srcObject = stream;
        tryPlay(elRemote);
      }
    };

    pc.onconnectionstatechange = () => {
      switch (pc?.connectionState) {
        case 'connected':
          if (peerPresent) setStatus(mode === 'sync' ? 'Synced' : 'Connected', 'ok');
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
      if (!peerPresent) {
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
    ignoreOffer = !polite && offerCollision;
    if (ignoreOffer) return;
    await pc.setRemoteDescription(description);
    if (description.type === 'offer') {
      await pc.setLocalDescription();
      signal({ type: 'answer', sdp: pc.localDescription });
    }
  }

  function teardownPeerConnection() {
    clearTimeout(iceRestartTimer);
    iceRestartTimer = null;
    if (pc) {
      pc.close();
      pc = null;
    }
    stopScreenShare();
    setSwapped(false); // a dead partner cam shouldn't own the stage
    remoteScreenStreamId = null;
    clearScreen();
    updateShareButton();
    elRemote.srcObject = null;
    $('tap-to-play').hidden = true;
    makingOffer = false;
    ignoreOffer = false;
  }

  // ---- Mode toggle ----
  function setMode(m) {
    if (mode === m) return;
    if (m !== 'screen' && screenStream) stopScreenShare();
    if (m !== 'sync' && player) {
      try {
        player.pause();
      } catch {}
    }
    mode = m;
    $('mode-screen').classList.toggle('active', m === 'screen');
    $('mode-sync').classList.toggle('active', m === 'sync');
    $('screen-pane').hidden = m !== 'screen';
    $('sync-pane').hidden = m !== 'sync';
    $('action-share').hidden = m !== 'screen';
    $('action-sync').hidden = m !== 'sync';
    if (peerPresent) setStatus(m === 'sync' ? 'Synced' : 'Connected', 'ok');
  }

  $('mode-screen').addEventListener('click', () => setMode('screen'));
  $('mode-sync').addEventListener('click', () => setMode('sync'));

  // ---- Screen share (Mode A) ----
  // Symmetric: either side may share, one at a time. Clicking Share claims the
  // baton from the server; capture starts only on share-granted.
  function updateShareButton() {
    const btn = $('share-screen');
    if (screenStream) {
      btn.disabled = false;
      btn.textContent = 'Stop sharing';
      btn.title = '';
    } else if (shareBaton === 'peer') {
      btn.disabled = true;
      btn.textContent = 'Partner is sharing';
      btn.title = 'Only one person can share at a time';
    } else {
      btn.disabled = !peerPresent;
      btn.textContent = 'Share a tab';
      btn.title = peerPresent ? '' : 'Available once your friend joins';
    }
  }

  $('share-screen').addEventListener('click', () => {
    if (screenStream) {
      stopScreenShare();
      return;
    }
    if (shareBaton === 'peer' || !peerPresent) return;
    signal({ type: 'share-claim' }); // reply arrives as share-granted / share-denied
  });

  async function startScreenShare() {
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
    if (shareBaton === 'mine') {
      shareBaton = 'free';
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

  // ---- Sync mode (Mode B) ----
  const spinner = (on) => ($('sync-spinner').hidden = !on);

  // Source toggle (URL / TorBox / metadata Search)
  function setSourceMode(m) {
    sourceMode = m;
    $('source-url').classList.toggle('active', m === 'url');
    $('source-torbox').classList.toggle('active', m === 'torbox');
    $('source-search').classList.toggle('active', m === 'search');
    $('sync-input').placeholder =
      m === 'torbox'
        ? 'Magnet link or 40-char torrent hash'
        : m === 'search'
          ? 'Search for a movie or show…'
          : 'YouTube / Vimeo / .mp4 URL';
    $('sync-load').textContent = m === 'search' ? 'Search' : 'Load';
    $('file-select').hidden = true;
    $('search-panel').hidden = m !== 'search';
    if (m === 'search') checkTmdbKey();
  }
  $('source-url').addEventListener('click', () => setSourceMode('url'));
  $('source-torbox').addEventListener('click', () => setSourceMode('torbox'));
  $('source-search').addEventListener('click', () => setSourceMode('search'));

  $('sync-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = $('sync-input').value.trim();
    if (!raw) return;
    if (sourceMode === 'search') runSearch(raw);
    else if (sourceMode === 'torbox') loadTorbox(raw);
    else loadFromUrl(raw);
  });

  async function loadFromUrl(raw) {
    const source = detectSource(raw);
    if (!source) return;
    if (source.kind === 'unsupported') {
      notice(UNSUPPORTED_MSG, 'warn');
      return;
    }
    if (source.kind === 'torbox') {
      // A magnet pasted in URL mode: honor it via the TorBox flow.
      setSourceMode('torbox');
      loadTorbox(raw);
      return;
    }
    currentTorrentSubs = null; // URL sources carry no torrent subtitle files
    await loadSource(source);
    signal({ type: 'sync-load', source });
  }

  async function handleRemoteLoad(source) {
    if (source.kind === 'torbox') {
      const myKey = (localStorage.getItem('torbox_api_key') || '').trim();
      if (myKey) {
        notice('Your friend loaded a TorBox video — resolving with your own account…');
        const mine = await resolveTorbox(source.magnet, source.hash, source.fileName);
        if (mine) {
          await loadSource({ ...source, resolvedUrl: mine });
          showKnownMeta(source.hash);
          return;
        }
      }
      if (source.resolvedUrl) {
        currentTorrentSubs = null; // no key -> we can't fetch this torrent's sub files
        await loadSource(source);
        showKnownMeta(source.hash);
        return;
      }
      notice('Enter your TorBox API key (gear icon) to watch this.', 'warn');
      openSettings(true);
      return;
    }
    await loadSource(source);
  }

  async function loadSource(source) {
    destroyPlayer();
    const container = $('sync-player');
    $('sync-placeholder').hidden = true;
    const report = (action, time, rate) => {
      if (Date.now() < suppressUntil) return;
      signal({ type: 'sync', action, time: time ?? 0, rate: rate ?? 1 });
    };
    try {
      if (source.kind === 'youtube') {
        notice('Loading YouTube…');
        player = await createYouTubePlayer(container, source.videoId, report);
        notice('YouTube loaded — play/pause/seek stay in sync.', 'ok', 4000);
      } else if (source.kind === 'vimeo') {
        notice('Loading Vimeo…');
        player = await createVimeoPlayer(container, source.url, report);
        notice('Vimeo loaded — play/pause/seek stay in sync.', 'ok', 4000);
      } else {
        const url = source.kind === 'torbox' ? source.resolvedUrl : source.url;
        const onError = () =>
          notice(
            source.kind === 'torbox'
              ? 'This link requires your own TorBox account — paste the same magnet after adding your key.'
              : 'Could not load this video — the host may block cross-site playback (CORS) or the format is unsupported.',
            'error'
          );
        player = createNativePlayer(container, url, report, onError, () => ($('tap-to-play').hidden = false));
        notice('Video loaded — play/pause/seek stay in sync.', 'ok', 4000);
      }
      $('resync').disabled = false;
      $('tracks-btn').hidden = !player?.el; // subtitles/audio only on the native player
    } catch (err) {
      notice(`Could not load: ${err.message || err}`, 'error');
      $('sync-placeholder').hidden = false;
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
    $('tracks-btn').hidden = true;
    $('tracks-panel').hidden = true;
    for (const u of subBlobUrls) URL.revokeObjectURL(u);
    subBlobUrls = [];
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
    suppressUntil = Date.now() + SYNC_SUPPRESS_MS;
  }

  $('resync').addEventListener('click', async () => {
    if (!player) return;
    try {
      const time = await player.getTime();
      const paused = await player.isPaused();
      signal({ type: 'sync', action: 'seek', time, rate: 1 });
      signal({ type: 'sync', action: paused ? 'pause' : 'play', time, rate: 1 });
      notice('Resync sent — your friend jumps to your spot.', 'ok', 3000);
    } catch (err) {
      notice(`Resync failed: ${err.message || err}`, 'error');
    }
  });

  // ---- TorBox ----
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

  function getKey() {
    return (localStorage.getItem('torbox_api_key') || '').trim();
  }

  // Load a magnet/hash entered locally: fetch metadata → pick/confirm file →
  // resolve stream URL → play → broadcast.
  async function loadTorbox(raw) {
    const src = detectSource(raw);
    if (!src || src.kind !== 'torbox') {
      notice('Invalid magnet link or torrent hash.', 'error');
      return;
    }
    const apiKey = getKey();
    if (!apiKey) {
      notice('Enter your TorBox API key (gear icon) to resolve magnets.', 'warn');
      openSettings(true);
      return;
    }
    spinner(true);
    notice('Fetching torrent…');
    try {
      const meta = await torboxPost('/torbox/fetch', { apiKey, magnet: src.magnet, hash: src.hash });
      if (!meta?.success) {
        notice(`TorBox: ${meta?.detail || 'could not fetch torrent'}`, 'error');
        return;
      }
      const videos = (meta.files || []).filter((f) =>
        /\.(mp4|mkv|webm|m4v|mov|avi)$/i.test(f.name || '')
      );
      if (!videos.length) {
        notice(
          meta.finished || meta.cached
            ? 'No video files in this torrent.'
            : 'Not cached — TorBox is downloading it first. Check back later.',
          'warn'
        );
        return;
      }
      setTorrentSubs(meta); // remember .srt/.vtt files for the CC panel
      // File dropdown; default to the largest video.
      videos.sort((a, b) => (b.size || 0) - (a.size || 0));
      populateFileSelect(videos, meta.torrentId, src);
      await loadTorboxFile(meta.torrentId, videos[0].id, src, videos[0].name);
    } catch (err) {
      notice(`TorBox error: ${err.message || err}`, 'error');
    } finally {
      spinner(false);
    }
  }

  function populateFileSelect(videos, torrentId, src) {
    const sel = $('file-select');
    sel.replaceChildren();
    for (const f of videos) {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = `${f.name} (${(f.size / 1e9).toFixed(2)} GB)`;
      opt.dataset.name = f.name;
      sel.append(opt);
    }
    sel.hidden = false;
    sel.onchange = () => {
      const opt = sel.selectedOptions[0];
      loadTorboxFile(torrentId, sel.value, src, opt?.dataset.name);
    };
  }

  async function loadTorboxFile(torrentId, fileId, src, fileName) {
    spinner(true);
    notice('Loading file…');
    try {
      const dl = await torboxPost('/torbox/load', { apiKey: getKey(), torrentId, fileId });
      if (!dl?.success || !dl.streamUrl) {
        notice(`TorBox: ${dl?.detail || 'could not get stream URL'}`, 'error');
        return;
      }
      const source = {
        kind: 'torbox',
        magnet: src.magnet,
        hash: src.hash,
        fileName,
        resolvedUrl: dl.streamUrl,
      };
      await loadSource(source);
      rememberHashMeta(src.hash); // ties the hash to the last-selected search result
      showKnownMeta(src.hash);
      signal({ type: 'sync-load', source });
    } catch (err) {
      notice(`TorBox error: ${err.message || err}`, 'error');
    } finally {
      spinner(false);
    }
  }

  // Resolve a magnet with THIS user's key (used when following a peer's load,
  // since TorBox stream URLs are IP-locked). Returns a stream URL or null.
  async function resolveTorbox(magnet, hash, preferName) {
    const apiKey = getKey();
    if (!apiKey) return null;
    try {
      const meta = await torboxPost('/torbox/fetch', { apiKey, magnet, hash });
      if (!meta?.success) return null;
      const videos = (meta.files || []).filter((f) => /\.(mp4|mkv|webm|m4v|mov|avi)$/i.test(f.name || ''));
      if (!videos.length) return null;
      setTorrentSubs(meta); // remember .srt/.vtt files for the CC panel
      const pick =
        videos.find((f) => f.name === preferName) ||
        videos.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
      const dl = await torboxPost('/torbox/load', { apiKey, torrentId: meta.torrentId, fileId: pick.id });
      return dl?.success ? dl.streamUrl : null;
    } catch {
      return null;
    }
  }

  // ---- Subtitles & audio tracks (native player only) ----
  // Per-person presentation: each side picks their own language; nothing is
  // synced. Subtitle sources: a local .srt/.vtt file, or .srt/.vtt files that
  // ship inside the torrent the user already loaded (fetched through the
  // server because the TorBox CDN is not CORS-open). Audio switching uses the
  // audioTracks API where the browser exposes it (Safari yes, Chrome no).
  let currentTorrentSubs = null; // { torrentId, files: [{id, name}] }
  let subBlobUrls = [];

  function setTorrentSubs(meta) {
    const subs = (meta?.files || []).filter((f) => /\.(srt|vtt)$/i.test(f?.name || ''));
    currentTorrentSubs = subs.length ? { torrentId: meta.torrentId, files: subs } : null;
  }

  function srtToVtt(text) {
    const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const body = noBom.replace(/\r/g, '');
    if (/^WEBVTT/.test(body)) return body;
    return 'WEBVTT\n\n' + body.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  }

  function addSubtitleTrack(label, vttText) {
    if (!player?.el) return;
    const url = URL.createObjectURL(new Blob([vttText], { type: 'text/vtt' }));
    subBlobUrls.push(url);
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = label;
    track.src = url;
    player.el.append(track);
    selectSubtitle(player.el.textTracks.length - 1); // show the newest track
  }

  function selectSubtitle(index) {
    // index -1 = off
    const tracks = player?.el?.textTracks;
    if (!tracks) return;
    for (let i = 0; i < tracks.length; i++) tracks[i].mode = i === index ? 'showing' : 'disabled';
    renderTracksPanel();
  }

  function selectAudio(index) {
    const tracks = player?.el?.audioTracks;
    if (!tracks) return;
    for (let i = 0; i < tracks.length; i++) tracks[i].enabled = i === index;
    renderTracksPanel();
  }

  function radioRow(group, label, checked, onPick) {
    const row = document.createElement('label');
    row.className = 'track-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = `track-${group}`;
    input.checked = checked;
    input.addEventListener('change', onPick);
    const name = document.createElement('span');
    name.className = 'track-name';
    name.textContent = label;
    row.append(input, name);
    return row;
  }

  function renderTracksPanel() {
    const el = player?.el;

    const subList = $('sub-list');
    subList.replaceChildren();
    const tracks = el?.textTracks || [];
    const anyShowing = [...tracks].some((t) => t.mode === 'showing');
    subList.append(radioRow('subs', 'Off', !anyShowing, () => selectSubtitle(-1)));
    [...tracks].forEach((t, i) => {
      subList.append(radioRow('subs', t.label || `Track ${i + 1}`, t.mode === 'showing', () => selectSubtitle(i)));
    });

    const torrentBox = $('torrent-subs');
    torrentBox.replaceChildren();
    if (currentTorrentSubs) {
      const h = document.createElement('p');
      h.className = 'hint';
      h.textContent = 'From this torrent:';
      torrentBox.append(h);
      for (const f of currentTorrentSubs.files) {
        const row = document.createElement('div');
        row.className = 'track-row';
        const name = document.createElement('span');
        name.className = 'track-name';
        name.textContent = f.name.split('/').pop();
        name.title = f.name;
        const btn = document.createElement('button');
        btn.className = 'ghost';
        btn.textContent = 'Load';
        btn.addEventListener('click', () => loadTorrentSub(f, btn));
        row.append(name, btn);
        torrentBox.append(row);
      }
    }

    const audioList = $('audio-list');
    audioList.replaceChildren();
    const at = el?.audioTracks;
    const hint = (text) => {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = text;
      audioList.append(p);
    };
    if (!at) {
      hint("This browser doesn't expose embedded audio tracks (Safari does; Chrome hides them).");
    } else if (at.length <= 1) {
      hint('Only one audio track in this video.');
    } else {
      for (let i = 0; i < at.length; i++) {
        audioList.append(
          radioRow('audio', at[i].label || at[i].language || `Track ${i + 1}`, at[i].enabled, () => selectAudio(i))
        );
      }
    }
  }

  async function loadTorrentSub(f, btn) {
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const r = await torboxPost('/torbox/subfile', {
        apiKey: getKey(),
        torrentId: currentTorrentSubs.torrentId,
        fileId: f.id,
      });
      if (!r?.success) throw new Error(r?.detail || 'could not fetch subtitle');
      addSubtitleTrack(f.name.split('/').pop(), srtToVtt(r.text));
      notice(`Subtitles loaded: ${f.name.split('/').pop()}`, 'ok', 3000);
    } catch (err) {
      notice(`Subtitle failed: ${err.message || err}`, 'error', 5000);
      btn.disabled = false;
      btn.textContent = 'Load';
    }
  }

  $('tracks-btn').addEventListener('click', () => {
    const show = $('tracks-panel').hidden;
    if (show) renderTracksPanel();
    $('tracks-panel').hidden = !show;
  });
  document.addEventListener('click', (e) => {
    if (
      !$('tracks-panel').hidden &&
      !$('tracks-panel').contains(e.target) &&
      !$('tracks-btn').contains(e.target)
    ) {
      $('tracks-panel').hidden = true;
    }
  });

  $('sub-from-file').addEventListener('click', () => $('sub-file-input').click());
  $('sub-file-input').addEventListener('change', async () => {
    const file = $('sub-file-input').files[0];
    if (!file) return;
    addSubtitleTrack(file.name, srtToVtt(await file.text()));
    notice(`Subtitles loaded: ${file.name}`, 'ok', 3000);
    $('sub-file-input').value = '';
  });

  // ---- Metadata search + watchlist (Phase 4e) ----
  // TMDb metadata browsing only (posters, ratings, overviews). Watching still
  // requires the user to paste their own URL or magnet in URL/TorBox mode —
  // nothing here fetches, resolves, or discovers content.
  const WATCHLIST_KEY = 'watchlist';
  const HASH_META_KEY = 'hash_meta'; // magnet hash -> saved metadata
  let lastSelectedMeta = null; // most recently opened search result

  const getTmdbKey = () => (localStorage.getItem('tmdb_api_key') || '').trim();

  function searchStatus(text, kind = '') {
    $('search-status').textContent = text;
    $('search-status').className = `hint ${kind}`;
  }

  function checkTmdbKey() {
    if (!getTmdbKey()) {
      searchStatus('Enter your TMDb API key (gear icon) to search metadata.', 'warn');
    } else if (!$('search-results').childElementCount) {
      searchStatus('Search for a movie or show to see posters and details.');
    }
  }

  async function runSearch(query) {
    if (!getTmdbKey()) {
      searchStatus('Enter your TMDb API key (gear icon) to search metadata.', 'warn');
      openSettings(true);
      return;
    }
    $('search-detail').hidden = true;
    $('watchlist-toggle').classList.remove('active');
    searchStatus('Searching…');
    spinner(true);
    try {
      const p = new URLSearchParams({ query, type: $('search-type').value });
      const year = $('search-year').value.trim();
      if (year) p.set('year', year);
      const res = await fetch(`/api/tmdb/search?${p}`, { headers: { 'x-tmdb-key': getTmdbKey() } });
      const data = await res.json().catch(() => null);
      if (!data?.success) {
        searchStatus(`Search failed: ${data?.detail || `HTTP ${res.status}`}`, 'error');
        return;
      }
      if (!data.data.length) {
        $('search-results').replaceChildren();
        searchStatus('No results — try different keywords or drop the year.', 'warn');
        return;
      }
      renderCards(data.data, { watchlist: false });
      searchStatus(`${data.data.length} results — click one for details.`, 'ok');
    } catch (err) {
      searchStatus(`Search failed: ${err.message || err}`, 'error');
    } finally {
      spinner(false);
    }
  }

  function posterEl(item, width) {
    if (item.poster_path) {
      const img = document.createElement('img');
      img.src = `https://image.tmdb.org/t/p/w${width}${item.poster_path}`;
      img.alt = item.title;
      img.loading = 'lazy';
      return img;
    }
    const div = document.createElement('div');
    div.className = 'no-poster';
    div.textContent = 'No poster';
    return div;
  }

  function renderCards(items, { watchlist }) {
    const grid = $('search-results');
    grid.replaceChildren();
    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'result-card';
      card.append(posterEl(item, 200));
      const body = document.createElement('div');
      body.className = 'card-body';
      const h = document.createElement('h4');
      h.textContent = item.title;
      h.title = item.title;
      const meta = document.createElement('span');
      meta.className = 'card-meta';
      meta.textContent = `${item.year || '—'} · ${item.type === 'movie' ? 'Movie' : 'TV'}`;
      const rating = document.createElement('span');
      rating.className = 'card-rating';
      rating.textContent = item.vote_average ? `★ ${item.vote_average.toFixed(1)}` : '';
      const btn = document.createElement('button');
      btn.textContent = watchlist ? 'Details' : 'Select';
      btn.addEventListener('click', () => showDetail(item));
      body.append(h, meta, rating, btn);
      if (watchlist) {
        const rm = document.createElement('button');
        rm.className = 'ghost';
        rm.textContent = 'Remove';
        rm.addEventListener('click', () => {
          saveWatchlist(loadWatchlist().filter((w) => !(w.id === item.id && w.type === item.type)));
          renderWatchlist();
        });
        body.append(rm);
      }
      card.append(body);
      grid.append(card);
    }
  }

  function showDetail(item) {
    lastSelectedMeta = {
      id: item.id,
      type: item.type,
      title: item.title,
      year: item.year,
      poster_path: item.poster_path,
      vote_average: item.vote_average,
    };
    const box = $('search-detail');
    box.replaceChildren();
    box.append(posterEl(item, 342));
    const body = document.createElement('div');
    body.className = 'detail-body';
    const h = document.createElement('h3');
    h.textContent = `${item.title}${item.year ? ` (${item.year})` : ''}`;
    const meta = document.createElement('span');
    meta.className = 'detail-meta';
    meta.textContent = `${item.type === 'movie' ? 'Movie' : 'TV show'}${
      item.vote_average ? ` · ★ ${item.vote_average.toFixed(1)} / 10` : ''
    }`;
    const overview = document.createElement('p');
    overview.className = 'detail-overview';
    overview.textContent = item.overview || 'No overview available.';
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent =
      'To watch it together, paste your own link or magnet using the URL or TorBox source below.';
    const actions = document.createElement('div');
    actions.className = 'detail-actions';
    const toPaste = document.createElement('button');
    toPaste.className = 'primary';
    toPaste.textContent = 'Go to paste (TorBox)';
    toPaste.addEventListener('click', () => {
      box.hidden = true;
      setSourceMode('torbox');
      $('sync-input').value = '';
      $('sync-input').focus();
    });
    const save = document.createElement('button');
    const listed = loadWatchlist().some((w) => w.id === item.id && w.type === item.type);
    save.textContent = listed ? 'In watchlist ✓' : 'Save to watchlist';
    save.disabled = listed;
    save.addEventListener('click', () => {
      const list = loadWatchlist();
      if (!list.some((w) => w.id === item.id && w.type === item.type)) {
        list.push({ ...lastSelectedMeta, overview: item.overview, addedAt: Date.now() });
        saveWatchlist(list);
      }
      save.textContent = 'In watchlist ✓';
      save.disabled = true;
    });
    const back = document.createElement('button');
    back.className = 'ghost';
    back.textContent = 'Back';
    back.addEventListener('click', () => {
      box.hidden = true;
    });
    actions.append(toPaste, save, back);
    body.append(h, meta, overview, hint, actions);
    box.append(body);
    box.hidden = false;
  }

  const loadWatchlist = () => {
    try {
      return JSON.parse(localStorage.getItem(WATCHLIST_KEY) || '[]');
    } catch {
      return [];
    }
  };
  const saveWatchlist = (list) => localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));

  function renderWatchlist() {
    const list = loadWatchlist().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    renderCards(list, { watchlist: true });
    searchStatus(
      list.length ? `${list.length} saved.` : 'Watchlist is empty — search and save something.',
      list.length ? 'ok' : ''
    );
  }

  $('watchlist-toggle').addEventListener('click', () => {
    const on = $('watchlist-toggle').classList.toggle('active');
    $('search-detail').hidden = true;
    if (on) {
      renderWatchlist();
    } else {
      $('search-results').replaceChildren();
      checkTmdbKey();
    }
  });

  // Metadata memory: associate a loaded magnet's hash with the most recently
  // selected search result so re-pasting it later shows what it is.
  const loadHashMeta = () => {
    try {
      return JSON.parse(localStorage.getItem(HASH_META_KEY) || '{}');
    } catch {
      return {};
    }
  };
  function rememberHashMeta(hash) {
    if (!lastSelectedMeta || !hash) return;
    const map = loadHashMeta();
    map[hash] = lastSelectedMeta;
    localStorage.setItem(HASH_META_KEY, JSON.stringify(map));
  }
  function showKnownMeta(hash) {
    const m = hash ? loadHashMeta()[hash] : null;
    if (m) notice(`Now watching: ${m.title}${m.year ? ` (${m.year})` : ''} — synced.`, 'ok', 6000);
  }

  // ---- Settings panel ----
  $('torbox-key').value = getKey();
  updateKeyStatus(getKey() ? 'unknown' : 'empty');

  function openSettings(open) {
    $('settings-panel').hidden = !open;
  }
  $('settings-btn').addEventListener('click', () => openSettings($('settings-panel').hidden));
  document.addEventListener('click', (e) => {
    if (!$('settings-panel').hidden && !$('settings-panel').contains(e.target) && e.target !== $('settings-btn') && !$('settings-btn').contains(e.target))
      openSettings(false);
  });

  $('torbox-save').addEventListener('click', validateAndSaveKey);
  $('torbox-key').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      validateAndSaveKey();
    }
  });

  async function validateAndSaveKey() {
    const key = $('torbox-key').value.trim();
    localStorage.setItem('torbox_api_key', key);
    if (!key) {
      updateKeyStatus('empty');
      return;
    }
    updateKeyStatus('checking');
    try {
      const r = await torboxPost('/torbox/check', { apiKey: key });
      updateKeyStatus(r?.valid ? 'valid' : 'invalid', r?.plan, r?.detail);
    } catch {
      updateKeyStatus('invalid', null, 'could not reach TorBox');
    }
  }

  $('tmdb-key').value = getTmdbKey();
  updateTmdbKeyStatus(getTmdbKey() ? 'unknown' : 'empty');
  $('tmdb-save').addEventListener('click', validateAndSaveTmdbKey);
  $('tmdb-key').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      validateAndSaveTmdbKey();
    }
  });

  async function validateAndSaveTmdbKey() {
    const key = $('tmdb-key').value.trim();
    localStorage.setItem('tmdb_api_key', key);
    if (!key) {
      updateTmdbKeyStatus('empty');
      checkTmdbKey();
      return;
    }
    updateTmdbKeyStatus('checking');
    try {
      const res = await fetch('/api/tmdb/search?query=test', { headers: { 'x-tmdb-key': key } });
      const j = await res.json().catch(() => null);
      updateTmdbKeyStatus(j?.success ? 'valid' : 'invalid', j?.detail);
    } catch {
      updateTmdbKeyStatus('invalid', 'could not reach the server');
    }
    checkTmdbKey();
  }

  function updateTmdbKeyStatus(state, detail) {
    const el = $('tmdb-key-status');
    if (state === 'empty') {
      el.textContent = 'No key saved.';
      el.className = 'key-status';
    } else if (state === 'unknown') {
      el.textContent = 'Key saved (click Save to re-validate).';
      el.className = 'key-status';
    } else if (state === 'checking') {
      el.textContent = 'Checking…';
      el.className = 'key-status';
    } else if (state === 'valid') {
      el.textContent = 'Valid.';
      el.className = 'key-status valid';
    } else {
      el.textContent = `Invalid${detail ? ` — ${detail}` : ''}.`;
      el.className = 'key-status invalid';
    }
  }

  function updateKeyStatus(state, plan, detail) {
    const el = $('torbox-key-status');
    if (state === 'empty') {
      el.textContent = 'No key saved.';
      el.className = 'key-status';
    } else if (state === 'unknown') {
      el.textContent = 'Key saved (click Save to re-validate).';
      el.className = 'key-status';
    } else if (state === 'checking') {
      el.textContent = 'Checking…';
      el.className = 'key-status';
    } else if (state === 'valid') {
      el.textContent = plan ? `Valid — ${plan} plan.` : 'Valid.';
      el.className = 'key-status valid';
    } else {
      el.textContent = `Invalid${detail ? ` — ${detail}` : ''}.`;
      el.className = 'key-status invalid';
    }
  }

  // ---- Network status indicator (Phase 5) ----
  // Every 2s: RTT from the selected candidate pair, packet loss + bitrate from
  // inbound-rtp deltas. Good <150ms & <2% · Fair 150–300ms or 2–5% · Poor above.
  let prevInbound = null;
  const statsTimer = setInterval(pollNetStats, 2000);

  function renderNet(text, kind, tooltip) {
    $('net-label').textContent = text;
    $('net-dot').className = kind;
    $('net-wrap').title = tooltip;
  }

  async function pollNetStats() {
    const sigText = netSignaling === 'reconnecting' ? 'reconnecting' : 'connected';
    const iceText = pc?.iceConnectionState ?? '—';
    if (netSignaling === 'reconnecting') {
      renderNet('Reconnecting', 'error', `Signaling: reconnecting · ICE: ${iceText}`);
      return;
    }
    if (!pc || pc.connectionState !== 'connected') {
      renderNet('No call', '', `Signaling: ${sigText} · ICE: ${iceText}`);
      prevInbound = null;
      return;
    }
    let rttMs = null;
    let recv = 0;
    let lost = 0;
    let bytes = 0;
    try {
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
          rttMs = r.currentRoundTripTime * 1000;
        }
        if (r.type === 'inbound-rtp') {
          recv += r.packetsReceived || 0;
          lost += r.packetsLost || 0;
          bytes += r.bytesReceived || 0;
        }
      });
    } catch {
      return; // pc closed mid-poll
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
      `RTT ${rttMs != null ? `${Math.round(rttMs)} ms` : '—'} · loss ${lossPct.toFixed(1)}% · ` +
        `↓ ${mbps.toFixed(1)} Mbps · signaling: ${sigText} · ICE: ${iceText}`
    );
  }

  // ---- Swap view (Phase 6a) ----
  // Local-only: each person picks what fills their own stage. Promotes the
  // partner's camera to the main pane; the content pane shrinks to a corner
  // tile (pure CSS via .swapped — the panes keep working untouched).
  let swapped = false;

  function setSwapped(on) {
    if (swapped === on) return;
    if (on && pipWindow) return; // partner cam currently lives in the pop-out
    swapped = on;
    $('stage-main').classList.toggle('swapped', on);
    if (on) {
      elRemote.classList.add('main-cam');
      $('stage-main').append(elRemote);
      $('stage-label').textContent = "Showing: partner's camera — click to show shared content";
      $('stage-label').hidden = false;
    } else {
      elRemote.classList.remove('main-cam');
      $('partner-wrap').prepend(elRemote);
      $('stage-label').hidden = true;
    }
    tryPlay(elRemote);
  }

  $('swap-view').addEventListener('click', () => setSwapped(true));
  $('stage-label').addEventListener('click', () => setSwapped(false));

  // ---- Emoji reactions (Phase 6b) ----
  const REACTIONS = ['❤️', '😂', '😮', '😢', '😡', '🎉'];
  let lastReactionAt = 0;

  for (const btn of document.querySelectorAll('#reaction-bar button')) {
    btn.addEventListener('click', () => {
      const now = Date.now();
      if (now - lastReactionAt < 1000) return; // max 1/s
      lastReactionAt = now;
      signal({ type: 'reaction', emoji: btn.dataset.emoji });
      showReaction(btn.dataset.emoji);
    });
  }

  function showReaction(emoji) {
    if (!REACTIONS.includes(emoji)) return; // preset emojis only
    const el = document.createElement('span');
    el.className = 'reaction';
    el.textContent = emoji;
    el.style.left = `${25 + Math.random() * 50}%`; // slight offset so repeats stack
    $('reactions-layer').append(el);
    setTimeout(() => el.remove(), 2100);
  }

  // ---- Push-to-talk (Phase 6c) ----
  // PTT on: mic muted unless Space (or the Hold-to-talk button) is held.
  // PTT off: the normal mute toggle rules the mic.
  let pttOn = false;
  let pttSpeaking = false;

  function setMicEnabled(on) {
    const t = localStream?.getAudioTracks()[0];
    if (t) t.enabled = on;
  }

  function setPtt(on) {
    pttOn = on;
    pttSpeaking = false;
    $('ptt').classList.toggle('active', on);
    $('ptt').title = on
      ? 'Push-to-talk on — hold Space or the Hold-to-talk button to speak'
      : 'Enable push-to-talk';
    $('ptt-hold').classList.toggle('visible', on);
    $('toggle-mic').disabled = on;
    setMicEnabled(!on); // on -> muted until held; off -> back to open mic
    updateSpeakingUi();
    syncToggleButtons();
  }

  function setSpeaking(on) {
    if (!pttOn || pttSpeaking === on) return;
    pttSpeaking = on;
    setMicEnabled(on);
    updateSpeakingUi();
    syncToggleButtons();
  }

  function updateSpeakingUi() {
    $('ptt').classList.toggle('speaking', pttSpeaking);
    $('ptt-hold').classList.toggle('speaking', pttSpeaking);
    $('ptt-indicator').hidden = !pttSpeaking;
  }

  $('ptt').addEventListener('click', () => setPtt(!pttOn));

  const holdBtn = $('ptt-hold');
  holdBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    setSpeaking(true);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
    holdBtn.addEventListener(ev, () => setSpeaking(false));
  }

  const isTypingTarget = (el) =>
    el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

  window.addEventListener('keydown', (e) => {
    if (!pttOn || e.code !== 'Space' || e.repeat || isTypingTarget(e.target)) return;
    e.preventDefault(); // don't scroll or trigger the focused button
    setSpeaking(true);
  });
  window.addEventListener('keyup', (e) => {
    if (!pttOn || e.code !== 'Space') return;
    if (!isTypingTarget(e.target)) e.preventDefault();
    setSpeaking(false);
  });
  window.addEventListener('blur', () => setSpeaking(false)); // don't strand an open mic

  // ---- Control cluster: mic / cam / chat / leave ----
  function syncToggleButtons() {
    const audio = localStream?.getAudioTracks()[0];
    const video = localStream?.getVideoTracks()[0];
    $('toggle-mic').classList.toggle('off', audio ? !audio.enabled : false);
    $('toggle-mic').title = audio && !audio.enabled ? 'Unmute microphone' : 'Mute microphone';
    $('toggle-cam').classList.toggle('off', video ? !video.enabled : false);
    $('toggle-cam').title = video && !video.enabled ? 'Turn camera on' : 'Turn camera off';
  }

  $('toggle-mic').addEventListener('click', () => {
    const t = localStream?.getAudioTracks()[0];
    if (t) t.enabled = !t.enabled;
    syncToggleButtons();
  });
  $('toggle-cam').addEventListener('click', () => {
    const t = localStream?.getVideoTracks()[0];
    if (t) t.enabled = !t.enabled;
    syncToggleButtons();
  });
  // Hide/show the self-view thumbnail (partner tile always stays).
  $('toggle-self').addEventListener('click', () => {
    const hidden = $('cam-tiles').classList.toggle('self-hidden');
    $('toggle-self').textContent = hidden ? 'Self' : '×';
    $('toggle-self').title = hidden ? 'Show self-view' : 'Hide self-view';
    $('toggle-self').setAttribute('aria-label', $('toggle-self').title);
  });

  $('toggle-chat').addEventListener('click', () => {
    const collapsed = $('chat-rail').classList.toggle('collapsed');
    $('toggle-chat').classList.toggle('active', !collapsed);
    $('toggle-chat').title = collapsed ? 'Show chat' : 'Hide chat';
  });
  $('leave').addEventListener('click', () => {
    leaving = true; // stop the auto-reconnect loop
    try {
      clearTimeout(reconnectTimer);
      clearTimeout(peerLeftGraceTimer);
      clearInterval(statsTimer);
      if (pipWindow) pipWindow.close();
      pc?.close();
      ws?.close();
      localStream?.getTracks().forEach((t) => t.stop());
      screenStream?.getTracks().forEach((t) => t.stop());
    } finally {
      location.href = '/';
    }
  });

  // ---- Document Picture-in-Picture companion (Phase 4c) ----
  let pipWindow = null;
  const pipSupported = 'documentPictureInPicture' in window;
  if (!pipSupported) {
    $('popout').disabled = true;
    $('popout').title = 'Pop-out needs Chrome or Edge (Document Picture-in-Picture).';
  }

  $('popout').addEventListener('click', async () => {
    if (!pipSupported) return;
    if (pipWindow) {
      pipWindow.close();
      return;
    }
    setSwapped(false); // the partner cam is about to move into the pop-out
    try {
      pipWindow = await documentPictureInPicture.requestWindow({ width: 300, height: 420 });
    } catch (err) {
      notice(`Pop-out failed: ${err.message || err}`, 'warn', 5000);
      return;
    }
    // Copy stylesheets — the PiP document doesn't inherit the page's CSS.
    for (const sheet of document.styleSheets) {
      try {
        const css = [...sheet.cssRules].map((r) => r.cssText).join('\n');
        const style = pipWindow.document.createElement('style');
        style.textContent = css;
        pipWindow.document.head.append(style);
      } catch {
        if (sheet.href) {
          const link = pipWindow.document.createElement('link');
          link.rel = 'stylesheet';
          link.href = sheet.href;
          pipWindow.document.head.append(link);
        }
      }
    }
    pipWindow.document.body.className = 'pip-body';
    // Move the partner cam + chat into the PiP window.
    pipWindow.document.body.append(elRemote, elMessages, elSendForm);
    $('popout').classList.add('active');
    $('popout').title = 'Close pop-out';
    tryPlay(elRemote);
    pipWindow.addEventListener('pagehide', restoreFromPip);
  });

  function restoreFromPip() {
    if (!pipWindow) return;
    // Put the moved nodes back in their original places.
    $('partner-wrap').prepend(elRemote);
    $('chat-rail').append(elMessages, elSendForm);
    $('popout').classList.remove('active');
    $('popout').title = 'Pop partner cam + chat into a floating window';
    tryPlay(elRemote);
    pipWindow = null;
  }

  // ---- Autoplay recovery ----
  async function tryPlay(video) {
    try {
      await video.play();
      $('tap-to-play').hidden = true;
    } catch {
      $('tap-to-play').hidden = false;
    }
  }
  $('tap-to-play').addEventListener('click', () => {
    tryPlay(elRemote);
    if (!$('screen-video').hidden) tryPlay($('screen-video'));
    if (player?.el) tryPlay(player.el);
  });

  // ---- Chat ----
  elSendForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('send-input');
    const text = input.value.trim();
    if (!text || ws?.readyState !== WebSocket.OPEN) return;
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
    elMessages.append(div);
    elMessages.scrollTop = elMessages.scrollHeight;
  }

  // Dev/debug handle (also used by automated smoke tests).
  window.__cowatch = {
    get pc() { return pc; },
    get player() { return player; },
    get mode() { return mode; },
    get sourceMode() { return sourceMode; },
    get pipWindow() { return pipWindow; },
    get shareBaton() { return shareBaton; },
    get polite() { return polite; },
    get peerPresent() { return peerPresent; },
    signal,
  };
}
