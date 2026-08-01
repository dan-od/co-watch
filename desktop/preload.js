// Bridge between the shell and the page. Deliberately tiny: the page is
// ordinary web content with no Node access, so this exposes exactly the room-
// server address (read/write) and a clipboard write.
//
// Nothing here calls window.prompt() or window.alert(). Electron's renderer
// does not reliably implement either — one hung the whole page silently
// before this was found (see public/app.js and public/js/ui/settings.js for
// what replaced them: a real input on the landing page, and a field in the
// existing Settings panel).

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
});
