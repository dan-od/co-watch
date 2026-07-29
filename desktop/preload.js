// Bridge between the shell and the page. Deliberately tiny: the page is
// ordinary web content with no Node access, so this exposes exactly two things
// — the room-server address, and a way to change it.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__cowatchDesktop', {
  isDesktop: true,
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('cowatch:get-settings'),
  setSignaling: (value) => ipcRenderer.invoke('cowatch:set-signaling', value),
  // navigator.clipboard needs the document focused and silently rejects when it
  // isn't — measured. Copy is how the room code reaches a friend, so it goes
  // through Electron's clipboard, which always works.
  copy: (text) => ipcRenderer.invoke('cowatch:copy', String(text ?? '')),
  // Called from the Room menu. A prompt is enough for one address, and keeps
  // the shell from needing a settings window of its own.
  promptSignaling: async (current) => {
    const next = window.prompt(
      'Room server address — everyone watching together must use the same one.\n' +
        'Example: https://your-tunnel.trycloudflare.com\n\n' +
        'Leave empty to keep rooms on this machine only.',
      current || ''
    );
    if (next === null) return; // cancelled
    await ipcRenderer.invoke('cowatch:set-signaling', next);
  },
});
