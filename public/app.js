// CoWatch client — orchestrator.
// Routes /r/<id> into a room, wires every subsystem onto a shared context, and
// kicks off start-up side effects. The behavior lives in the modules under
// js/ (core = signaling/media/sync, modes = screen/sync/search/torlink, ui =
// controls/tiles/chat/settings/reactions/ptt/pip, lib = dom/torbox). Each
// module is a small createX(ctx) factory that owns its state and registers an
// API on the hub.

import { $ } from './js/lib/dom.js';
import { createControls } from './js/ui/controls.js';
import { createTiles } from './js/ui/tiles.js';
import { createSignaling } from './js/core/signaling.js';
import { createMedia } from './js/core/media.js';
import { createNetStats } from './js/core/netstats.js';
import { createSync } from './js/core/sync.js';
import { createTracks } from './js/modes/tracks.js';
import { createScreen } from './js/modes/screen.js';
import { createSyncMode } from './js/modes/sync.js';
import { createSearch } from './js/modes/search.js';
import { createTorlink } from './js/modes/torlink.js';
import { createReactions } from './js/ui/reactions.js';
import { createPtt } from './js/ui/ptt.js';
import { createPip } from './js/ui/pip.js';
import { createSettings } from './js/ui/settings.js';
import { createChat } from './js/ui/chat.js';

const roomMatch = location.pathname.match(/^\/r\/([\w-]{4,64})$/);

if (roomMatch) {
  enterRoom(roomMatch[1]);
} else {
  showLanding();
}

function showLanding() {
  $('landing').hidden = false;
  $('create-room').addEventListener('click', () => {
    location.href = `/r/${randomRoomId()}`;
  });
}

function randomRoomId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10);
}

// Display name: asked once, kept in localStorage, shown under camera tiles
// and in "<name> is sharing" / chat labels.
function getDisplayName() {
  let name = (localStorage.getItem('display_name') || '').trim();
  if (!name) {
    if (typeof window.prompt === 'function') {
      name = (window.prompt('Enter your name for this room:') || '').trim().slice(0, 24);
    }
    if (!name) name = `Guest-${Math.random().toString(36).slice(2, 6)}`;
    localStorage.setItem('display_name', name);
  }
  return name;
}

function enterRoom(roomId) {
  $('room').hidden = false;
  $('room-link').value = location.href;

  // Shared context hub. Siblings call across it at runtime (ctx.media.getPcs(),
  // ctx.controls.notice(), …). ctx.els are the chat nodes the Document PiP
  // companion relocates out of the main document — held as stable references
  // so modules never re-query them by id after the move. (The camera grid is
  // held by tiles.js the same way.)
  const ctx = {
    roomId,
    displayName: getDisplayName(),
    els: {
      messages: $('messages'),
      sendForm: $('send-form'),
    },
  };

  // Construction only defines APIs + attaches listeners; nothing cross-module
  // fires yet except tiles→controls.updateLayout, so controls precedes tiles.
  ctx.controls = createControls(ctx);
  ctx.tiles = createTiles(ctx);
  ctx.signaling = createSignaling(ctx);
  ctx.media = createMedia(ctx);
  ctx.netstats = createNetStats(ctx);
  ctx.syncCore = createSync(ctx);
  ctx.tracks = createTracks(ctx);
  ctx.screen = createScreen(ctx);
  ctx.syncMode = createSyncMode(ctx);
  ctx.search = createSearch(ctx);
  ctx.torlink = createTorlink(ctx);
  ctx.reactions = createReactions(ctx);
  ctx.ptt = createPtt(ctx);
  ctx.pip = createPip(ctx);
  ctx.settings = createSettings(ctx);
  ctx.chat = createChat(ctx);

  ctx.tiles.ensureTile('self', ctx.displayName); // you're always on the grid

  // Start-up side effects, deferred out of construction so every module's API
  // is registered before anything fires.
  ctx.signaling.start(); // connect the signaling socket + join the room
  ctx.media.start(); // acquire camera/mic
  ctx.netstats.start(); // begin polling the connection-quality indicator

  // Dev/debug handle (also used by automated smoke tests).
  window.__cowatch = {
    get pc() {
      return ctx.media.getAnyPc(); // first peer's pc (2-person compatibility)
    },
    get peers() {
      return [...ctx.media.getPcs()].map(([id, pc]) => ({
        id,
        name: ctx.signaling.getMemberName(id),
        state: pc.connectionState,
        polite: ctx.media.isPolite(id),
      }));
    },
    get selfId() {
      return ctx.signaling.getSelfId();
    },
    get player() {
      return ctx.syncCore.getPlayer();
    },
    get mode() {
      return ctx.controls.getMode();
    },
    get sourceMode() {
      return ctx.syncMode.getSourceMode();
    },
    get pipWindow() {
      return ctx.pip.getPipWindow();
    },
    get shareBaton() {
      return ctx.signaling.getShareBaton();
    },
    get peerPresent() {
      return ctx.signaling.isPeerPresent();
    },
    signal: (msg) => ctx.signaling.signal(msg),
  };
}
