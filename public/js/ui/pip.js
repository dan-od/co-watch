// Document Picture-in-Picture companion (Phase 4c, mesh-aware).
// Pops the camera grid + chat into a floating always-on-top window (Chrome/
// Edge only). The moved nodes are stable references — tiles.js holds its own
// grid element and chat uses ctx.els — so the rest of the app keeps working
// while they live in the PiP document.

import { $, tryPlay } from '../lib/dom.js';
import { isMobile } from '../lib/env.js';

export function createPip(ctx) {
  const { messages: elMessages, sendForm: elSendForm } = ctx.els;
  let pipWindow = null;
  const pipSupported = 'documentPictureInPicture' in window && !isMobile();
  if (isMobile()) {
    $('popout').hidden = true; // Document PiP is a desktop feature
  } else if (!pipSupported) {
    $('popout').disabled = true;
    $('popout').title = 'Pop-out needs Chrome or Edge (Document Picture-in-Picture).';
  }

  $('popout').addEventListener('click', async () => {
    if (!pipSupported) return;
    if (pipWindow) {
      pipWindow.close();
      return;
    }
    try {
      pipWindow = await documentPictureInPicture.requestWindow({ width: 340, height: 480 });
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
    // Move the camera grid + chat into the PiP window.
    pipWindow.document.body.append(ctx.tiles.getGridEl(), elMessages, elSendForm);
    $('popout').classList.add('active');
    $('popout').title = 'Close pop-out';
    ctx.tiles.playAll();
    pipWindow.addEventListener('pagehide', restoreFromPip);
  });

  function restoreFromPip() {
    if (!pipWindow) return;
    // Put the moved nodes back in their original places.
    $('stage-main').append(ctx.tiles.getGridEl());
    $('chat-rail').append(elMessages, elSendForm);
    $('popout').classList.remove('active');
    $('popout').title = 'Pop cameras + chat into a floating window';
    ctx.tiles.playAll();
    pipWindow = null;
  }

  return {
    getPipWindow: () => pipWindow,
    close: () => {
      if (pipWindow) pipWindow.close();
    },
  };
}
