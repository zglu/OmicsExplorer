// The scatter viewer: a WebGL2 point cloud with a 2-D overlay.
//
// Three stacked layers:
//
//   bg   2-D canvas   background image (histology) for spatial embeddings
//   gl   WebGL2       the cells themselves
//   top  2-D canvas   category labels, brush rectangle, scale bar, tooltip
//
// Interaction: wheel zooms about the cursor, left drag draws a selection
// rectangle, shift/middle drag pans, double click resets the view.

import { canvasTheme, catColor, groupColorFor, rgba, schemeColors } from '../core/palette.js';
import { canvasPos, sizeCanvas } from '../core/util.js';

const VERT = `#version 300 es
in vec2 aPos;
in vec4 aColor;
uniform vec2 uScale;
uniform vec2 uOffset;
uniform float uPointSize;
out vec4 vColor;
void main() {
  gl_Position = vec4(aPos * uScale + uOffset, 0.0, 1.0);
  gl_PointSize = uPointSize;
  vColor = aColor;
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec4 vColor;
uniform float uShape;   // 0 = circle, 1 = square
out vec4 outColor;
void main() {
  if (uShape < 0.5) {
    vec2 d = gl_PointCoord - vec2(0.5);
    if (dot(d, d) > 0.25) discard;
  }
  outColor = vColor;
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(shader));
  }
  return shader;
}

export class ScatterViewer {
  /**
   * @param {HTMLElement} container
   * @param {{onHover?:Function, onSelect?:Function, onViewChange?:Function}} opts
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;
    this.width = opts.width || 760;
    this.height = opts.height || 520;

    this.root = document.createElement('div');
    this.root.className = 'oe-plot';
    this.root.style.width = this.width + 'px';
    this.root.style.height = this.height + 'px';
    container.appendChild(this.root);

    this.bg = document.createElement('canvas');
    this.bg.className = 'oe-layer oe-bg';
    this.top = document.createElement('canvas');
    this.top.className = 'oe-layer oe-top';
    this.root.append(this.bg, this.top);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'oe-layer oe-gl';
    this.root.appendChild(this.canvas);

    this.data = null;
    this.codes = null;
    this.categories = [];
    this.groupName = '';
    this.hidden = new Set();
    this.selected = null; // Uint8Array mask
    this.expr = null;
    this.exprScaleMax = 1;
    this.scheme = 'viridis';
    this.squarePoints = false;
    this.showLabels = true;
    this.image = null;
    this.imageOpacity = 1;
    this._mode = 'pan'; // 'select' | 'pan' - panning is the default
    this.fitScale = null;
    this.view = { scale: 1, tx: 0, ty: 0 };
    this.bounds = { x0: 0, y0: 0, x1: 1, y1: 1 };
    this._ramp = schemeColors('viridis');
    this._dpr = 1;
    this._initGL();
    this._initEvents();
    this.resize();
    this._updateCursor();
  }

  // ------------------------------------------------------------------ setup

  _initGL() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
      // keep the buffer around so that html2canvas can copy the plot into the
      // exported PNG
      preserveDrawingBuffer: true,
    });
    this.gl = gl;
    if (!gl) {
      this.gl = null;
      return;
    }
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(program));
    }
    gl.useProgram(program);
    this.program = program;
    this.loc = {
      pos: gl.getAttribLocation(program, 'aPos'),
      color: gl.getAttribLocation(program, 'aColor'),
      scale: gl.getUniformLocation(program, 'uScale'),
      offset: gl.getUniformLocation(program, 'uOffset'),
      pointSize: gl.getUniformLocation(program, 'uPointSize'),
      shape: gl.getUniformLocation(program, 'uShape'),
    };

    this.posBuffer = gl.createBuffer();
    this.colorBuffer = gl.createBuffer();

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
  }

  _initEvents() {
    const top = this.top;
    let dragging = null;

    top.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const pos = canvasPos(ev, top);
      const factor = Math.exp(-ev.deltaY * 0.0015);
      this.zoomBy(factor, pos.x, pos.y);
    }, { passive: false });

    top.addEventListener('pointerdown', (ev) => {
      try {
        top.setPointerCapture(ev.pointerId);
      } catch (err) {
        /* synthetic events have no active pointer - not a problem */
      }
      const pos = canvasPos(ev, top);
      const panning = this.mode === 'pan' || ev.shiftKey || ev.button === 1 || ev.button === 2;
      dragging = panning
        ? { kind: 'pan', x: pos.x, y: pos.y, tx: this.view.tx, ty: this.view.ty }
        : { kind: 'brush', x0: pos.x, y0: pos.y, x1: pos.x, y1: pos.y, moved: false };
      this.dragging = dragging;
      if (dragging.kind === 'brush') this._drawOverlay();
      this._updateCursor();
    });

    top.addEventListener('pointermove', (ev) => {
      const pos = canvasPos(ev, top);
      if (!dragging) {
        this._hover(pos);
        return;
      }
      if (dragging.kind === 'pan') {
        this.view.tx = dragging.tx + (pos.x - dragging.x);
        this.view.ty = dragging.ty + (pos.y - dragging.y);
        this.render();
        this.opts.onViewChange?.(this.view);
        return;
      }
      dragging.x1 = pos.x;
      dragging.y1 = pos.y;
      dragging.moved = true;
      this._drawOverlay();
    });

    const finish = (ev) => {
      if (!dragging) return;
      const pos = canvasPos(ev, top);
      if (dragging.kind === 'brush') {
        if (!dragging.moved) {
          const cell = this.pick(pos.x, pos.y);
          this.opts.onSelect?.(cell, ev);
        } else {
          this._applyBrush(dragging);
          this.opts.onSelect?.(this.selectedCells(), ev, true);
        }
      }
      dragging = null;
      this.dragging = null;
      this._drawOverlay();
      this._updateCursor();
    };
    top.addEventListener('pointerup', finish);
    top.addEventListener('pointercancel', () => {
      dragging = null;
      this.dragging = null;
      this._drawOverlay();
      this._updateCursor();
    });

    top.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      this.reset();
    });

    top.addEventListener('pointerleave', () => {
      this.opts.onHover?.(null);
    });

    top.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  // ------------------------------------------------------------------- data

  /** Provide the coordinates of the current embedding. */
  setCoords(xy) {
    this.coords = xy;
    this.n = xy ? xy.length / 2 : 0;
    this._computeBounds();
    this._buildGrid();
    this._uploadPositions();
    this.fit();
  }

  /** Provide the category codes of the current grouping. */
  setCodes(codes, categories, groupName) {
    this.codes = codes;
    this.categories = categories || [];
    this.groupName = groupName || '';
    this._paintColors();
  }

  /** Hide some categories (legend click). */
  setHidden(hidden) {
    this.hidden = hidden || new Set();
    this._paintColors();
  }

  /** Set the selection mask (Uint8Array of length n). */
  setSelection(mask) {
    this.selected = mask;
    this._paintColors();
  }

  /**
   * Highlight a subset of cells (Uint8Array mask) in one colour and dim the
   * rest - used by the cell-type explorer.
   */
  setHighlight(mask, hex) {
    this.highlight = mask || null;
    this.highlightColor = hex || '#ff6b6b';
    this._paintColors();
  }

  /** Show expression values instead of categories. */
  setExpression(values, scaleMax, scheme) {
    this.expr = values || null;
    this.exprScaleMax = scaleMax || 1;
    if (scheme) {
      this.scheme = scheme;
      this._ramp = schemeColors(scheme);
    }
    this._paintColors();
  }

  /**
   * Colour the cells by a quantitative metadata column (nCount_RNA, a
   * signature score, ...).  The values are mapped onto the colour ramp.
   */
  setMetric(values, min, max, scheme) {
    this.metric = values || null;
    this.metricMin = min ?? 0;
    this.metricMax = max ?? 1;
    if (scheme) {
      this.scheme = scheme;
      this._ramp = schemeColors(scheme);
    }
    this._paintColors();
  }

  setSquarePoints(on) {
    this.squarePoints = !!on;
  }

  /** The grid pitch of the data (in data units) used to size the tiles. */
  setPointPitch(pitch) {
    this.pitch = pitch || 0;
  }

  /** The real diameter of one spot/bin (0 = use the grid pitch). */
  setPointSize(size) {
    this.dotSize = size || 0;
  }

  /**
   * Draw a scale bar.  `perUnit` is how many data units make up one physical
   * unit (for Stereo-seq the coordinates are already micrometres, so 1).
   */
  setScaleBar(spec) {
    this.scaleBar = spec || null;
    this._drawOverlay();
  }

  setLabels(on) {
    this.showLabels = !!on;
    this._drawOverlay();
  }

  /** Background image for spatial embeddings. */
  setImage(spec) {
    this.image = null;
    if (!spec) {
      this._drawBackground();
      return;
    }
    const img = new Image();
    img.onload = () => {
      this.image = { img, spec };
      this._drawBackground();
    };
    img.onerror = () => {
      console.warn('could not load image', spec.url);
    };
    img.src = spec.url;
  }

  setImageOpacity(value) {
    this.imageOpacity = value;
    this._drawBackground();
  }

  // ------------------------------------------------------------- geometry

  _computeBounds() {
    if (!this.coords || !this.n) {
      this.bounds = { x0: 0, y0: 0, x1: 1, y1: 1 };
      return;
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < this.n; i++) {
      const x = this.coords[i * 2];
      const y = this.coords[i * 2 + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    this.bounds = { x0, y0, x1, y1 };
  }

  /** Median distance between neighbouring grid columns - used to tile cells. */
  estimateGridPitch() {
    if (!this.coords || !this.n) return 0;
    const xs = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) xs[i] = this.coords[i * 2];
    const sorted = Array.from(xs).sort((a, b) => a - b);
    const diffs = [];
    for (let i = 1; i < sorted.length; i++) {
      const d = sorted[i] - sorted[i - 1];
      if (d > 0) diffs.push(d);
    }
    if (!diffs.length) return 0;
    diffs.sort((a, b) => a - b);
    return diffs[Math.floor(diffs.length / 2)];
  }

  /** Reset the view (zoom/pan) and drop the selection. */
  reset() {
    this.setSelection(null);
    this.fit();
    this.opts.onReset?.();
  }

  fit() {
    const { x0, y0, x1, y1 } = this.bounds;
    const w = Math.max(1e-9, x1 - x0);
    const h = Math.max(1e-9, y1 - y0);
    const pad = 12;
    const scale = Math.min((this.width - 2 * pad) / w, (this.height - 2 * pad) / h);
    this.fitScale = scale;
    this.view.scale = scale;
    this.view.tx = (this.width - w * scale) / 2 - x0 * scale;
    this.view.ty = (this.height + h * scale) / 2 + y0 * scale;
    this.render();
    this.opts.onViewChange?.(this.view);
  }

  zoomBy(factor, cx, cy) {
    const fit = this.fitScale || 1;
    const s1 = Math.min(fit * 200, Math.max(fit * 0.05, this.view.scale * factor));
    if (!(s1 > 0) || s1 === this.view.scale) return;
    // keep the data point under the cursor where it is.  note the y mapping
    // is mirrored (ty - y) / scale, so x and y anchor differently.
    const f = s1 / this.view.scale;
    this.view.scale = s1;
    this.view.tx = cx - (cx - this.view.tx) * f;
    this.view.ty = cy + (this.view.ty - cy) * f;
    this.render();
    this.opts.onViewChange?.(this.view);
  }

  /** Canvas pixel -> data coordinates. */
  toData(cx, cy) {
    return {
      x: (cx - this.view.tx) / this.view.scale,
      y: (this.view.ty - cy) / this.view.scale,
    };
  }

  /** Data coordinates -> canvas pixel. */
  toScreen(x, y) {
    return { x: x * this.view.scale + this.view.tx, y: -y * this.view.scale + this.view.ty };
  }

  // -------------------------------------------------------------- picking

  _buildGrid() {
    this.grid = null;
    if (!this.n) return;
    const { x0, y0, x1, y1 } = this.bounds;
    const w = Math.max(1e-9, x1 - x0);
    const h = Math.max(1e-9, y1 - y0);
    const gx = Math.max(1, Math.min(512, Math.round(Math.sqrt(this.n))));
    const gy = gx;
    const cellW = w / gx;
    const cellH = h / gy;
    const counts = new Int32Array(gx * gy + 1);
    const bucketOf = (i) => {
      const x = this.coords[i * 2];
      const y = this.coords[i * 2 + 1];
      const bx = Math.min(gx - 1, Math.max(0, Math.floor((x - x0) / cellW)));
      const by = Math.min(gy - 1, Math.max(0, Math.floor((y - y0) / cellH)));
      return by * gx + bx;
    };
    for (let i = 0; i < this.n; i++) counts[bucketOf(i) + 1]++;
    for (let i = 0; i < gx * gy; i++) counts[i + 1] += counts[i];
    const starts = counts;
    const items = new Int32Array(this.n);
    const cursor = starts.slice(0, gx * gy);
    for (let i = 0; i < this.n; i++) items[cursor[bucketOf(i)]++] = i;
    this.grid = { gx, gy, cellW, cellH, x0, y0, starts, items };
  }

  /** The cell closest to a canvas position, or -1. */
  pick(cx, cy, tolerance = 8) {
    if (!this.grid || !this.n) return -1;
    const { gx, gy, cellW, cellH, x0, y0, starts, items } = this.grid;
    const data = this.toData(cx, cy);
    const maxDist = tolerance / this.view.scale;
    const bx = Math.floor((data.x - x0) / cellW);
    const by = Math.floor((data.y - y0) / cellH);
    const span = Math.max(1, Math.ceil(maxDist / cellW));
    const spanY = Math.max(1, Math.ceil(maxDist / cellH));
    let best = -1;
    let bestD = maxDist * maxDist;
    for (let yy = by - spanY; yy <= by + spanY; yy++) {
      if (yy < 0 || yy >= gy) continue;
      for (let xx = bx - span; xx <= bx + span; xx++) {
        if (xx < 0 || xx >= gx) continue;
        const b = yy * gx + xx;
        for (let k = starts[b]; k < starts[b + 1]; k++) {
          const i = items[k];
          const dx = this.coords[i * 2] - data.x;
          const dy = this.coords[i * 2 + 1] - data.y;
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    return best;
  }

  get mode() {
    return this._mode || 'select';
  }

  set mode(m) {
    this._mode = m === 'pan' ? 'pan' : 'select';
    this._updateCursor();
  }

  _updateCursor() {
    if (!this.top) return;
    this.top.style.cursor = this.dragging ? 'grabbing' : this.mode === 'pan' ? 'grab' : 'crosshair';
  }

  _hover(pos) {
    if (!this.coords || !this.n) return;
    const cell = this.pick(pos.x, pos.y);
    this.opts.onHover?.(cell, pos);
  }

  _applyBrush(drag) {
    if (!this.coords) return;
    const x0 = Math.min(drag.x0, drag.x1);
    const x1 = Math.max(drag.x0, drag.x1);
    const y0 = Math.min(drag.y0, drag.y1);
    const y1 = Math.max(drag.y0, drag.y1);
    const mask = new Uint8Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const p = this.toScreen(this.coords[i * 2], this.coords[i * 2 + 1]);
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) mask[i] = 1;
    }
    this.setSelection(mask);
  }

  /** Indices of the currently selected cells. */
  selectedCells() {
    if (!this.selected) return [];
    const out = [];
    for (let i = 0; i < this.selected.length; i++) if (this.selected[i]) out.push(i);
    return out;
  }

  // -------------------------------------------------------------- colours

  _paintColors() {
    if (!this.n) return;
    const colors = new Uint8Array(this.n * 4);
    const theme = canvasTheme();
    const [zr, zg, zb] = hexBytes(theme.zero);
    if (this.metric) {
      const ramp = this._ramp;
      const nRamp = ramp.length / 4;
      const lo = this.metricMin ?? 0;
      const span = (this.metricMax ?? 1) - lo || 1;
      for (let i = 0; i < this.n; i++) {
        const v = this.metric[i];
        if (v === undefined || !isFinite(v)) {
          colors[i * 4] = zr; colors[i * 4 + 1] = zg; colors[i * 4 + 2] = zb; colors[i * 4 + 3] = 255;
          continue;
        }
        const t = Math.min(1, Math.max(0, (v - lo) / span));
        const idx = Math.min(nRamp - 1, Math.max(0, Math.round(t * (nRamp - 1))));
        colors[i * 4] = ramp[idx * 4];
        colors[i * 4 + 1] = ramp[idx * 4 + 1];
        colors[i * 4 + 2] = ramp[idx * 4 + 2];
        colors[i * 4 + 3] = 255;
      }
    } else if (this.expr) {
      const ramp = this._ramp;
      const nRamp = ramp.length / 4;
      const max = this.exprScaleMax || 1;
      for (let i = 0; i < this.n; i++) {
        const v = this.expr[i] || 0;
        if (v <= 0) {
          colors[i * 4] = zr; colors[i * 4 + 1] = zg; colors[i * 4 + 2] = zb; colors[i * 4 + 3] = 255;
          continue;
        }
        const t = Math.min(1, v / max);
        const idx = Math.min(nRamp - 1, Math.max(0, Math.round(t * (nRamp - 1))));
        colors[i * 4] = ramp[idx * 4];
        colors[i * 4 + 1] = ramp[idx * 4 + 1];
        colors[i * 4 + 2] = ramp[idx * 4 + 2];
        colors[i * 4 + 3] = 255;
      }
    } else if (this.codes) {
      const [dr, dg, db] = hexBytes(theme.muted);
      const hl = this.highlight;
      const [hr, hg, hb] = hexBytes(this.highlightColor || '#ff6b6b');
      for (let i = 0; i < this.n; i++) {
        if (hl) {
          const on = hl[i];
          colors[i * 4] = on ? hr : dr;
          colors[i * 4 + 1] = on ? hg : dg;
          colors[i * 4 + 2] = on ? hb : db;
          colors[i * 4 + 3] = on ? 255 : 110;
          continue;
        }
        const c = this.codes[i];
        if (c < 0 || this.hidden.has(this.categories[c])) {
          colors[i * 4] = dr; colors[i * 4 + 1] = dg; colors[i * 4 + 2] = db; colors[i * 4 + 3] = 90;
          continue;
        }
        const hex = this.groupName
          ? groupColorFor(this.groupName, this.categories[c], c)
          : catColor(this.categories[c]);
        const [r, g, b] = hexBytes(hex);
        colors[i * 4] = r; colors[i * 4 + 1] = g; colors[i * 4 + 2] = b; colors[i * 4 + 3] = 255;
      }
    } else {
      for (let i = 0; i < this.n; i++) {
        colors[i * 4] = zr; colors[i * 4 + 1] = zg; colors[i * 4 + 2] = zb; colors[i * 4 + 3] = 255;
      }
    }
    this.colors = colors;
    if (this.selected) {
      // dim everything that is not selected
      for (let i = 0; i < this.n; i++) {
        if (!this.selected[i]) colors[i * 4 + 3] = Math.min(colors[i * 4 + 3], 70);
      }
    }
    this._uploadColors();
    this.render();
  }

  // -------------------------------------------------------------- drawing

  _uploadPositions() {
    if (!this.gl || !this.coords) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.coords, gl.STATIC_DRAW);
  }

  _uploadColors() {
    if (!this.gl || !this.colors) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.colors, gl.DYNAMIC_DRAW);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._dpr = dpr;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.canvas.style.width = this.width + 'px';
    this.canvas.style.height = this.height + 'px';
    this.bg.width = Math.round(this.width * dpr);
    this.bg.height = Math.round(this.height * dpr);
    this.bg.style.width = this.width + 'px';
    this.bg.style.height = this.height + 'px';
    this.top.width = Math.round(this.width * dpr);
    this.top.height = Math.round(this.height * dpr);
    this.top.style.width = this.width + 'px';
    this.top.style.height = this.height + 'px';
    this.render();
  }

  /** Radius of one cell in CSS pixels. */
  pointSize() {
    if (!this.n) return 2;
    if (this.squarePoints) {
      // spatial bins: one square per bin, so they never overlap.  `dotSize` is
      // the real diameter of a spot (Visium: 100 um on a 200 um grid) - the
      // pitch is only the fallback.
      const pitch = this.pitch || this.estimateGridPitch();
      const unit = this.dotSize || pitch;
      if (unit > 0) {
        // no hard limit: when the user zooms in the tiles have to grow with
        // the grid, otherwise the tissue falls apart into separate dots
        const px = unit * this.view.scale;
        return Math.max(1, Math.min(512, px) * this._dpr);
      }
    }
    // How much screen space does one cell get?  The radius is derived from
    // the local density (the crowded parts of a UMAP count more), so the
    // points stay readable without covering each other.  Zooming in enlarges
    // the points, which keeps the density constant.
    const perCell = this._screenAreaPerCell();
    let radius = 0.62 * Math.sqrt(perCell / Math.PI);
    if (this.n < 400) radius = Math.min(radius, 1.8); // few cells: keep them small
    radius = Math.max(0.55, Math.min(3, radius));
    let diameter = 2 * radius; // gl_PointSize is the diameter
    // a spot with a known diameter (Visium) is never drawn bigger than it is
    if (this.dotSize) diameter = Math.min(diameter, this.dotSize * this.view.scale);
    return Math.max(1, Math.min(512, diameter) * this._dpr);
  }

  /**
   * Screen pixels one cell may use: the size of a grid bucket divided by the
   * number of cells in it (90th percentile - the crowded parts count).
   */
  _screenAreaPerCell() {
    const grid = this.grid;
    if (!grid || !grid.starts) {
      const bw = Math.max(1e-6, this.bounds.x1 - this.bounds.x0);
      const bh = Math.max(1e-6, this.bounds.y1 - this.bounds.y0);
      return Math.max(1, (bw * this.view.scale) * (bh * this.view.scale) / this.n);
    }
    const bucketPx = Math.max(0.25, grid.cellW * this.view.scale) * Math.max(0.25, grid.cellH * this.view.scale);
    const counts = [];
    for (let b = 0; b < grid.starts.length - 1; b++) {
      const c = grid.starts[b + 1] - grid.starts[b];
      if (c > 0) counts.push(c);
    }
    if (!counts.length) return Math.max(1, bucketPx);
    counts.sort((a, b) => a - b);
    const p90 = counts[Math.min(counts.length - 1, Math.floor(counts.length * 0.9))];
    return Math.max(0.2, bucketPx / Math.max(1, p90));
  }

  render() {
    this._drawBackground();
    this._drawGL();
    this._drawOverlay();
  }

  _drawGL() {
    const gl = this.gl;
    if (!gl) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.coords || !this.n || !this.colors) return;

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.enableVertexAttribArray(this.loc.pos);
    gl.vertexAttribPointer(this.loc.pos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.enableVertexAttribArray(this.loc.color);
    gl.vertexAttribPointer(this.loc.color, 4, gl.UNSIGNED_BYTE, true, 0, 0);

    const s = this.view.scale;
    gl.uniform2f(this.loc.scale, (2 * s) / this.width, (2 * s) / this.height);
    gl.uniform2f(this.loc.offset, (2 * this.view.tx) / this.width - 1, 1 - (2 * this.view.ty) / this.height);
    gl.uniform1f(this.loc.pointSize, this.pointSize());
    gl.uniform1f(this.loc.shape, this.squarePoints ? 1 : 0);
    gl.drawArrays(gl.POINTS, 0, this.n);
  }

  /** Background image, drawn in the lower layer. */
  _drawBackground() {
    const ctx = this.bg.getContext('2d');
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.image) return;
    const { img, spec } = this.image;
    const { x0, y0, x1, y1 } = this.bounds;
    let sx, sy, tx, ty;
    const tr = spec.transform || {};
    if (tr.scale && tr.translate) {
      sx = tr.scale[0];
      sy = tr.scale[1];
      tx = tr.translate[0];
      ty = tr.translate[1];
    } else {
      // fit the image to the data bounding box
      sx = img.width / Math.max(1e-9, x1 - x0);
      sy = -img.height / Math.max(1e-9, y1 - y0);
      tx = -x0 * sx;
      ty = -y1 * sy;
    }
    const s = this.view.scale;
    ctx.save();
    ctx.globalAlpha = this.imageOpacity;
    ctx.setTransform(
      (this._dpr * s) / sx,
      0,
      0,
      (-this._dpr * s) / sy,
      this._dpr * (this.view.tx - (tx * s) / sx),
      this._dpr * (this.view.ty + (ty * s) / sy)
    );
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  }

  /** Labels, brush rectangle and scale bar. */
  _drawOverlay() {
    const ctx = this.top.getContext('2d');
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    const theme = canvasTheme();

    if (this.showLabels && this.categories?.length && this.codes && !this.squarePoints) {
      this._drawLabels(ctx, theme);
    }

    const drag = this.dragging;
    if (drag && drag.kind === 'brush') {
      ctx.save();
      ctx.strokeStyle = theme.selection;
      ctx.fillStyle = rgba(theme.selection, 0.12);
      ctx.lineWidth = 1;
      const x = Math.min(drag.x0, drag.x1);
      const y = Math.min(drag.y0, drag.y1);
      ctx.fillRect(x, y, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
      ctx.restore();
    }

    this._drawScaleBar(ctx, theme);
  }

  /** A scale bar in the bottom left corner (physical units). */
  _drawScaleBar(ctx, theme) {
    const spec = this.scaleBar;
    if (!spec || !spec.units) return;
    const perUnit = spec.perUnit || 1;
    const candidates = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
    let best = null;
    for (const c of candidates) {
      const px = (c / perUnit) * this.view.scale;
      if (px >= 60 && px <= 160) {
        best = { value: c, px };
        break;
      }
      if (px < 160 && (best === null || px > best.px)) best = { value: c, px };
    }
    if (!best) return;
    const x0 = 12;
    const y0 = this.height - 16;
    ctx.save();
    ctx.strokeStyle = theme.fg;
    ctx.fillStyle = theme.fg;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + best.px, y0);
    ctx.moveTo(x0, y0 - 4);
    ctx.lineTo(x0, y0 + 4);
    ctx.moveTo(x0 + best.px, y0 - 4);
    ctx.lineTo(x0 + best.px, y0 + 4);
    ctx.stroke();
    ctx.font = '10.5px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${best.value} ${spec.units}`, x0, y0 - 6);
    ctx.restore();
  }

  _drawLabels(ctx, theme) {
    const sums = new Map();
    for (let i = 0; i < this.n; i++) {
      const c = this.codes[i];
      if (c < 0 || this.hidden.has(this.categories[c])) continue;
      let s = sums.get(c);
      if (!s) {
        s = { x: 0, y: 0, n: 0 };
        sums.set(c, s);
      }
      const p = this.toScreen(this.coords[i * 2], this.coords[i * 2 + 1]);
      s.x += p.x;
      s.y += p.y;
      s.n++;
    }
    const items = Array.from(sums.entries())
      .filter(([, s]) => s.n >= 3)
      .map(([c, s]) => ({ cat: this.categories[c], x: s.x / s.n, y: s.y / s.n, n: s.n }))
      .sort((a, b) => b.n - a.n);

    ctx.save();
    ctx.font = '11px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const placed = [];
    for (const item of items) {
      const w = ctx.measureText(item.cat).width;
      const box = { x: item.x - w / 2 - 3, y: item.y - 8, w: w + 6, h: 16 };
      if (box.x < 0 || box.y < 0 || box.x + box.w > this.width || box.y + box.h > this.height) continue;
      let clash = false;
      for (const p of placed) {
        if (box.x < p.x + p.w && box.x + box.w > p.x && box.y < p.y + p.h && box.y + box.h > p.y) {
          clash = true;
          break;
        }
      }
      if (clash) continue;
      placed.push(box);
      ctx.lineWidth = 3;
      ctx.strokeStyle = rgba(theme.bg, 0.85);
      ctx.strokeText(item.cat, item.x, item.y);
      ctx.fillStyle = theme.label;
      ctx.fillText(item.cat, item.x, item.y);
    }
    ctx.restore();
  }

  destroy() {
    this.root.remove();
  }
}

function hexBytes(hex) {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  if (Number.isNaN(n)) return [136, 136, 136];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
