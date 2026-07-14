// Environment detection shared across modules (Part 4: mobile support).
// "Mobile" = the PRIMARY pointer is coarse (phones/tablets). A desktop with a
// touchscreen keeps pointer:fine and stays on the desktop experience.

export const isMobile = () =>
  typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

// Installed as a PWA (standalone) — no browser chrome to reclaim.
export const isStandalone = () =>
  (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) ||
  navigator.standalone === true; // iOS Safari's non-standard flag
