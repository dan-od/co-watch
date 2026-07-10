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
- [ ] Phase 4 — layout & controls
- [ ] Phase 5 — robustness
- [ ] Phase 6 — polish (chat, screen audio, swap view)
