# CoWatch — Product Requirements Document

**Version:** 0.4 (two-mode; Phases 1–4 built, restyle + Document PiP + TorBox/Stremio integration pending)
**Owner:** you
**Implementer:** an AI coding model (this doc is written to be read by one)

---

## 1. Summary

A two-person "watch together" web app. Both people share their **camera and microphone** so they can see and hear each other's reactions while watching, and there are **three ways to watch**:

- **Mode A — Share:** one person shares a browser tab/window and the pixels are relayed to the other. Works for anything on the sharer's own screen; costs some latency; DRM tabs go black.
- **Mode B — Sync:** both browsers independently load the same URL (YouTube, Vimeo, or a direct video file) and the app keeps their players in step with tiny messages. No video is transmitted → zero lag, no DRM problem.
- **Mode C — TorBox/Stremio:** both browsers independently load content from debrid/TorBox/Stremio sources, with the app handling the fetching and syncing. This combines the best of both modes: no DRM issues, no screen-sharing latency, and access to a vast library of content.

Think "Discord screen-share with cameras" *plus* "Teleparty-style synced playback" *plus* "debrid-powered streaming," in one small app. It is intentionally small: two participants, no accounts, connect via a shared room link, self-hosted.

---

## 2. Goals

- Let two remote people watch the same video at the same time, in sync, with zero manual "3… 2… 1… play" coordination.
- Let both people see and hear each other via webcam + mic during the whole session.
- Be joinable in seconds: open a link, allow camera, share screen, done.
- Work over the public internet between two home connections.
- **Support content from debrid services (TorBox, Real-Debrid) and Stremio add-ons**, making any content accessible without DRM limitations.

---

## 3. Non-goals (explicitly out of scope — do not build these)

- No more than 2 participants. No group rooms, no SFU/media-server scaling. Pure peer-to-peer mesh is fine and expected.
- No user accounts, passwords, profiles, or persistence. Rooms are ephemeral.
- No content hosting, catalog, search, or library. The app never sources, stores, or transcodes video — it only fetches and relays what users request.
- No streaming-site DOM hooks, no browser extension.
- No recording of the session.
- **No syncing of arbitrary third-party sites.** The same-origin policy makes it technically impossible for a web page to control another site's player. Sync mode supports only the sources listed in §16 plus the debrid/stremio sources.

---

## 4. Users & primary use case

Just two specific people (you + one other person), long-distance, wanting a movie-night feel. Both are on desktop/laptop with a webcam. They want to watch anything together without DRM limitations.

---

## 5. Content & legal note (read once, then move on)

The app provides **debrid integration** (TorBox, Real-Debrid, Stremio) as a core feature. Debrid services act as multi-hoster downloaders — they have cached copies of popular content and can fetch content from various sources. The app uses these services' APIs to fetch content that both users can sync.

**Responsibility:** The app is content-agnostic. Users are responsible for ensuring they have the right to access and share content. The app merely facilitates playback of content users have access to through their debrid accounts.

**Technical benefits of debrid integration:**
- No DRM issues (content is fetched as direct video files)
- Both users can sync with zero latency
- Vast content library accessible
- High-quality streams (1080p/4K available)

---

## 6. Functional requirements (MVP, prioritized)

**P0 — must have**
1. A landing screen where a user creates a room (gets a shareable link/code) or joins one.
2. On join, request camera + mic permission and show a local self-view.
3. Establish a peer-to-peer WebRTC connection between the two participants.
4. Two-way camera + mic: each person sees/hears the other.
5. **TorBox/Stremio integration:** The ability to load content from TorBox (magnet links, torrent hashes, direct links) and Stremio add-ons.
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

---

## 7. User flow

1. Sharer opens the app → clicks **Create room** → gets a link → sends it to the watcher.
2. Both open the app, grant camera + mic. Each sees their own self-view.
3. The signaling handshake completes; the two cameras connect. They can now see/hear each other.
4. **Sharer enters TorBox/Stremio content** → pastes a magnet link, torrent hash, or Stremio add-on link → clicks Load.
5. The app fetches the content from the debrid service and both users sync playback.
6. They watch. Either can toggle mic/cam or leave. Leaving tears down the room.

---

## 8. Technical architecture

Three moving parts:

- **Client** — a web app that runs in both browsers. Captures camera/mic (`getUserMedia`) and screen (`getDisplayMedia`), manages the `RTCPeerConnection`, renders remote streams, and handles debrid API calls.
- **Signaling server** — a tiny WebSocket server. Its only jobs are (a) matching the two peers into a room and (b) relaying the WebRTC handshake messages and sync control messages.
- **Debrid integration layer** — server-side API routes that handle:
  - TorBox API key validation
  - Magnet link/torrent hash fetching
  - File selection and stream URL generation
  - Stremio add-on integration
  - Caching of fetched content (optional)

Because there are only two participants, this is a **single peer-to-peer connection** — no media server. All video/audio flows directly browser-to-browser (or via TURN as fallback).

### Media / track plan

- **Sharer sends:** camera track + mic track + (on demand) screen-video track + optional screen-audio track.
- **Watcher sends:** camera track + mic track.
- Both render all remote tracks. When the sharer adds the screen track mid-session, renegotiate the connection.

---

## 9. Signaling protocol (WebSocket message types)

Keep it minimal. Messages are JSON `{ type, ...payload }`:

- `join` — `{ room }` — client asks to enter a room.
- `peer-joined` — server tells the first peer that the second has arrived.
- `offer` — `{ sdp }` — relayed from caller to callee.
- `answer` — `{ sdp }` — relayed back.
- `ice-candidate` — `{ candidate }` — trickled both ways.
- `peer-left` — `{ }` — the other side disconnected.
- `sync` — `{ action:'play'|'pause'|'seek', time:number }` — sync control messages.
- `chat` — `{ text }` — relayed text message.

---

## 10. TorBox & Stremio Integration (Detailed)

### TorBox API Integration

**API Endpoints (server-side routes):**
```
POST /api/torbox/validate
- Body: { apiKey: string }
- Response: { valid: boolean, message: string }

POST /api/torbox/fetch
- Body: { apiKey: string, magnetLink?: string, torrentHash?: string }
- Response: { 
    success: boolean, 
    files: Array<{ name: string, size: number, index: number }>,
    torrentId: string 
  }

POST /api/torbox/load
- Body: { apiKey: string, torrentId: string, fileIndex: number }
- Response: { 
    success: boolean, 
    streamUrl: string, 
    fileName: string,
    duration: number 
  }
```

**UI Components:**
- API Key input field (masked, with "Show" toggle)
- Magnet link / torrent hash input (single unified field)
- File selection dropdown (shown after fetching)
- Load progress indicator
- Error messages for invalid keys, invalid links, no video files

**Flow:**
1. User enters API key (saved in localStorage)
2. User pastes magnet link or torrent hash
3. App calls `/api/torbox/fetch` with the key and link
4. App displays list of video files found
5. User selects a file
6. App calls `/api/torbox/load` to get the stream URL
7. Both users sync to this stream URL

### Stremio Integration (Future)

**Stremio add-on support:**
- Users can add Stremio add-on URLs
- The app queries the add-on for content metadata and streams
- Streams are fetched and sync'd like TorBox content

**Stremio protocol:**
```
POST /api/stremio/manifest
- Body: { addonUrl: string }
- Response: { manifest: object }

POST /api/stremio/stream
- Body: { addonUrl: string, type: 'movie'|'series', id: string }
- Response: { streams: Array<{ name: string, url: string }> }
```

---

## 11. Build phases (build & verify each before moving on)

**Phase 1 — Signaling + rooms.** Stand up the WebSocket server. Two browser tabs can join the same room code and exchange arbitrary relayed messages.

**Phase 2 — Camera-to-camera call.** Add `getUserMedia`, `RTCPeerConnection`, and the offer/answer/ICE handshake over the Phase-1 channel.

**Phase 3 — Screen share.** Sharer adds a `getDisplayMedia` track and renegotiates; watcher renders it as the main view.

**Phase 4a — Screen-share tuning.** On the screen video track set `contentHint = 'motion'`; cap the sender's `maxBitrate`; cap `getDisplayMedia` to 1080p/30. Add UI guidance to share the *video tab* rather than the whole screen.

**Phase 4b — Sync mode.** URL-synced playback for YouTube, Vimeo, direct `.mp4`, and **TorBox/Stremio content**.

**Phase 4c — Restyle + Document PiP + tab-capture.** Restyle to the single-window design. Add the Document Picture-in-Picture companion. Change screen capture to `selfBrowserSurface: 'exclude'`.

**Phase 4d — Debrid integration.** Add TorBox API endpoints, UI components, and sync flow for debrid content. Add Stremio add-on support.

**Phase 5 — Robustness.** Test across two genuinely different networks; add reconnect handling; verify hosted-TURN fallback.

**Phase 6 — Polish (P1/P2 as desired).** Text chat, screen audio, swap-view, reactions.

---

## 12. Key risks & constraints

- **Debrid API reliability** — TorBox/Stremio APIs may have rate limits or downtime. Handle gracefully with retries and clear error messages.
- **Content availability** — Not all content is cached on debrid services. Show clear status when content is being fetched/cached.
- **Stream URL expiration** — Some debrid services use expiring URLs. Implement refresh logic or extend URLs.
- **Bandwidth** — High-quality streams use bandwidth. Provide quality selection options.

---

## 13. Resolved decisions (locked — build to these)

1. **Platform: web app.** No desktop/Electron build, no browser extension, no app-store submission.
2. **Room model: random unguessable link.** Generate a random room ID (e.g. `/r/8f3k9a`).
3. **Text chat: deferred to P1.** MVP is video/audio only — voice covers communication.
4. **TURN: STUN-only direct P2P; hosted TURN only if a connection fails.**
5. **Debrid integration: server-side API routes with client-side UI.** API keys stored in localStorage.
6. **Name:** TBD by owner (placeholder: "CoWatch").

---

## 14. Success criteria

- Two people on different home networks can, within ~60 seconds of opening a link, see each other on camera and watch a video from TorBox/Stremio together in perfect sync.
- Toggling mic/camera works for both.
- A dropped connection produces a clear status message rather than a silent freeze.

---

## 15. Guidelines for the implementer

- **Stay in scope.** This is a 2-person, peer-to-peer, no-accounts app with debrid integration.
- **Build phase by phase.** Get each phase working end-to-end before starting the next.
- **Debrid API keys are sensitive.** Store in localStorage only, never in logs or source code.
- **Fail loudly and kindly** — every API call, permission request, and connection path needs a visible error state.
- **Test in Chrome first**, then verify Firefox. Test across two real devices.
- **Cache debrid responses** where possible to avoid hitting API limits.

---

## 16. Supported Sources (Full List)

### Mode A — Share (screen relay)
- **Anything on the sharer's screen** — works for all content including DRM (but DRM goes black)

### Mode B — Sync (URL-synced playback)
1. **YouTube** — via the official IFrame Player API
2. **Vimeo** — via the Vimeo Player SDK
3. **Direct hosted video files** — `.mp4`/`.webm` at a stable URL

### Mode C — Debrid/Stremio (New)
4. **TorBox** — magnet links, torrent hashes, direct links
5. **Real-Debrid** (future) — similar to TorBox
6. **Stremio add-ons** — content from Stremio add-on streams

**For any unsupported URL:** show *"Sync mode supports YouTube, Vimeo, direct video links, and TorBox/Stremio content. For anything else, use Share screen instead."*

---

## 17. UI / design direction

**One fixed window, no scrolling.** The entire app lives in a single fixed-height frame. Users switch between Share, Sync, and **Debrid** tabs; the stage swaps *in place*.

**Three stacked regions:**
- **Top bar** — wordmark, connection status (a small colored dot + "Connected"/"Synced" text), centered **mode tabs** (Share | Sync | Debrid) as underlined tabs, room link + copy on the right.
- **Stage** — the video area on the left; a collapsible Chat rail (~186px) on the right; camera tiles overlaying the video area's bottom-right, square corners.
- **Bottom control bar** — left = the mode-specific action:
  - **Share tab:** "Share a tab" button + inline hint
  - **Sync tab:** URL input + Load + Resync
  - **Debrid tab:** API key input (masked), magnet/torrent input, Load button, file selector

**Visual style — deliberately not "AI-generic":**
- **Squared, not rounded.** ≤2px radius on controls/inputs/buttons, ~4px on the outer frame, **0px (fully square) on camera tiles.**
- **Warm cinema palette — no blue/purple.** Reference values: bg `#141109`, panel `#1E1910`, panel-2 `#282117`, text `#F0E9DA`, accent/amber `#E4A63F`, danger `#CB5A3E`.
- **Type:** wordmark + mode tabs in Space Grotesk; body in system-ui.

---

## 18. API Reference (TorBox)

### TorBox API Integration Details

**Authentication:**
- Users provide their TorBox API key (available at torbox.app/dashboard)
- API key stored in localStorage
- All TorBox requests include `Authorization: Bearer {apiKey}` header

**Endpoints to implement:**

```
POST /api/torbox/check
- Validates API key by calling TorBox's status endpoint
- Returns { valid: boolean, plan?: string }

POST /api/torbox/fetch
- Fetches torrent metadata from magnet link or hash
- Returns { files: [{ name, size, index }], torrentId: string }

POST /api/torbox/select
- Selects a file from a torrent
- Returns { streamUrl: string, name: string, duration: number }

POST /api/torbox/download
- Triggers download of a file (for caching purposes)
- Returns { status: 'queued'|'downloading'|'ready' }
```

**Error Handling:**
- `INVALID_KEY` — API key invalid or expired
- `INVALID_LINK` — Magnet link or torrent hash invalid
- `NO_VIDEO_FILES` — No video files found in torrent
- `CONTENT_UNAVAILABLE` — Content not cached or unavailable
- `RATE_LIMITED` — Too many requests, wait and retry

**Caching Strategy:**
- Cache torrent metadata for 24 hours
- Cache stream URLs for 6 hours
- Store in server memory or Redis

---

## 19. Implementation Plan (Updated)

**Build order with new features:**

1. **Phase 1-3** (Existing) — Signaling, camera, screen share
2. **Phase 4b** (Sync mode) — YouTube, Vimeo, direct files
3. **Phase 4d** (Debrid integration) — TorBox API, UI, sync flow
4. **Phase 4c** (Restyle) — New design with Debrid tab
5. **Phase 4a** (Tuning) — Screen-share improvements
6. **Phase 5** (Robustness) — Error handling, fallbacks
7. **Phase 6** (Polish) — Extra features

**Stretch Goals:**
- Real-Debrid integration
- Stremio add-on support (via Stremio's add-on protocol)
- Quality selection (1080p, 4K, etc.)
- Subtitle support from debrid services

---

