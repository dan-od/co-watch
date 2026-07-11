# CoWatch

Two-person "watch together" web app: WebRTC peer-to-peer camera/mic (and, in a
later phase, screen share), with a tiny Node + `ws` signaling server. No
accounts; rooms are ephemeral random links. See [prd.md](prd.md) for the full spec.

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

The server exposes the resulting ICE configuration to clients at
`/ice-config`. Google STUN (`stun:stun.l.google.com:19302`) is always
included; TURN entries are appended when the three `TURN_*` vars are set.
Note that TURN credentials served this way are visible to anyone who can open
a room link — that's inherent to browser TURN; use provider credentials you
can rotate.

## Watching together — two modes

**Share my screen (Mode A).** The sharer picks a tab/window/screen via the
browser picker; the watcher sees it live. Tuned for video: the capture is
capped at 1080p/30fps, the encoder favors motion (`contentHint='motion'`),
and the screen sender's bitrate is capped (2.5 Mbps default — adjust
`SCREEN_MAX_BITRATE` at the top of `public/app.js`). Share the browser
**tab** playing the video, not the whole screen: smoother, can carry tab
audio, and keeps the rest of your screen private. While sharing, **Pop
partner cam out** floats your friend's camera in a Picture-in-Picture window
that stays visible over fullscreen video without entering a tab/window share
(a full-monitor share would capture it — the in-app indicator warns you).

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

The **Resync** button pushes your current position/state to your friend.

### TorBox

Each user pastes their own TorBox API key under **TorBox settings** in sync
mode. The key is stored in `localStorage` only and is sent per-request
through this server's `/torbox/*` proxy (the TorBox API doesn't allow
browser calls directly); the server never stores or logs it. When one person
loads a magnet, the other's app resolves the same magnet with **their own**
key — TorBox download links are IP-locked, so each side needs its own. If
the other side has no key, their app tries the sharer's resolved URL and
shows a clear message if TorBox rejects it. Uncached torrents are added to
your TorBox account and start downloading — check back later.

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
- [x] Phase 4a — screen-share tuning (bitrate cap, contentHint, PiP partner cam)
- [x] Phase 4b — sync mode (YouTube / Vimeo / direct video / TorBox) — see PRD §16
- [ ] Phase 5 — robustness
- [ ] Phase 6 — polish (chat, screen audio, swap view)
