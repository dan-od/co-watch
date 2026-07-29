// Core sync engine (Phase 4b): source detection, player lifecycle, and the
// play/pause/seek sync protocol. Owns the single `player` instance; mode UI
// (modes/sync.js) drives it, and remote sync events flow through applyRemoteSync.

import { $ } from '../lib/dom.js';
import { createYouTubePlayer, createVimeoPlayer, createNativePlayer } from './players.js';

const SYNC_DRIFT_TOLERANCE = 0.75; // seconds — follower seeks if further off than this
const SYNC_SUPPRESS_MS = 800; // echo-suppression window after applying a remote sync event

export const UNSUPPORTED_MSG =
  'Sync mode supports YouTube, Vimeo, direct video links, and TorBox magnets. ' +
  'For anything else, use Share screen instead.';

// ---- Sync-source detection (Phase 4b) ----
export function detectSource(raw) {
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

// Safari can't play the Matroska (.mkv) container at all — no codec setting
// changes that. Most debrid releases are .mkv, so this is a very common
// "the video just doesn't load" on a Mac.
const isSafari = () =>
  typeof navigator !== 'undefined' &&
  /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent || '');

function playbackErrorText(source, mediaError) {
  const code = mediaError?.code;
  const looksMkv = /\.mkv(\?|$)/i.test(source?.resolvedUrl || source?.url || '') || /\bmkv\b/i.test(source?.name || '');

  // Repaired playback: the browser never sees the original file, so none of the
  // container/codec advice below applies — the converter is what failed.
  if (source?.transcode) {
    return code === 2
      ? 'The repaired stream stopped part-way — the source link probably expired. Pick the stream again.'
      : 'Could not repair this stream here. If someone else in the room already has it playing repaired, only one of you can at a time — the source link allows a single connection. Otherwise try another release, or play it without the repair.';
  }

  if (code === 4 /* SRC_NOT_SUPPORTED */) {
    if (isSafari()) {
      return 'Safari can’t play this file’s container (it has no .mkv support) — pick a different release, ideally one labelled MP4 or WEB-DL, or open the room in Chrome.';
    }
    return looksMkv
      ? 'This browser can’t play this release’s container/codec — try another stream for the same title.'
      : 'This browser can’t play this stream’s format — try another stream for the same title.';
  }
  if (code === 3 /* DECODE */) {
    return 'The video started but the codec failed to decode here — pick a different release (a plain H.264 / WEB-DL usually works).';
  }
  if (code === 2 /* NETWORK */) {
    return source?.kind === 'stremio' || source?.kind === 'torbox'
      ? 'The stream link stopped responding. Debrid links expire and are tied to the account that created them — open the picker and choose the stream again to get a fresh link.'
      : 'The stream link stopped responding — the host may block cross-site playback (CORS).';
  }
  // No MediaError (or aborted): fall back to the source-specific hint.
  if (source?.kind === 'torbox') {
    return 'This link requires your own TorBox account — paste the same magnet after adding your key.';
  }
  if (source?.kind === 'stremio') {
    return 'That stream would not play here — debrid links are usually locked to the account that made them. Pick the stream again, or load your own add-on in the Stremio tab.';
  }
  return 'Could not load this video — the host may block cross-site playback (CORS) or the format is unsupported.';
}

export function createSync(ctx) {
  let player = null;
  let suppressUntil = 0;
  let seekRestart = null; // debounce for transcode restarts (see onSeekOutside)

  async function loadSource(source) {
    destroyPlayer();
    const container = $('sync-player');
    $('sync-placeholder').hidden = true;
    const report = (action, time, rate) => {
      if (Date.now() < suppressUntil) return;
      ctx.signaling.signal({ type: 'sync', action, time: time ?? 0, rate: rate ?? 1 });
    };
    const { notice } = ctx.controls;
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
        const direct = source.kind === 'torbox' || source.kind === 'stremio' ? source.resolvedUrl : source.url;
        // Audio-repair mode: the server decodes Dolby/DTS to AAC and remuxes to
        // fMP4 on the fly. The stream starts at `startAt`, so element time 0 is
        // that offset — the adapter reports absolute time via baseTime.
        const startAt = Math.max(0, Number(source.startAt) || 0);
        let url = direct;
        if (source.transcode) {
          const p = new URLSearchParams({ url: direct });
          if (startAt) p.set('t', String(Math.floor(startAt)));
          // Which audio track inside the file — picking blindly is how an
          // "English, Hindi" release ends up playing Hindi.
          if (Number.isInteger(source.audioIndex) && source.audioIndex >= 0) {
            p.set('a', String(source.audioIndex));
          }
          // Hosts that refuse ffmpeg's own HTTP client get fetched by Node
          // instead; probe worked out which one this source needs.
          if (source.via === 'proxy') p.set('via', 'proxy');
          url = `/api/transcode?${p}`;
        }
        // The <video> element tells us WHY it failed — say that, instead of
        // blaming debrid for everything. Safari in particular cannot play .mkv
        // at ALL (unsupported container), which surfaces as SRC_NOT_SUPPORTED
        // and has nothing to do with the link being locked.
        const onError = (mediaError) => notice(playbackErrorText(source, mediaError), 'error');
        player = createNativePlayer(container, url, report, onError, () => ($('tap-to-play').hidden = false), {
          baseTime: source.transcode ? startAt : 0,
          duration: source.transcode ? source.duration : 0,
          // Seeking past the buffered part of a piped transcode means
          // restarting ffmpeg further in — which reopens the source link.
          // Debounced, because dragging the scrubber emits a stream of seeks
          // and each one used to fire its own reconnect at the host.
          onSeekOutside: source.transcode
            ? (t) => {
                clearTimeout(seekRestart);
                ctx.controls.notice('Jumping — re-encoding from there…', '', 2500);
                seekRestart = setTimeout(() => {
                  loadSource({ ...source, startAt: t });
                  ctx.signaling.signal({ type: 'sync', action: 'seek', time: t, rate: 1 });
                }, 600);
              }
            : null,
        });
        notice('Video loaded — play/pause/seek stay in sync.', 'ok', 4000);
      }
      $('resync').disabled = false;
      $('tracks-btn').hidden = !player?.el; // subtitles/audio only on the native player
      $('live-chip').hidden = false; // topbar "Live" pulse while synced playback runs
      ctx.mixer.setMediaAdapter(player); // route movie volume through the mixer's media channel
      ctx.controls.setMode('watch'); // the player takes the stage
      ctx.playerUi.onLoaded(source); // transport overlay, title strip, sync lock
    } catch (err) {
      notice(`Could not load: ${err.message || err}`, 'error');
      $('sync-placeholder').hidden = false;
    }
  }

  function destroyPlayer() {
    clearTimeout(seekRestart);
    if (player) {
      try {
        player.destroy();
      } catch {}
      player = null;
    }
    ctx.mixer.setMediaAdapter(null);
    ctx.playerUi.onDestroyed();
    $('sync-player').replaceChildren();
    $('resync').disabled = true;
    $('live-chip').hidden = true;
    ctx.tracks.releaseSubs(); // hides the tracks button/panel + revokes subtitle blob URLs
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

  return {
    getPlayer: () => player,
    loadSource,
    destroyPlayer,
    applyRemoteSync,
  };
}
