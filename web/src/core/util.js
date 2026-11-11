// Small DOM / canvas / formatting helpers shared by every module.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function debounce(fn, ms = 200) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}


// ---------------------------------------------------------------- formatting

export function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + 'M';
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1) + 'k';
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

export function fmtPct(x, digits = 1) {
  if (x === null || x === undefined || Number.isNaN(x)) return '-';
  return (100 * x).toFixed(digits) + '%';
}

export function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const ax = String(a).toLowerCase().match(re) || [];
  const bx = String(b).toLowerCase().match(re) || [];
  while (ax.length && bx.length) {
    const an = ax.shift();
    const bn = bx.shift();
    const av = /^\d/.test(an) ? parseInt(an, 10) : an;
    const bv = /^\d/.test(bn) ? parseInt(bn, 10) : bn;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return ax.length - bx.length;
}

// ------------------------------------------------------------------ canvas

/** Resize a canvas for the current device pixel ratio; returns CSS size. */
export function sizeCanvas(canvas, cssWidth, cssHeight) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = cssWidth ?? canvas.clientWidth ?? 300;
  const h = cssHeight ?? canvas.clientHeight ?? 200;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: w, height: h, dpr };
}

/** Map a mouse event to CSS pixel coordinates inside a canvas. */
export function canvasPos(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * (canvas.clientWidth || rect.width),
    y: ((event.clientY - rect.top) / rect.height) * (canvas.clientHeight || rect.height),
  };
}

// ------------------------------------------------------------------- toast

let toastTimer = null;
export function toast(message, ms = 4000) {
  let node = $('#toast');
  if (!node) {
    node = el('div', 'toast');
    node.id = 'toast';
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), ms);
}

// ------------------------------------------------------------------ export

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Export a DOM node as PNG (or a PNG wrapped in an SVG document).
 * Requires html2canvas, which is loaded as a global by index.html.
 */
export function exportFigure(node, baseName, format = 'png') {
  if (typeof window.html2canvas !== 'function') {
    toast('html2canvas is not available');
    return;
  }
  const opened = [];
  let p = node;
  while (p && p !== document.body) {
    if (p.scrollWidth > p.clientWidth + 2) {
      p.classList.add('export-open');
      opened.push(p);
    }
    p = p.parentElement;
  }
  window
    .html2canvas(node, { backgroundColor: getComputedStyle(document.body).backgroundColor, scale: 2, logging: false })
    .then((canvas) => {
      opened.forEach((n) => n.classList.remove('export-open'));
      const stamp = new Date().toISOString().slice(0, 10);
      if (format === 'svg') {
        const data = canvas.toDataURL('image/png');
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}"><image href="${data}" width="${canvas.width}" height="${canvas.height}"/></svg>`;
        downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${baseName}_${stamp}.svg`);
      } else {
        canvas.toBlob((blob) => blob && downloadBlob(blob, `${baseName}_${stamp}.png`), 'image/png');
      }
    })
    .catch((err) => {
      opened.forEach((n) => n.classList.remove('export-open'));
      console.error(err);
      toast('Export failed: ' + err.message);
    });
}

/** Add a small PNG/SVG export button pair to a figure container. */
export function addExportButtons(host, baseName) {
  if (!host || host.querySelector('.export-btns')) return;
  const bar = el('div', 'export-btns');
  const png = el('button', 'export-btn', 'PNG');
  const svg = el('button', 'export-btn', 'SVG');
  png.addEventListener('click', () => exportFigure(host, baseName, 'png'));
  svg.addEventListener('click', () => exportFigure(host, baseName, 'svg'));
  bar.append(png, svg);
  host.appendChild(bar);
}
