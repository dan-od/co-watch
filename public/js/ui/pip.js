// Document Picture-in-Picture companion (Phase 4c).
// Pops the partner cam + chat into a floating always-on-top window (Chrome/Edge
// only). The moved nodes are the stable ctx.els references so the rest of the
// app keeps addressing them after the move.

import { $, tryPlay } from '../lib/dom.js';

export function createPip(ctx) {
  const { remote: elRemote, messages: elMessages, sendForm: elSendForm } = ctx.els;
  let pipWindow = null;
  const pipSupported = 'documentPictureInPicture' in window;
  if (!pipSupported) {
    $('popout').disabled = true;
    $('popout').title = 'Pop-out needs Chrome or Edge (Document Picture-in-Picture).';
  }

  $('popout').addEventListener('click', async () => {
    if (!pipSupported) return;
    if (pipWindow) {
      pipWindow.close();
      return;
    }
    ctx.controls.setSwapped(false); // the partner cam is about to move into the pop-out
    try {
      pipWindow = await documentPictureInPicture.requestWindow({ width: 300, height: 420 });
    } catch (err) {
      ctx.controls.notice(`Pop-out failed: ${err.message || err}`, 'warn', 5000);
      return;
    }
    // Copy stylesheets — the PiP document doesn't inherit the page's CSS.
    for (const sheet of document.styleSheets) {
      try {
        const css = [...sheet.cssRules].map((r) => r.cssText).join('\n');
        const style = pipWindow.document.createElement('style');
        style.textContent = css;
        pipWindow.document.head.append(style);
      } catch {
        if (sheet.href) {
          const link = pipWindow.document.createElement('link');
          link.rel = 'stylesheet';
          link.href = sheet.href;
          pipWindow.document.head.append(link);
        }
      }
    }
    pipWindow.document.body.className = 'pip-body';
    // Move the partner cam + chat into the PiP window.
    pipWindow.document.body.append(elRemote, elMessages, elSendForm);
    $('popout').classList.add('active');
    $('popout').title = 'Close pop-out';
    tryPlay(elRemote);
    pipWindow.addEventListener('pagehide', restoreFromPip);
  });

  function restoreFromPip() {
    if (!pipWindow) return;
    // Put the moved nodes back in their original places.
    $('partner-wrap').prepend(elRemote);
    $('chat-rail').append(elMessages, elSendForm);
    $('popout').classList.remove('active');
    $('popout').title = 'Pop partner cam + chat into a floating window';
    tryPlay(elRemote);
    pipWindow = null;
  }

  return {
    getPipWindow: () => pipWindow,
    close: () => {
      if (pipWindow) pipWindow.close();
    },
  };
}
