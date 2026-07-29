// Player adapters (Phase 4b).
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

export async function createYouTubePlayer(container, videoId, report) {
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
    setVolume: (x) => yt.setVolume(Math.round(Math.max(0, Math.min(1, x)) * 100)), // 0..1 → 0..100
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

export async function createVimeoPlayer(container, url, report) {
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
    setVolume: (x) => v.setVolume(Math.max(0, Math.min(1, x))).catch(() => {}),
    destroy: () => v.destroy().catch(() => {}),
  };
}

// opts (transcoded playback only):
//   baseTime — the transcode started at this offset, so element time 0 is
//              actually baseTime in the film. All reported times are absolute.
//   duration — probed up-front, because a piped fragmented MP4 has none.
//   onSeekOutside — the piped stream can only seek inside what's buffered;
//              anything further has to restart ffmpeg at the new offset.
export function createNativePlayer(container, url, report, onError, onAutoplayBlocked, opts = {}) {
  const base = Number(opts.baseTime) || 0;
  const total = Number(opts.duration) || 0;
  const v = document.createElement('video');
  v.controls = true;
  v.playsInline = true;
  v.src = url;
  container.append(v);
  const abs = () => base + v.currentTime; // absolute position in the film
  v.addEventListener('play', () => report('play', abs(), v.playbackRate));
  v.addEventListener('pause', () => {
    if (!v.seeking) report('pause', abs(), v.playbackRate);
  });
  v.addEventListener('seeked', () => report('seek', abs(), v.playbackRate));
  v.addEventListener('ratechange', () => report('seek', abs(), v.playbackRate));
  v.addEventListener('error', () => onError?.(v.error));

  // play() returns a promise that REJECTS with AbortError whenever something
  // pauses before it settles — which happens constantly here, because a peer's
  // sync message can pause us mid-play. Treating every rejection as "autoplay
  // blocked" made the button look dead until you clicked it 2–3 times. Only a
  // real NotAllowedError is an autoplay block; serialise the calls so our own
  // play/pause can't fight each other either.
  let pending = Promise.resolve();
  const queue = (fn) => {
    pending = pending.then(fn, fn);
    return pending;
  };

  return {
    el: v,
    play: () =>
      queue(async () => {
        try {
          await v.play();
        } catch (err) {
          if (err?.name === 'NotAllowedError') onAutoplayBlocked?.();
          else if (err?.name !== 'AbortError') console.warn('play failed:', err);
        }
      }),
    pause: () => queue(() => v.pause()),
    seek: (t) => {
      const local = t - base;
      // A piped fragmented MP4 only holds what's been streamed so far. If the
      // target is outside that, ffmpeg has to be restarted at the new offset.
      if (opts.onSeekOutside) {
        let ok = false;
        for (let i = 0; i < v.seekable.length; i++) {
          if (local >= v.seekable.start(i) - 0.5 && local <= v.seekable.end(i) + 0.5) ok = true;
        }
        if (!ok) return opts.onSeekOutside(Math.max(0, t));
      }
      v.currentTime = local;
    },
    getTime: () => abs(),
    getDuration: () => total || (Number.isFinite(v.duration) ? v.duration : 0),
    isPaused: () => v.paused,
    setRate: (r) => {
      v.playbackRate = r;
    },
    setVolume: (x) => {
      v.volume = Math.max(0, Math.min(1, x));
    },
    destroy: () => {
      v.pause();
      v.removeAttribute('src');
      v.remove();
    },
  };
}
