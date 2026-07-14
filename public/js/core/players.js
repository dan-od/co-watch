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

export function createNativePlayer(container, url, report, onError, onAutoplayBlocked) {
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
