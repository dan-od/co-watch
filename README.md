# CoWatch

Two-person "watch together" web app: WebRTC peer-to-peer camera/mic + screen
share + synced playback, with a tiny Node + `ws` signaling server. No accounts;
rooms are ephemeral random links. See [cowatch-prd.md](cowatch-prd.md) for the
full spec.

The whole app is one fixed window (no page scroll): a top bar (wordmark, status
dot, **Share / Sync** tabs, room link, TorBox settings gear), a stage (video +
collapsible chat rail + square camera tiles — partner ringed amber), and a
bottom control bar (mode action on the left; Pop out / mic / camera / chat /
leave on the right). Warm cinema palette, squared corners, Space Grotesk
wordmark.

## Run

```
npm install
npm start          # serves http://localhost:8080
```

Create a room on the landing page and open the `/r/<id>` link in a second
browser/device.

> **HTTPS required for real use:** `getUserMedia` only works in a secure
> context. `localhost` counts; anything else needs real HTTPS (the PRD's
> deployment plan is Cloudflare Tunnel).

## Configuration (environment variables)

Copy `.env.example` to `.env` and fill in. `.env` is gitignored — real
credentials never go in source (PRD §15). Real environment variables override
`.env` values.

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP/WebSocket port (default `8080`). |
| `TURN_URLS` | Comma-separated TURN URLs from a hosted provider (Metered, Cloudflare, Twilio). Unset → STUN-only. |
| `TURN_USERNAME` | TURN username. |
| `TURN_CREDENTIAL` | TURN credential/password. |
| `FORCE_RELAY` | Set to `1` to force all media through TURN (`iceTransportPolicy: 'relay'`). **Testing only.** |
| `TMDB_API_KEY` | Optional server-wide TMDb key for the metadata search; a key entered in Settings overrides it. |

The server exposes the resulting ICE configuration to clients at
`/ice-config`. Google STUN (`stun:stun.l.google.com:19302`) is always
included; TURN entries are appended when the three `TURN_*` vars are set.
Note that TURN credentials served this way are visible to anyone who can open
a room link — that's inherent to browser TURN; use provider credentials you
can rotate.

## Watching together — two modes

**Cameras.** Your partner's camera is the primary overlay tile; your own
self-view is a half-size thumbnail beside it with a `×` toggle to hide it
entirely (a small "Self" chip brings it back). The Document PiP pop-out
carries the partner cam + chat only.

**Sharing is symmetric.** Either person can share — there is no room-owner
role anywhere in the app. A server-arbitrated share "baton" allows one active
sharer at a time: while one person shares, the other's button reads "Partner
is sharing"; the baton releases when the sharer stops or their connection
dies. Simultaneous clicks resolve deterministically — the first claim to
reach the server wins.

**Share (Mode A).** The sharer picks a tab/window via the browser picker; the
watcher sees it live. Tuned for video: capture capped at 1080p/30fps, encoder
favors motion (`contentHint='motion'`), sender bitrate capped (2.5 Mbps
default — adjust `SCREEN_MAX_BITRATE` at the top of `public/app.js`). The call
uses `selfBrowserSurface:'exclude'` so the CoWatch tab isn't offered as a
capture source (no hall-of-mirrors) and `preferCurrentTab:false`. Share the
**tab** playing the video, not the whole screen: smoother, can carry tab audio,
keeps the rest of your screen private, and keeps the Document PiP companion out
of the shared feed (a whole-monitor share would capture it — the in-app
indicator warns you).

**Pop out (Document Picture-in-Picture).** The bottom-bar "Pop out" button opens
a floating always-on-top window holding the **partner camera + chat**, so the
sharer can fullscreen the movie and still see/talk to their friend. Chrome/Edge
only — on Firefox/Safari the button is disabled with a tooltip. Closing the
window returns the camera and chat to the main layout.

**Watch together / sync (Mode B).** Paste a link; both players stay in sync
(play/pause/seek relayed over the room's WebSocket, target ~½ s). Supported
sources:

| Input | Player |
| --- | --- |
| YouTube URL (`youtube.com`, `youtu.be`) | YouTube IFrame API |
| Vimeo URL | Vimeo Player SDK |
| Direct `.mp4` / `.webm` / `.m3u8` URL | Native `<video>` (the host must allow cross-site playback; `.m3u8` plays natively only in Safari) |
| Magnet link or 40-char torrent hash | TorBox → resolved to a direct URL, played in native `<video>` |
| Anything else | Not supported — use Share screen |

In Sync mode a **URL / TorBox / Search** toggle sits next to the input.
**Resync** pushes your current position/state to your friend.

### Metadata search & watchlist (Phase 4e)

The **Search** source browses TMDb metadata — posters, year, rating,
overview — for movies and TV shows, with a local **watchlist** (browser
localStorage). It is metadata only: the app never fetches, resolves, or
discovers content from a search result. To watch something you still paste
your own link or magnet in the URL/TorBox source; the "Go to paste" button
in a result's detail view jumps there. If you load a magnet right after
selecting a result, the app remembers the association and shows
"Now watching: <title>" for that hash from then on.

Requires a free TMDb API key (Settings → TMDb API key; stored in this
browser only, sent per-request through the server's `/api/tmdb/search`
proxy). Alternatively set `TMDB_API_KEY` in `.env` server-wide.

### TorBox

Open **TorBox settings** (the gear in the top bar), paste your API key, and
click **Save** — it validates against TorBox and shows **Valid** (green) or
**Invalid** (red). The key is stored in `localStorage` only and sent
per-request through this server's `/torbox/*` proxy (the TorBox API isn't
CORS-enabled for browsers); the server never stores or logs it. Get your key
from torbox.app/dashboard.

Flip the input to **TorBox** mode, paste a magnet link or 40-char hash, and
click **Load**: the app fetches the torrent, lists its video files in a
dropdown (largest picked by default), resolves the chosen file to a direct
stream URL, and plays it in a native `<video>` that syncs like any other
source. When one person loads a magnet, the other's app resolves the same
magnet with **their own** key — TorBox download links are IP-locked, so each
side needs its own; if the other side has no key it falls back to the sharer's
URL and shows a clear message if TorBox rejects it. Uncached torrents are added
to your account and start downloading — check back later.

Server routes: `/torbox/check` (validate key), `/torbox/fetch` (torrent
metadata + files), `/torbox/load` (file → stream URL). The raw Phase-4b
pass-throughs (`/torbox/checkcached`, `/createtorrent`, `/requestdl`) remain for
compatibility.

## Robustness (Phase 5)

- **Heartbeat:** the server pings every WebSocket every 25 s (`HEARTBEAT_MS`
  env to override) and terminates sockets that miss two pongs. This keeps the
  signaling socket warm through Cloudflare Tunnel (which closes idle
  WebSockets) and reaps dead clients promptly.
- **Auto-reconnect:** if the signaling socket drops, the client reconnects
  with exponential backoff (1s → 2s → 4s → 8s, capped at 15s), rejoins the
  same room, and resumes — no manual refresh. The P2P call is independent of
  the socket, so media usually keeps flowing straight through a signaling
  blip; a `peer-left` gets a 12 s grace window before anything is torn down.
- **ICE restart:** if the media connection goes `disconnected`/`failed`, the
  client waits ~3 s (it often self-heals) then performs an ICE restart via
  the normal perfect-negotiation flow — tracks are never torn down.
- **Network indicator:** the top bar shows live call quality from
  `getStats()` polled every 2 s — Good (<150 ms RTT, <2% loss), Fair
  (150–300 ms or 2–5%), Poor (above). Hover for raw RTT / loss / bitrate plus
  the signaling and ICE states.
- **Connection log:** the server appends one JSON line per
  connect/join/close/heartbeat-terminate to `logs/connections.log`
  (gitignored), with ISO timestamps, close code + reason, room id, and socket
  lifetime — check here first when diagnosing disconnects.

## Testing that TURN works

1. In `.env`, uncomment `FORCE_RELAY=1`.
2. Restart the server (`npm start`). Startup logs confirm:
   `FORCE_RELAY is ON — all media will go through TURN (testing mode).`
3. Open a room in two tabs/devices. If cameras connect, media is flowing
   through the TURN relay (direct P2P is disabled in this mode), so TURN
   works.
4. Comment `FORCE_RELAY=1` back out and restart. Normal mode tries direct
   P2P first and only falls back to TURN when necessary.

## Build phases (PRD §11)

- [x] Phase 1 — signaling server + rooms (relayed messages)
- [x] Phase 2 — camera-to-camera call (perfect negotiation, STUN + TURN fallback)
- [ ] Phase 3 — screen share
- [x] Phase 4a — screen-share tuning (bitrate cap, contentHint, tab-capture self-exclude)
- [x] Phase 4b — sync mode (YouTube / Vimeo / direct video / TorBox)
- [x] Phase 4c — single-window restyle, Document PiP companion, TorBox UI
- [x] Phase 4e — metadata search & watchlist (TMDb; metadata only — no content discovery)
- [x] Phase 5 — robustness (heartbeat, auto-reconnect, ICE restart, network indicator, connection log)
- [ ] Phase 6 — polish (chat, screen audio, swap view)
