// Promise-based confirm. window.confirm() is the same API family as
// window.prompt() — the call that turned out to hang Electron's renderer
// silently, no error, nothing in the console (see app.js's display-name
// fix). Rather than trust confirm() is any more reliable, this replaces it
// everywhere: a real overlay, styled to match the app instead of a native
// browser dialog.

export function confirmDialog(message, { okLabel = 'Yes', cancelLabel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const scrim = document.createElement('div');
    scrim.className = 'confirm-scrim';

    const box = document.createElement('div');
    box.className = 'confirm-box';

    const p = document.createElement('p');
    p.className = 'confirm-msg';
    p.textContent = message;

    const row = document.createElement('div');
    row.className = 'confirm-row';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn ghost';
    cancelBtn.textContent = cancelLabel;
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'btn';
    okBtn.textContent = okLabel;
    row.append(cancelBtn, okBtn);

    box.append(p, row);
    scrim.append(box);
    document.body.append(scrim);

    const done = (result) => {
      document.removeEventListener('keydown', onKey);
      scrim.remove();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
      else if (e.key === 'Enter') done(true);
    };
    document.addEventListener('keydown', onKey);
    cancelBtn.addEventListener('click', () => done(false));
    okBtn.addEventListener('click', () => done(true));
    // Click on the backdrop itself (not the box) counts as cancel.
    scrim.addEventListener('click', (e) => {
      if (e.target === scrim) done(false);
    });
    okBtn.focus();
  });
}
