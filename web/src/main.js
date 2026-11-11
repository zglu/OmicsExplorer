// Bootstrap.
import { init } from './app.js';

// Theme -------------------------------------------------------------------
(function themeBoot() {
  const saved = localStorage.getItem('theme');
  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  document.documentElement.dataset.theme = saved || (prefersLight ? 'light' : 'dark');
})();

// Tooltip follows the mouse ------------------------------------------------
document.addEventListener('mousemove', (ev) => {
  const tip = document.getElementById('tooltip');
  if (!tip || tip.style.display === 'none') return;
  const pad = 14;
  let x = ev.clientX + pad;
  let y = ev.clientY + pad;
  const rect = tip.getBoundingClientRect();
  if (x + rect.width > window.innerWidth - 8) x = ev.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = ev.clientY - rect.height - pad;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
});

init().catch((err) => {
  console.error(err);
  const busy = document.getElementById('busy');
  if (busy) {
    busy.textContent = 'Failed to start: ' + err.message;
    busy.style.display = 'block';
  }
});
