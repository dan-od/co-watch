// TorBox proxy routes. Composed endpoints (/torbox/check|fetch|load|subfile)
// wrap several TorBox API calls; the raw pass-throughs (/torbox/checkcached|
// createtorrent|requestdl) are kept for Phase 4b compatibility. Only these
// fixed endpoints are reachable — this is not a general proxy.

const { readJsonBody, sendJson } = require('../lib/http');
const { TORBOX_API, tbJson, tbLog } = require('../lib/torbox-client');

async function handleTorbox(req, res, urlPath) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { success: false, detail: 'POST only' });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { success: false, detail: 'invalid JSON body' });
    return;
  }
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!apiKey) {
    sendJson(res, 400, { success: false, detail: 'missing apiKey' });
    return;
  }
  const authHeaders = { Authorization: `Bearer ${apiKey}` };

  try {
    // ---- Composed endpoints (Phase 4c/4d UI) ----

    if (urlPath === '/torbox/check') {
      // Validate the API key against the user endpoint.
      const r = await fetch(`${TORBOX_API}/user/me?settings=false`, { headers: authHeaders });
      const j = await tbJson(r);
      tbLog('check', r, j);
      sendJson(res, 200, {
        valid: !!j?.success,
        plan: j?.data?.plan ?? null,
        detail: j?.success ? null : j?.detail || `HTTP ${r.status}`,
      });
      return;
    }

    if (urlPath === '/torbox/fetch') {
      // Fetch torrent metadata. First call: {magnet, hash} — checks cache,
      // adds the torrent, returns files. Poll call: {torrentId} — returns
      // download state/progress/files for an already-added torrent.
      let torrentId = body.torrentId ?? null;
      let cached = null;
      if (!torrentId) {
        const hash = String(body.hash || '').toLowerCase();
        const ccR = await fetch(`${TORBOX_API}/torrents/checkcached?format=object&list_files=true`, {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ hashes: [hash] }),
        });
        const cc = await tbJson(ccR);
        tbLog('checkcached', ccR, cc);
        if (cc?.success === false && cc?.detail) {
          sendJson(res, 200, { success: false, detail: cc.detail });
          return;
        }
        cached = !!cc?.data?.[hash];
        const form = new FormData();
        form.set('magnet', String(body.magnet || ''));
        const ctR = await fetch(`${TORBOX_API}/torrents/createtorrent`, {
          method: 'POST',
          headers: authHeaders,
          body: form,
        });
        const ct = await tbJson(ctR);
        tbLog('createtorrent', ctR, ct);
        torrentId = ct?.data?.torrent_id ?? ct?.data?.id ?? null;
        if (!torrentId) {
          // Torrent may already exist in the account — find it by hash.
          const mlR = await fetch(`${TORBOX_API}/torrents/mylist?bypass_cache=true`, { headers: authHeaders });
          const ml = await tbJson(mlR);
          const list = Array.isArray(ml?.data) ? ml.data : [];
          torrentId = list.find((t) => (t?.hash || '').toLowerCase() === hash)?.id ?? null;
        }
        if (!torrentId) {
          sendJson(res, 200, { success: false, detail: ct?.detail || 'TorBox did not accept this torrent' });
          return;
        }
      }
      const tR = await fetch(`${TORBOX_API}/torrents/mylist?id=${encodeURIComponent(torrentId)}&bypass_cache=true`, {
        headers: authHeaders,
      });
      const tj = await tbJson(tR);
      tbLog('mylist(byId)', tR, tj);
      const t = Array.isArray(tj?.data) ? tj.data[0] : tj?.data;
      const files = (t?.files || []).map((f, i) => ({
        id: f?.id ?? i,
        name: f?.name || f?.short_name || `file ${i}`,
        size: f?.size ?? 0,
        mimetype: f?.mimetype || '',
      }));
      sendJson(res, 200, {
        success: true,
        torrentId,
        cached,
        state: t?.download_state ?? 'unknown',
        progress: typeof t?.progress === 'number' ? t.progress : 0,
        finished: !!t?.download_finished,
        files,
      });
      return;
    }

    if (urlPath === '/torbox/load') {
      // Resolve a torrent file to a direct stream URL.
      const q = new URLSearchParams({ token: apiKey, torrent_id: String(body.torrentId ?? '') });
      if (body.fileId != null) q.set('file_id', String(body.fileId));
      const r = await fetch(`${TORBOX_API}/torrents/requestdl?${q}`);
      const j = await tbJson(r);
      tbLog('requestdl', r, j);
      const streamUrl = typeof j?.data === 'string' ? j.data : j?.data?.url;
      if (!streamUrl) {
        sendJson(res, 200, { success: false, detail: j?.detail || 'TorBox did not return a download URL' });
        return;
      }
      sendJson(res, 200, { success: true, streamUrl });
      return;
    }

    if (urlPath === '/torbox/subfile') {
      // Fetch a SUBTITLE file from the user's own torrent (the TorBox CDN is
      // not CORS-open, so the text comes through here). Hard 3 MB cap so a
      // mis-picked video file can't be pulled through this path.
      const MAX_SUB_BYTES = 3 * 1024 * 1024;
      const q = new URLSearchParams({ token: apiKey, torrent_id: String(body.torrentId ?? '') });
      if (body.fileId != null) q.set('file_id', String(body.fileId));
      const r = await fetch(`${TORBOX_API}/torrents/requestdl?${q}`);
      const j = await tbJson(r);
      tbLog('subfile:requestdl', r, j);
      const url = typeof j?.data === 'string' ? j.data : j?.data?.url;
      if (!url) {
        sendJson(res, 200, { success: false, detail: j?.detail || 'TorBox did not return a download URL' });
        return;
      }
      const fR = await fetch(url);
      if (!fR.ok || !fR.body) {
        sendJson(res, 200, { success: false, detail: `subtitle fetch failed (HTTP ${fR.status})` });
        return;
      }
      if (Number(fR.headers.get('content-length') || 0) > MAX_SUB_BYTES) {
        fR.body.cancel?.();
        sendJson(res, 200, { success: false, detail: 'that file is too large to be a subtitle' });
        return;
      }
      const reader = fR.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > MAX_SUB_BYTES) {
          reader.cancel();
          sendJson(res, 200, { success: false, detail: 'that file is too large to be a subtitle' });
          return;
        }
        chunks.push(value);
      }
      const buf = Buffer.concat(chunks);
      let text = buf.toString('utf8');
      if (text.includes('�')) text = buf.toString('latin1'); // common for older .srt files
      sendJson(res, 200, { success: true, text });
      return;
    }

    // ---- Raw pass-through endpoints (Phase 4b; kept for compatibility) ----
    let upstream;
    if (urlPath === '/torbox/checkcached') {
      upstream = await fetch(`${TORBOX_API}/torrents/checkcached?format=object&list_files=true`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashes: Array.isArray(body.hashes) ? body.hashes : [] }),
      });
    } else if (urlPath === '/torbox/createtorrent') {
      const form = new FormData();
      form.set('magnet', String(body.magnet || ''));
      upstream = await fetch(`${TORBOX_API}/torrents/createtorrent`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
    } else if (urlPath === '/torbox/requestdl') {
      const q = new URLSearchParams({ token: apiKey, torrent_id: String(body.torrent_id ?? '') });
      if (body.file_id != null) q.set('file_id', String(body.file_id));
      upstream = await fetch(`${TORBOX_API}/torrents/requestdl?${q}`);
    } else {
      sendJson(res, 404, { success: false, detail: 'unknown torbox endpoint' });
      return;
    }
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    res.end(text);
  } catch {
    sendJson(res, 502, { success: false, detail: 'TorBox API unreachable from server' });
  }
}

module.exports = { handleTorbox };
