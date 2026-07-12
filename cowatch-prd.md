CoWatch — Product Requirements Document
Version: 0.5 (two-mode + debrid + search; Phases 1–4 built, Phase 4e pending)
Owner: you
Implementer: an AI coding model (this doc is written to be read by one)

1. Summary
A two-person "watch together" web app. Both people share their camera and microphone so they can see and hear each other's reactions while watching, and there are four ways to watch:

Mode A — Share: one person shares a browser tab/window and the pixels are relayed to the other. Works for anything on the sharer's own screen; costs some latency; DRM tabs go black.

Mode B — Sync: both browsers independently load the same URL (YouTube, Vimeo, or a direct video file) and the app keeps their players in step with tiny messages. No video is transmitted → zero lag, no DRM problem.

Mode C — Debrid: both browsers independently load content from TorBox (magnet links, torrent hashes, direct links) with the app handling the fetching and syncing. No DRM issues, no screen-sharing latency, access to a vast library of content.

Mode D — Search: users search for movies/TV shows by title, browse results with posters, and watch with one click. Powered by TMDb + TorBox Voyager API. No need to find magnet links elsewhere.

Think "Discord screen-share with cameras" plus "Teleparty-style synced playback" plus "debrid-powered streaming" plus "search and watch." It is intentionally small: two participants, no accounts, connect via a shared room link, self-hosted.

2. Goals
Let two remote people watch the same video at the same time, in sync, with zero manual "3… 2… 1… play" coordination.

Let both people see and hear each other via webcam + mic during the whole session.

Be joinable in seconds: open a link, allow camera, share screen, done.

Work over the public internet between two home connections.

Support content from debrid services (TorBox) with search-by-title, making any content accessible without DRM limitations.

3. Non-goals (explicitly out of scope — do not build these)
No more than 2 participants. No group rooms, no SFU/media-server scaling. Pure peer-to-peer mesh is fine and expected.

No user accounts, passwords, profiles, or persistence. Rooms are ephemeral.

No content hosting, catalog, search, or library. The app never sources, stores, or transcodes video — it only fetches and relays what users request.

No streaming-site DOM hooks, no browser extension.

No recording of the session.

No syncing of arbitrary third-party sites. The same-origin policy makes it technically impossible for a web page to control another site's player. Sync mode supports only the sources listed in §16.

4. Users & primary use case
Just two specific people (you + one other person), long-distance, wanting a movie-night feel. Both are on desktop/laptop with a webcam. They want to watch anything together without DRM limitations.

5. Content & legal note (read once, then move on)
The app provides debrid integration (TorBox) as a core feature. Debrid services act as multi-hoster downloaders — they have cached copies of popular content and can fetch content from various sources. The app uses these services' APIs to fetch content that both users can sync.

Responsibility: The app is content-agnostic. Users are responsible for ensuring they have the right to access and share content. The app merely facilitates playback of content users have access to through their debrid accounts.

Technical benefits of debrid integration:

No DRM issues (content is fetched as direct video files)

Both users can sync with zero latency

Vast content library accessible

High-quality streams (1080p/4K available)

6. Functional requirements (MVP, prioritized)
P0 — must have

A landing screen where a user creates a room (gets a shareable link/code) or joins one.

On join, request camera + mic permission and show a local self-view.

Establish a peer-to-peer WebRTC connection between the two participants.

Two-way camera + mic: each person sees/hears the other.

TorBox integration: The ability to load content from TorBox (magnet links, torrent hashes, direct links).

Search integration: Search for movies/TV shows by title using TMDb + TorBox Voyager.

Basic layout: large "shared video" pane + two small camera tiles (picture-in-picture style).

Mute-mic and camera-off toggles for each user.

Graceful handling of denied permissions and dropped connections (clear status messages).

P1 — nice to have

Optional text chat sidebar (reuses the signaling channel).

Share system audio along with the screen (so the watcher hears the movie, not just the room).

"Swap view" — let either person promote a camera tile to full size.

Reconnect logic if the P2P link drops.

P2 — later

Push-to-talk / audio ducking.

Simple emoji reactions overlaid on the video.

7. User flow
Sharer opens the app → clicks Create room → gets a link → sends it to the watcher.

Both open the app, grant camera + mic. Each sees their own self-view.

The signaling handshake completes; the two cameras connect. They can now see/hear each other.

Mode C (Debrid): Sharer pastes a magnet link, torrent hash, or uses Search to find content.

Mode D (Search): User types a title → sees poster grid → selects → TorBox resolves → loads.

The app fetches the content and both users sync playback.

They watch. Either can toggle mic/cam or leave. Leaving tears down the room.

8. Technical architecture
Four moving parts:

Client — a web app that runs in both browsers. Captures camera/mic (getUserMedia) and screen (getDisplayMedia), manages the RTCPeerConnection, renders remote streams, and handles debrid/search API calls.

Signaling server — a tiny WebSocket server. Its only jobs are (a) matching the two peers into a room and (b) relaying the WebRTC handshake messages and sync control messages.

Debrid integration layer — server-side API routes that handle TorBox API key validation, magnet link/torrent hash fetching, file selection, and stream URL generation.

Search integration layer — server-side API routes that proxy TMDb (title→ID) and TorBox Voyager (ID→streamable files).

Because there are only two participants, this is a single peer-to-peer connection — no media server. All video/audio flows directly browser-to-browser (or via TURN as fallback).

Media / track plan
Sharer sends: camera track + mic track + (on demand) screen-video track + optional screen-audio track.

Watcher sends: camera track + mic track.

Both render all remote tracks. When the sharer adds the screen track mid-session, renegotiate the connection.

9. Signaling protocol (WebSocket message types)
Keep it minimal. Messages are JSON { type, ...payload }:

join — { room } — client asks to enter a room.

peer-joined — server tells the first peer that the second has arrived.

offer — { sdp } — relayed from caller to callee.

answer — { sdp } — relayed back.

ice-candidate — { candidate } — trickled both ways.

peer-left — { } — the other side disconnected.

sync — { action:'play'|'pause'|'seek', time:number } — sync control messages.

chat — { text } — relayed text message.

10. TorBox Integration (Detailed)
TorBox API Integration
API Endpoints (server-side routes):

text
POST /api/torbox/check
- Validates API key
- Body: { apiKey: string }
- Response: { valid: boolean, plan?: string }

POST /api/torbox/fetch
- Fetches torrent metadata from magnet link or hash
- Body: { apiKey: string, magnetLink?: string, torrentHash?: string }
- Response: { files: [{ name, size, index }], torrentId: string }

POST /api/torbox/select
- Selects a file from a torrent
- Body: { apiKey: string, torrentId: string, fileIndex: number }
- Response: { streamUrl: string, name: string, duration: number }

POST /api/torbox/download
- Triggers download of a file (for caching purposes)
- Body: { apiKey: string, torrentId: string, fileIndex: number }
- Response: { status: 'queued'|'downloading'|'ready' }
UI Components:

API Key input field (masked, with "Show" toggle)

Magnet link / torrent hash input (single unified field)

File selection dropdown (shown after fetching)

Load progress indicator

Error messages for invalid keys, invalid links, no video files

Flow:

User enters API key (saved in localStorage)

User pastes magnet link or torrent hash

App calls /api/torbox/fetch with the key and link

App displays list of video files found

User selects a file

App calls /api/torbox/select to get the stream URL

Both users sync to this stream URL

11. Search & Discovery (Title → Stream)
Overview: Users can search for movies and TV shows by title, browse results with posters, and start watching — all from within the app. No need to find magnet links elsewhere.

Architecture (Two-Stage Hybrid):

Stage 1: TMDb — Converts a title ("The Matrix") into a TMDb ID

Endpoint: GET /3/search/movie?query={title} and GET /3/search/tv?query={title}

Returns: id, title, year, poster_path, overview, vote_average

Stage 2: TorBox Voyager API — Converts TMDb ID into streamable files

Endpoint: POST /v1/api/search/metadata

Body: { tmdb_id: 603, type: 'movie', cached_only: true }

Returns: items with file names, sizes, hashes, file IDs

Also supports TV shows: { tmdb_id: 1399, type: 'tv', season: 1, episode: 1 }

Existing TorBox resolve flow — requestdl → direct URL → sync mode

API Endpoints (server-side)
text
GET /api/tmdb/search/movie?query={title}&year={year}
- Proxies TMDb search/movie endpoint
- Headers: x-tmdb-key (optional, falls back to env var)

GET /api/tmdb/search/tv?query={title}&year={year}
- Proxies TMDb search/tv endpoint
- Headers: x-tmdb-key (optional, falls back to env var)

POST /api/torbox/voyager
- Proxies TorBox search/metadata endpoint
- Body: { tmdb_id, type, season, episode, cached_only }
- Headers: x-torbox-key (from user's stored API key)
UI Flow
text
┌─────────────────────────────────────────────────────────┐
│  🔍 Search    📎 Paste Link                           │
│  ──────────                                           │
│  [Search for a movie or show...]  [🔍 Search]         │
│                                                        │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐                     │
│  │Poster│ │Poster│ │Poster│ │Poster│                     │
│  │Title │ │Title │ │Title │ │Title │                     │
│  │2024  │ │2023  │ │2024  │ │2022  │                     │
│  │[Movie]│ │[TV]  │ │[Movie]│ │[TV]  │                     │
│  └─────┘ └─────┘ └─────┘ └─────┘                     │
│                                                        │
│  [After clicking result: shows file list]              │
│  ┌──────────────────────────────────────────────┐      │
│  │ The Matrix (1999) [1080p]  5.2GB  [Watch]   │      │
│  │ The Matrix (1999) [720p]   2.1GB  [Watch]   │      │
│  │ The Matrix (1999) [4K]     18GB   [Watch]   │      │
│  └──────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────┘
API Keys
TMDb: Users can enter their own key in Settings, OR app uses a shared key (built into server env)

TorBox: Existing API key input (already built)

TV Show Support
Search → select TV show → app shows season/episode selector

User selects season/episode → TorBox Voyager fetches that specific episode

Sync mode starts with that episode

Error Handling
Scenario	User Message
No TMDb key (and no shared key)	"Search requires a TMDb API key. Enter one in Settings or use the Paste Link option."
No TorBox key	"Please enter your TorBox API key in Settings to search."
No search results	"No results found for '{query}'. Try different keywords."
TMDb API rate limited	"Search is temporarily rate-limited. Please wait a moment and try again."
No cached content in TorBox	"This content isn't cached yet. TorBox will download it. Check back in a few minutes."
Voyager API error	"Could not fetch content from TorBox. Try pasting a magnet link instead."
Content unavailable	"This content is not available on TorBox. Try a different source."
Implementation Files
text
server/
  routes/
    tmdb-proxy.js      # New: proxy endpoints for TMDb API
    torbox-voyager.js  # New: proxy for TorBox Voyager API

public/
  js/
    search.js          # New: search UI + TMDb client + Voyager client
    debrid-tab.js      # Update: add search sub-tab
    sync-mode.js       # Update: accept search results as input

public/
  css/
    search.css         # New: search results grid + file list styles
Caching Strategy
TMDb search results: cache for 1 hour (server-side)

TorBox Voyager results: cache for 6 hours (server-side)

Poster images: use TMDb CDN, browser cache handles it

Testing Requirements
Search: Type "The Matrix" → TMDb returns correct results with posters

Select Movie: Click a result → TorBox Voyager returns cached files

Watch: Click "Watch" → resolves to direct URL → loads in player → syncs with peer

TV Show: Search "Breaking Bad" → select season 1 episode 1 → works

Fallback: If no cached content, shows helpful message with option to paste magnet

No API keys: Shows setup prompt, doesn't crash

Two devices: Both peers see the same search results, both can select and watch

What NOT to Build
No custom indexer setup UI (BYOI can be added later via Settings)

No torrent search engine (TorBox Voyager handles this)

No subtitle scraping (can be added later)

No user authentication system (keep simple)

No content catalog or library (user drives the search)

Future Extensions
IMDb/Trakt integration for watchlists

Subtitle search (opensubtitles)

Quality filtering (only show 1080p+, or 4K)

Language filtering

Trending/popular shows (TMDb trending endpoint)

12. Build phases (build & verify each before moving on)
Phase 1 — Signaling + rooms. Stand up the WebSocket server. Two browser tabs can join the same room code and exchange arbitrary relayed messages.

Phase 2 — Camera-to-camera call. Add getUserMedia, RTCPeerConnection, and the offer/answer/ICE handshake over the Phase-1 channel.

Phase 3 — Screen share. Sharer adds a getDisplayMedia track and renegotiates; watcher renders it as the main view.

Phase 4a — Screen-share tuning. On the screen video track set contentHint = 'motion'; cap the sender's maxBitrate; cap getDisplayMedia to 1080p/30. Add UI guidance to share the video tab rather than the whole screen.

Phase 4b — Sync mode. URL-synced playback for YouTube, Vimeo, direct .mp4, and TorBox content.

Phase 4c — Restyle + Document PiP + tab-capture. Restyle to the single-window design. Add the Document Picture-in-Picture companion. Change screen capture to selfBrowserSurface: 'exclude'.

Phase 4d — Debrid integration. Add TorBox API endpoints, UI components, and sync flow for debrid content.

Phase 4e — Search & Discovery. Add TMDb integration, TorBox Voyager API, and search UI in the Debrid tab. (Current phase)

Phase 5 — Robustness. Test across two genuinely different networks; add reconnect handling; verify hosted-TURN fallback.

Phase 6 — Polish (P1/P2 as desired). Text chat, screen audio, swap-view, reactions.

13. Key risks & constraints
Debrid API reliability — TorBox APIs may have rate limits or downtime. Handle gracefully with retries and clear error messages.

Content availability — Not all content is cached on debrid services. Show clear status when content is being fetched/cached.

Stream URL expiration — TorBox URLs are short-lived. Implement refresh logic or extend URLs.

Bandwidth — High-quality streams use bandwidth. Provide quality selection options.

TMDb API rate limits — Use caching and consider a shared key to avoid hitting limits.

14. Resolved decisions (locked — build to these)
Platform: web app. No desktop/Electron build, no browser extension, no app-store submission.

Room model: random unguessable link. Generate a random room ID (e.g. /r/8f3k9a).

Text chat: deferred to P1. MVP is video/audio only — voice covers communication.

TURN: STUN-only direct P2P; hosted TURN only if a connection fails.

Debrid integration: server-side API routes with client-side UI. API keys stored in localStorage.

Search: TMDb + TorBox Voyager. Two-stage hybrid architecture.

Name: TBD by owner (placeholder: "CoWatch").

15. Success criteria
Two people on different home networks can, within ~60 seconds of opening a link, see each other on camera and watch a video from TorBox or Search together in perfect sync.

Toggling mic/camera works for both.

A dropped connection produces a clear status message rather than a silent freeze.

Search returns relevant results with posters and plays the selected content.

16. Supported Sources (Full List)
Mode A — Share (screen relay)
Anything on the sharer's screen — works for all content including DRM (but DRM goes black)

Mode B — Sync (URL-synced playback)
YouTube — via the official IFrame Player API

Vimeo — via the Vimeo Player SDK

Direct hosted video files — .mp4/.webm at a stable URL

Mode C — Debrid (TorBox)
TorBox — magnet links, torrent hashes, direct links

Search — search by title → TMDb → TorBox Voyager → stream

For any unsupported URL:
Show "Sync mode supports YouTube, Vimeo, direct video links, and TorBox content. For anything else, use Share screen instead."

17. UI / design direction
One fixed window, no scrolling. The entire app lives in a single fixed-height frame. Users switch between Share, Sync, and Debrid tabs; the stage swaps in place.

Three stacked regions:

Top bar — wordmark, connection status (a small colored dot + "Connected"/"Synced" text), centered mode tabs (Share | Sync | Debrid) as underlined tabs, room link + copy on the right.

Stage — the video area on the left; a collapsible Chat rail (~186px) on the right; camera tiles overlaying the video area's bottom-right, square corners.

Bottom control bar — left = the mode-specific action:

Share tab: "Share a tab" button + inline hint

Sync tab: URL input + Load + Resync

Debrid tab: Two sub-tabs: "Search" (search bar + results) and "Paste Link" (API key input, magnet/torrent input, Load button, file selector)

Visual style — deliberately not "AI-generic":

Squared, not rounded. ≤2px radius on controls/inputs/buttons, ~4px on the outer frame, 0px (fully square) on camera tiles.

Warm cinema palette — no blue/purple. Reference values: bg #141109, panel #1E1910, panel-2 #282117, text #F0E9DA, accent/amber #E4A63F, danger #CB5A3E.

Type: wordmark + mode tabs in Space Grotesk; body in system-ui.

18. API Reference (TorBox)
TorBox API Integration Details
Authentication:

Users provide their TorBox API key (available at torbox.app/dashboard)

API key stored in localStorage

All TorBox requests include Authorization: Bearer {apiKey} header

Endpoints to implement:

text
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
Error Handling:

INVALID_KEY — API key invalid or expired

INVALID_LINK — Magnet link or torrent hash invalid

NO_VIDEO_FILES — No video files found in torrent

CONTENT_UNAVAILABLE — Content not cached or unavailable

RATE_LIMITED — Too many requests, wait and retry

Caching Strategy:

Cache torrent metadata for 24 hours

Cache stream URLs for 6 hours

Store in server memory or Redis

19. Guidelines for the implementer
Stay in scope. This is a 2-person, peer-to-peer, no-accounts app with debrid and search integration.

Build phase by phase. Get each phase working end-to-end before starting the next.

API keys are sensitive. Store in localStorage only, never in logs or source code.

Fail loudly and kindly — every API call, permission request, and connection path needs a visible error state.

Test in Chrome first, then verify Firefox. Test across two real devices.

Cache debrid responses where possible to avoid hitting API limits.

Search should feel fast — use optimistic UI, show loading states, cache results.

20. Implementation status
Phase	Status
Phase 1 — Signaling + rooms	✅ Done
Phase 2 — Camera-to-camera call	✅ Done
Phase 3 — Screen share	✅ Done
Phase 4a — Screen-share tuning	✅ Done
Phase 4b — Sync mode	✅ Done
Phase 4c — Restyle + Document PiP + tab-capture	✅ Done
Phase 4d — Debrid integration	✅ Done (TorBox)
Phase 4e — Search & Discovery	🔲 Current
Phase 5 — Robustness	✅ Done
Phase 6 — Polish	🔲 Pending
21. What's left to build
Current: Phase 4e — Search & Discovery

TMDb proxy endpoints (/api/tmdb/search/movie, /api/tmdb/search/tv)

TorBox Voyager proxy endpoint (/api/torbox/voyager)

Search UI in Debrid tab (search bar, poster grid, file list)

TV show support (season/episode selector)

API key management (TMDb key input in Settings)

Error handling and caching

Phase 6 — Polish (P1/P2)

Swap-view (promote a camera tile to the main pane)

Emoji reactions

Push-to-talk / audio ducking

(Chat and screen audio are already done)

Stretch (optional)

Real-Debrid integration (similar to TorBox)

Quality selection (1080p, 4K, etc.)

Subtitle support from debrid services

IMDb/Trakt watchlists

22. Recommended build order (from here)
Phase 4e — Search & Discovery (current — build now)

Phase 6 — Polish (swap-view, emoji reactions, push-to-talk)

Two-device real-world test (your manual verification pass)

Stretch features (optional, as desired)