// Sync mode (Mode B) UI + source orchestration.
// Drives the URL / TorBox / Search source toggle, resolves TorBox magnets into
// stream URLs, hands finished sources to the core sync engine, and broadcasts
// loads to the peer. The core player lifecycle lives in core/sync.js.

import { $, spinner } from '../lib/dom.js';
import { torboxPost, getKey } from '../lib/torbox.js';
import { detectSource, UNSUPPORTED_MSG } from '../core/sync.js';

export function createSyncMode(ctx) {
  let sourceMode = 'url'; // 'url' | 'torbox' | 'search' | 'torlink'

  const { signal } = ctx.signaling;
  const notice = (text, kind, ms) => ctx.controls.notice(text, kind, ms);
  const loadSource = (source) => ctx.syncCore.loadSource(source);

  // Source toggle: URL / TorBox (paste a link) · Search / Stremio (discover a
  // title). Torlink is retired from the UI but its module stays wired as a
  // fallback (still reachable via a pasted magnet through the TorBox flow).
  function setSourceMode(m) {
    sourceMode = m;
    $('source-url').classList.toggle('active', m === 'url');
    $('source-torbox').classList.toggle('active', m === 'torbox');
    $('source-stremio').classList.toggle('active', m === 'stremio');
    $('sync-input').placeholder =
      m === 'torbox'
        ? 'Magnet link or 40-char torrent hash'
        : m === 'search'
          ? 'Search for a movie or show…'
          : m === 'stremio'
            ? 'Search a title…'
            : 'YouTube / Vimeo / .mp4 URL';
    $('sync-load').textContent = m === 'search' || m === 'stremio' ? 'Search' : 'Load';
    $('file-select').hidden = true;
    $('search-panel').hidden = m !== 'search';
    $('stremio-panel').hidden = m !== 'stremio';
    if (m === 'search') ctx.search.checkTmdbKey();
    if (m === 'stremio') ctx.stremio.activate();
  }
  $('source-url').addEventListener('click', () => setSourceMode('url'));
  $('source-torbox').addEventListener('click', () => setSourceMode('torbox'));
  $('source-stremio').addEventListener('click', () => setSourceMode('stremio'));

  $('sync-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = $('sync-input').value.trim();
    if (!raw) return;
    if (sourceMode === 'search') ctx.search.runSearch(raw);
    else if (sourceMode === 'torlink') ctx.torlink.run(raw);
    else if (sourceMode === 'stremio') ctx.stremio.run(raw);
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
    ctx.tracks.setTorrentSubs(null); // URL sources carry no torrent subtitle files
    await loadSource(source);
    signal({ type: 'sync-load', source });
  }

  async function handleRemoteLoad(source, fromName) {
    if (source.kind === 'stremio') {
      // The Stremio module owns the whole follow flow: borrow the sharer's
      // add-on if we have none (Part C), re-resolve (URLs are debrid/IP-locked),
      // load, and wire subtitles.
      await ctx.stremio.followStream(source, fromName);
      return;
    }
    if (source.kind === 'torbox') {
      const myKey = getKey();
      if (myKey) {
        notice('Your friend loaded a TorBox video — resolving with your own account…');
        const mine = await resolveTorbox(source.magnet, source.hash, source.fileName);
        if (mine) {
          await loadSource({ ...source, resolvedUrl: mine });
          ctx.search.showKnownMeta(source.hash);
          return;
        }
      }
      if (source.resolvedUrl) {
        ctx.tracks.setTorrentSubs(null); // no key -> we can't fetch this torrent's sub files
        await loadSource(source);
        ctx.search.showKnownMeta(source.hash);
        return;
      }
      notice('Enter your TorBox API key (gear icon) to watch this.', 'warn');
      ctx.settings.openSettings(true);
      return;
    }
    await loadSource(source);
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
      ctx.settings.openSettings(true);
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
      ctx.tracks.setTorrentSubs(meta); // remember .srt/.vtt files for the CC panel
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
      ctx.search.rememberHashMeta(src.hash); // ties the hash to the last-selected search result
      ctx.search.showKnownMeta(src.hash);
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
      ctx.tracks.setTorrentSubs(meta); // remember .srt/.vtt files for the CC panel
      const pick =
        videos.find((f) => f.name === preferName) ||
        videos.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
      const dl = await torboxPost('/torbox/load', { apiKey, torrentId: meta.torrentId, fileId: pick.id });
      return dl?.success ? dl.streamUrl : null;
    } catch {
      return null;
    }
  }

  $('resync').addEventListener('click', async () => {
    const player = ctx.syncCore.getPlayer();
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

  return {
    getSourceMode: () => sourceMode,
    setSourceMode,
    handleRemoteLoad,
  };
}
