// CoWatch desktop shell (Mac + Windows).
//
// WHY this exists. In a browser we could not win: Chrome and Firefox never
// shipped Dolby decoders, Safari cannot open .mkv at all, and — the one that
// actually blocked us — several debrid hosts answer a SERVER 403/404 while
// serving the same link to the machine that asked for it. Repairing audio
// server-side needs the server to read the file, and it was not allowed to.
//
// So each viewer runs their own copy. The existing Node server boots inside the
// app on a loopback port, which means stream lookup and audio repair happen on
// the viewer's own machine, against the viewer's own IP — the device the link
// was issued to. That single change removes the wall we spent two days hitting.
//
// Only the ROOM is shared. Signaling (membership, chat, sync, WebRTC handshake)
// still needs one address everybody can reach, so the shell injects it and the
// client uses it for the WebSocket only. Media never goes through it.

const { app, BrowserWindow, shell, dialog, Menu, ipcMain, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
// Settings and logs must live outside the application bundle — it is read-only
// once installed.
const DATA_DIR = app.getPath('userData');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

process.env.COWATCH_LOG_DIR = path.join(DATA_DIR, 'logs');
process.env.COWATCH_ENV_FILE = path.join(DATA_DIR, '.env');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function writeSettings(next) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  } catch (err) {
    console.warn('[desktop] could not save settings:', err.message);
  }
}

let win = null;
let serverPort = null;

async function boot() {
  // Port 0: the OS picks a free one, so two instances (or a browser copy
  // already on 8080) never collide.
  const { start } = require(path.join(ROOT, 'server', 'server.js'));
  const { port } = await start({ port: 0, host: '127.0.0.1' });
  serverPort = port;
  return port;
}

function createWindow(port) {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#141109', // matches the app, so no white flash on launch
    title: 'CoWatch',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false, // the page is ordinary web content; keep it that way
      sandbox: false, // preload needs `require` for the settings bridge
    },
  });

  // Screen sharing: Electron needs an explicit answer to getDisplayMedia, or
  // the picker never appears and Share silently does nothing.
  win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    win.webContents.executeJavaScript('void 0').catch(() => {});
    // Let Chromium's own picker run; audio: 'loopback' shares system sound on
    // Windows, which is what people expect when sharing a video.
    callback({ video: request.frame, audio: process.platform === 'win32' ? 'loopback' : undefined });
  });

  // Camera and microphone are the whole point of the app — grant them, and
  // refuse everything else rather than leaving the default open.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write'].includes(permission));
  });

  // Links to real websites belong in the real browser, not in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${serverPort}`) && !url.startsWith(`http://localhost:${serverPort}`)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  win.on('closed', () => (win = null));
  win.loadURL(`http://127.0.0.1:${port}/`);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Room',
      submenu: [
        // Where the room lives is set from the in-page Settings panel (gear
        // icon), not here. It used to be a menu item that called
        // window.prompt() from the renderer — Electron does not reliably
        // support that call, and it hung the whole page the same way the
        // display-name prompt did, with no error to show for it.
        { role: 'reload' },
        { role: 'toggleDevTools' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('cowatch:copy', (_e, text) => {
  clipboard.writeText(String(text ?? ''));
  return true;
});
ipcMain.handle('cowatch:get-settings', () => readSettings());
ipcMain.handle('cowatch:set-signaling', (_e, value) => {
  const next = { ...readSettings(), signaling: String(value || '').trim() };
  writeSettings(next);
  win?.reload();
  return next;
});

// One instance only: a second launch focuses the window we already have,
// instead of starting a second server and a second set of transcodes.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      const port = await boot();
      buildMenu();
      createWindow(port);
    } catch (err) {
      dialog.showErrorBox('CoWatch could not start', String(err?.stack || err));
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (!win && serverPort) createWindow(serverPort);
  });
  app.on('before-quit', () => {
    // Kill any running conversion and delete its segments, rather than leaving
    // ffmpeg holding a debrid connection after the window is gone.
    try {
      require(path.join(ROOT, 'server', 'server.js')).stop();
    } catch {}
  });
}
