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

  // Source subtabs inside the Sync card: URL (paste a link) · TorBox (magnet).
  // Stremio is its own top-level mode now; Torlink is retired from the UI but
  // its module stays wired as a fallback (reachable via a pasted magnet).
  function setSourceMode(m) {
    if (m !== 'url' && m !== 'torbox') m = 'url';
    sourceMode = m;
    const torbox = m === 'torbox';
    $('source-url').setAttribute('aria-pressed', String(!torbox));
    $('source-torbox').setAttribute('aria-pressed', String(torbox));
    $('sync-input-label').textContent = torbox ? 'Magnet link or torrent hash' : 'Video URL';
    $('sync-input').placeholder = torbox
      ? 'magnet:?xt=urn:btih:… or a 40-character hash'
      : 'YouTube, Vimeo, or a direct .mp4 / .webm link';
    $('sync-hint').textContent = torbox
      ? 'Resolved through your own TorBox account, then played for everyone.'
      : 'Loads for everyone at once. Play, pause, and seek stay in sync from there.';
    $('file-select').hidden = true;
  }
  $('source-url').addEventListener('click', () => setSourceMode('url'));
  $('source-torbox').addEventListener('click', () => setSourceMode('torbox'));

  $('sync-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = $('sync-input').value.trim();
    if (!raw) return;
    if (sourceMode === 'torbox') loadTorbox(raw);
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

  // The torrent's video files as a pickable list (mockup's .filelist).
  function populateFileSelect(videos, torrentId, src) {
    const box = $('file-select');
    box.replaceChildren();

    const head = document.createElement('div');
    head.className = 'fh';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'Pick a file';
    const count = document.createElement('span');
    count.className = 'c';
    count.textContent = `${videos.length} video file${videos.length === 1 ? '' : 's'}`;
    head.append(label, count);
    box.append(head);

    for (const f of videos) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'file';
      row.setAttribute('aria-selected', 'false');
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = f.name;
      nm.title = f.name;
      const sz = document.createElement('span');
      sz.className = 'sz';
      sz.textContent = `${(f.size / 1e9).toFixed(2)} GB`;
      const pick = document.createElement('span');
      pick.className = 'pick';
      pick.textContent = 'Play';
      row.append(nm, sz, pick);
      row.addEventListener('click', () => {
        for (const other of box.querySelectorAll('.file')) other.setAttribute('aria-selected', 'false');
        row.setAttribute('aria-selected', 'true');
        loadTorboxFile(torrentId, f.id, src, f.name);
      });
      box.append(row);
    }
    box.hidden = false;
    box.querySelector('.file')?.setAttribute('aria-selected', 'true'); // largest plays first
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
