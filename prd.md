# CoWatch — Product Requirements Document

*(codename — rename to taste)*

**Version:** 0.1 (draft for build handoff)
**Owner:** you
**Implementer:** an AI coding model (this doc is written to be read by one)

---

## 1. Summary

A two-person "watch together" web app. One person (**the sharer**) shares a video source from their screen or a browser tab; the other person (**the watcher**) sees that video live. Both people share their **camera and microphone** so they can see and hear each other's reactions while watching. Think "Discord screen-share with cameras," but purpose-built for two people watching a movie together.

It is intentionally small: two participants, no accounts, connect via a shared room link.

---

## 2. Goals

- Let two remote people watch the same video at the same time, in sync, with zero manual "3… 2… 1… play" coordination (sync is automatic because the watcher sees the sharer's live stream).
- Let both people see and hear each other via webcam + mic during the whole session.
- Be joinable in seconds: open a link, allow camera, share screen, done.
- Work over the public internet between two home connections.

## 3. Non-goals (explicitly out of scope — do not build these)

- No more than 2 participants. No group rooms, no SFU/media-server scaling. Pure peer-to-peer mesh is fine and expected.
- No user accounts, passwords, profiles, or persistence. Rooms are ephemeral.
- No content hosting, catalog, search, or library. The app never sources, stores, or transcodes video — it only relays whatever is already on the sharer's screen.
- No playback-sync engine, no streaming-site DOM hooks, no browser extension. The screen-share model makes all of that unnecessary.
- No recording of the session.

## 4. Users & primary use case

Just two specific people (you + one other person), long-distance, wanting a movie-night feel. Both are on desktop/laptop with a webcam. The sharer plays a video in whatever player or tab they already use and shares that window; the watcher watches and both keep cameras on.

## 5. Content & legal note (read once, then move on)

This is content-agnostic screen-sharing technology — the same category as Discord, Google Meet, or Zoom screen share. The app does not host, source, decode, or store any video; it only relays the sharer's own screen. Responsibility for having the right to view and share any given content rests with the two users.

One hard technical constraint that follows from this: **DRM-protected streaming services (Netflix, Disney+, Crave, Prime Video, etc.) generally cannot be screen-shared** — their protected media path (HDCP/EME) renders a **black frame** to anyone capturing the screen. So in practice this app works with **non-DRM sources**: local video files played in a desktop player, your own recordings, and unprotected web video. Design and test around that reality; don't waste effort trying to defeat DRM (it won't work and isn't in scope).

## 6. Functional requirements (MVP, prioritized)

**P0 — must have**
1. A landing screen where a user creates a room (gets a shareable link/code) or joins one.
2. On join, request camera + mic permission and show a local self-view.
3. Establish a peer-to-peer WebRTC connection between the two participants.
4. Two-way camera + mic: each person sees/hears the other.
5. The sharer can start a screen/tab/window share (`getDisplayMedia`); the watcher sees it live as the main view.
6. Basic layout: large "shared video" pane + two small camera tiles (picture-in-picture style).
7. Mute-mic and camera-off toggles for each user.
8. Graceful handling of denied permissions and dropped connections (clear status messages).

**P1 — nice to have**
9. Optional text chat sidebar (reuses the signaling channel).
10. Share system audio along with the screen (so the watcher hears the movie, not just the room).
11. "Swap view" — let either person promote a camera tile to full size.
12. Reconnect logic if the P2P link drops.

**P2 — later**
13. Push-to-talk / audio ducking.
14. Simple emoji reactions overlaid on the video.

## 7. User flow

1. Sharer opens the app → clicks **Create room** → gets a link → sends it to the watcher.
2. Both open the app, grant camera + mic. Each sees their own self-view.
3. The signaling handshake completes; the two cameras connect. They can now see/hear each other.
4. Sharer clicks **Share screen**, picks the window/tab playing the movie, optionally ticks "share audio."
5. Watcher's main pane switches to the shared video. Cameras stay as small tiles.
6. They watch. Either can toggle mic/cam or leave. Leaving tears down the room.

## 8. Technical architecture

Three moving parts:

- **Client** — a web app that runs in both browsers. Captures camera/mic (`getUserMedia`) and screen (`getDisplayMedia`), manages the `RTCPeerConnection`, and renders remote streams. No extension required.
- **Signaling server** — a tiny WebSocket server. Its only jobs are (a) matching the two peers into a room and (b) relaying the WebRTC handshake messages (offer, answer, ICE candidates) between them. It never sees any video/audio.
- **STUN/TURN** — STUN (Google's free public server) helps each peer discover its public address for NAT traversal. TURN relays media when a direct P2P connection can't be established (strict firewalls/NATs). TURN is the one component that costs money/bandwidth.

Because there are only two participants, this is a **single peer-to-peer connection** — no media server. All video/audio flows directly browser-to-browser (or via TURN as fallback).

### Media / track plan

- **Sharer sends:** camera track + mic track + (on demand) screen-video track + optional screen-audio track.
- **Watcher sends:** camera track + mic track.
- Both render all remote tracks. When the sharer adds the screen track mid-session, renegotiate the connection (new offer/answer) rather than reconnecting.

## 9. Signaling protocol (WebSocket message types)

Keep it minimal. Messages are JSON `{ type, ...payload }`:

- `join` — `{ room }` — client asks to enter a room.
- `peer-joined` — server tells the first peer that the second has arrived (trigger to create the offer).
- `offer` — `{ sdp }` — relayed from caller to callee.
- `answer` — `{ sdp }` — relayed back.
- `ice-candidate` — `{ candidate }` — trickled both ways throughout.
- `peer-left` — `{ }` — the other side disconnected; tear down and show status.
- `chat` (P1) — `{ text }` — relayed text message.

The server holds at most 2 sockets per room and rejects a third join. It stores no state beyond the live room membership.

## 10. Recommended tech stack

- **Client:** a single-page web app. Vanilla JS is enough, but React is fine if preferred. Use raw `RTCPeerConnection`, or wrap it with `simple-peer` / `peerjs` to cut boilerplate. No framework lock-in needed.
- **Signaling server:** Node.js + the `ws` library. ~100 lines. Runs on the homelab.
- **STUN:** `stun:stun.l.google.com:19302` (free).
- **TURN:** not used by default (STUN-only direct P2P). If a connection fails to establish, add a **hosted** TURN provider (Metered, Cloudflare, Twilio) — read credentials from environment variables, never hardcode. Avoid self-hosted `coturn`, which would need a port-forward that re-exposes the home IP.
- **Hosting:** self-hosted on the owner's homelab. The frontend (static) and the signaling server run on the homelab box.

### Deployment & access (self-hosted)

There is **no browser-extension distribution and no app-store submission** — it's a web app. The watcher accesses it by opening a URL the sharer sends them; nothing to install.

**Hard requirement:** `getUserMedia`/`getDisplayMedia` only work in a **secure context**, so the app must be served over **real HTTPS with a valid certificate** (a bare IP or self-signed cert will cause the browser to block camera/screen capture). This means a domain name + valid TLS is mandatory, not optional.

**Chosen exposure method: Cloudflare Tunnel (`cloudflared`).** The `cloudflared` daemon on the homelab makes an *outbound* connection to Cloudflare — no inbound port is opened and the home IP is never published in DNS. It provides automatic valid HTTPS and works behind CGNAT. It carries the static frontend and the WebSocket signaling. Do **not** use port-forwarding (rejected — it would expose the home IP).

*(Alternatives, not chosen: Caddy + port-forward — rejected because it exposes the IP; Tailscale — viable for max privacy but requires the watcher to install Tailscale, breaking the "just open a link" flow.)*

**Privacy model (decided): hide from the public internet only.**

- Hosting is hidden from the public via the tunnel — good.
- The **camera/screen call is peer-to-peer**, so during a call the two browsers exchange public IPs to connect directly. The **watcher's browser will see the sharer's home IP** (and vice-versa). This is **accepted** — it's one trusted person, not the public.
- Therefore the app uses **normal STUN-based direct P2P** (`stun:stun.l.google.com:19302`). Do **not** force `iceTransportPolicy: 'relay'`, and TURN is not required for privacy.

**TURN note:** since the app runs through Cloudflare Tunnel (HTTP-oriented, won't carry TURN's UDP), keep to **STUN-only direct P2P**, which succeeds in most home-to-home cases. Only if a real connection fails to establish, add TURN via a **hosted provider** (avoids a coturn port-forward that would re-expose the IP).

## 11. Build phases (build & verify each before moving on)

**Phase 1 — Signaling + rooms.** Stand up the WebSocket server. Two browser tabs can join the same room code and exchange arbitrary relayed messages. *Done when:* a message typed in tab A appears in tab B via the server.

**Phase 2 — Camera-to-camera call.** Add `getUserMedia`, `RTCPeerConnection`, and the offer/answer/ICE handshake over the Phase-1 channel. *Done when:* two tabs (ideally two devices) show each other's live camera + audio, peer-to-peer.

**Phase 3 — Screen share.** Sharer adds a `getDisplayMedia` track and renegotiates; watcher renders it as the main view. *Done when:* a video playing on the sharer's screen appears live on the watcher's side (test with a local file — remember DRM sources go black).

**Phase 4 — Layout & controls.** Big shared-video pane + camera tiles; mic/cam toggles; connection-status UI; permission-error handling.

**Phase 5 — Robustness & TURN fallback.** Test between two genuinely different networks (not just two tabs); add reconnect handling; wire in hosted TURN only if a connection won't establish.

**Phase 6 — Polish (P1/P2 as desired).** Text chat, screen audio, swap-view, reactions.

## 12. Key risks & constraints

- **DRM black screen** (Section 5) — the biggest gotcha. Set expectations: this is for non-DRM content.
- **TURN cost/setup** — direct P2P works for most home-to-home connections. If a connection needs a relay, use a hosted TURN provider (a few dollars/month); don't self-host `coturn` (port-forward would re-expose the IP).
- **Screen-share bandwidth** — sharing HD video uses real upstream bandwidth on the sharer's connection. If it's choppy, cap the shared resolution/framerate.
- **Browser permissions** — `getUserMedia`/`getDisplayMedia` require HTTPS (secure context) and explicit user permission. Handle denials gracefully.
- **Echo** — if system audio is shared and both mics are open, you can get echo. Consider auto-ducking or a push-to-talk in P2.

## 13. Resolved decisions (locked — build to these)

1. **Platform: web app.** No desktop/Electron build, no browser extension, no app-store submission. Runs as a web app served from the homelab.
2. **Room model: random unguessable link.** Generate a random room ID (e.g. `/r/8f3k9a`). No accounts, no codes to type. Optionally allow a custom room name, but not required for MVP.
3. **Text chat: deferred to P1.** MVP is video/audio only — voice covers communication. Text chat can be added later over the existing signaling socket.
4. **TURN: STUN-only direct P2P; hosted TURN only if a connection fails.** Ship STUN-only (works for most home-to-home connections). If a real connection can't establish, add TURN via a **hosted provider** — not self-hosted `coturn`, which would need a port-forward that re-exposes the home IP. Do **not** force relay for privacy (the P2P-reveals-IP-to-partner tradeoff is accepted). See the Privacy model in the Deployment section.
5. **Name:** TBD by owner (placeholder: "CoWatch"). Not a blocker.

## 14. Success criteria

- Two people on different home networks can, within ~60 seconds of opening a link, see each other on camera and have one of them share a (non-DRM) video the other watches live, with acceptable A/V quality and no manual sync.
- Toggling mic/camera works for both.
- A dropped connection produces a clear status message rather than a silent freeze.

---

## 15. Guidelines for the implementer

- **Stay in scope.** This is a 2-person, peer-to-peer, no-accounts app. If a task seems to call for an SFU, a database, auth, or a media server, stop — you've drifted; re-read the non-goals.
- **Build phase by phase (Section 11).** Get each phase working end-to-end before starting the next. Don't scaffold all six phases at once.
- **Ask before assuming** on anything not pinned down by Section 13 (e.g. framework preference within the web-app choice, exact UI layout) rather than guessing. The platform, room model, chat scope, TURN approach, and privacy model are already locked — build to them.
- **Secrets via environment variables** — TURN credentials and any config never go in source.
- **Fail loudly and kindly** — every `getUserMedia`/`getDisplayMedia`/connection path needs a visible error state, not a silent hang.
- **Test in Chrome first**, then verify Firefox. Test Phase 2+ across two real devices, not just two tabs on one machine (NAT behavior differs).
- **Don't try to work around DRM.** If a shared streaming tab shows black, that's expected — document it, don't fight it.
- **Keep the signaling server dumb.** It relays and matches; it holds no media and minimal state.

---

## 16. Phase 4 revision — screen-share tuning (4a) + Sync mode (4b)

*(Replaces the original Phase 4. Existing camera/chat/screen-share behavior must keep working.)*

### Phase 4a — screen-share tuning (Mode A)

1. Set `contentHint = 'motion'` on the screen video track.
2. Cap the screen sender's `maxBitrate` via `RTCRtpSender` encoding parameters — start at 2.5 Mbps, easy to adjust.
3. Cap `getDisplayMedia` constraints to 1080p / 30 fps max.
4. UI guidance to share the **video tab**, not the whole screen, plus an indicator of what is currently being shared.
5. Picture-in-Picture: while sharing, the sharer can pop the **partner's camera** into a floating PiP window (Picture-in-Picture API) so it hovers over fullscreen content without entering the shared capture (true for tab/window shares; a monitor share inherently captures it).

### Phase 4b — Sync mode (Mode B)

Mode toggle: **"Share my screen"** vs **"Watch together (sync)"**. Sync mode takes a pasted URL / magnet / info-hash:

- **YouTube** → IFrame Player API (`playVideo`/`pauseVideo`/`seekTo`, `onStateChange`).
- **Vimeo** → Vimeo Player SDK.
- **Direct `.mp4`/`.webm`/`.m3u8`** → our own `<video>` element.
- **TorBox** (magnet `magnet:?xt=urn:btih:…` or 40-char hex hash):
  - Per-user API key, stored in `localStorage` only.
  - `POST /v1/api/torrents/checkcached` (hashes list) → cached? file list; `createtorrent` to add; `GET /v1/api/torrents/requestdl?torrent_id=…` → direct URL, played in native `<video>`.
  - Resolved URL is shared to the peer; if the peer has their own key they resolve the magnet themselves (handles IP-locked links).
  - Errors: IP-locked/expired → "This link requires your own TorBox account — paste the same link in your app to sync." Not cached → "Not cached — TorBox will download it first. Check back later." No key → "Enter your TorBox API key to resolve magnets."
- **Anything else** → "Sync mode supports YouTube, Vimeo, direct video links, and TorBox magnets. For anything else, use Share screen instead."

**Sync protocol** over the existing WebSocket: `{type:'sync', action:'play'|'pause'|'seek', time, rate}` — symmetric (whoever acts broadcasts, the other follows), with echo suppression so applying a received event doesn't re-broadcast. Include a **Resync** button.

**Layout:** video main pane; camera tiles + chat in a sidebar.

**Acceptance tests:** YouTube play/pause/seek sync within ~500 ms; direct mp4 syncs; TorBox cached magnet resolves and syncs; uncached shows downloading status; IP-locked shows own-account message; unsupported URL shows the message without crashing; 4a: smoother framerate on constrained uplink, PiP camera absent from the shared feed (tab/window shares).