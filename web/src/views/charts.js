// Canvas charts: donut, stacked composition bars, heat map, marker dot plot
// and expression violins.  They all follow the same conventions as the
// reference atlas so the two apps look alike.

import { canvasTheme, catColor, rampColor, VIRIDIS, chipTextColor, rgba } from '../core/palette.js';
import { sizeCanvas } from '../core/util.js';

/** Donut chart of the category counts. */
export function drawDonut(canvas, cats, counts, total) {
  const theme = canvasTheme();
  const { ctx, width, height } = sizeCanvas(canvas, canvas.clientWidth || 170, canvas.clientHeight || 170);
  ctx.clearRect(0, 0, width, height);
  const cx = width / 2;
  const cy = height / 2;
  const R = Math.min(width, height) / 2 - 4;
  const r = R * 0.62;
  let start = -Math.PI / 2;
  for (let i = 0; i < cats.length; i++) {
    const value = counts[i];
    if (!value) continue;
    const angle = (value / Math.max(1, total)) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + R * Math.cos(start), cy + R * Math.sin(start));
    ctx.arc(cx, cy, R, start, start + angle);
    ctx.arc(cx, cy, r, start + angle, start, true);
    ctx.closePath();
    ctx.fillStyle = catColor(cats[i]);
    ctx.fill();
    start += angle;
  }
  ctx.fillStyle = theme.fg;
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(total), cx, cy - 6);
  ctx.fillStyle = theme.muted;
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillText('cells', cx, cy + 9);
}

/**
 * Stacked composition bars, one row per category of `rowCats`.
 * `values` is a matrix [row][column] of counts.
 */
export function drawStackedBars(canvas, rows, cols, matrix, options = {}) {
  const theme = canvasTheme();
  const width = options.width || canvas.clientWidth || 700;
  const rowH = options.rowH || 24;
  const height = rows.length * rowH + 6;
  const { ctx } = sizeCanvas(canvas, width, height);
  ctx.clearRect(0, 0, width, height);
  const labelW = options.labelWidth ?? 120;
  const barX = labelW;
  const barW = Math.max(40, width - labelW - 90);
  const totals = rows.map((_, i) => matrix[i].reduce((a, b) => a + b, 0));
  // absolute: the bar length shows how many cells the row has (not 100%)
  const absolute = !!options.absolute;
  const maxTotal = Math.max(1, ...totals);

  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';

  rows.forEach((row, i) => {
    const y = i * rowH + rowH / 2;
    ctx.fillStyle = theme.fg;
    ctx.textAlign = 'right';
    ctx.fillText(fitLabel(ctx, row, labelW - 10), labelW - 8, y);
    const total = totals[i] || 1;
    const rowW = absolute ? Math.max(2, (total / maxTotal) * barW) : barW;
    let x = barX;
    for (let j = 0; j < cols.length; j++) {
      const v = matrix[i][j];
      if (!v) continue;
      const w = (v / total) * rowW;
      ctx.fillStyle = options.colorFor ? options.colorFor(cols[j], j) : catColor(cols[j]);
      ctx.fillRect(x, y - rowH / 2 + 3, Math.max(0.5, w), rowH - 6);
      if (w > 26) {
        ctx.fillStyle = chipTextColor(ctx.fillStyle);
        ctx.textAlign = 'center';
        ctx.fillText(absolute ? String(v) : `${Math.round((v / total) * 100)}%`, x + w / 2, y);
        ctx.fillStyle = theme.fg;
      }
      x += w;
    }
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'left';
    ctx.fillText(
      options.formatTotal ? options.formatTotal(total) : String(total),
      barX + rowW + 8,
      y
    );
  });

  // remember the geometry for the tooltip
  canvas._segments = rows.map((row, i) => {
    const total = totals[i] || 1;
    const rowW = absolute ? Math.max(2, (total / maxTotal) * barW) : barW;
    let x = barX;
    const segs = [];
    for (let j = 0; j < cols.length; j++) {
      const v = matrix[i][j];
      if (v) {
        const w = (v / total) * rowW;
        segs.push({ label: cols[j], value: v, x0: x, x1: x + w, y0: i * rowH, y1: (i + 1) * rowH });
        x += w;
      }
    }
    return segs;
  });
}

/**
 * Sankey diagram: category flows between two metadata groupings.
 * `matrix[left][right]` holds the number of cells in each pair.
 */
export function drawSankey(canvas, leftCats, rightCats, matrix, options = {}) {
  const theme = canvasTheme();
  const width = options.width || 760;
  const nodeW = options.nodeWidth || 18;
  const gap = options.gap ?? 3;
  const labelW = options.labelWidth ?? 150;
  // every category gets at least room for its label - the chart simply grows
  // taller instead of dropping the small rows
  const minNodeH = options.minNodeHeight || 13;

  const leftTotals = leftCats.map((_, a) => matrix[a].reduce((x, y) => x + y, 0));
  const rightTotals = rightCats.map((_, b) => matrix.reduce((x, row) => x + row[b], 0));
  const totalLeft = leftTotals.reduce((x, y) => x + y, 0);
  const totalRight = rightTotals.reduce((x, y) => x + y, 0);

  // the unit follows the requested height; the tiny categories get a minimum
  // band so that their label fits - the canvas grows accordingly
  const trackReq = Math.max(40, (options.height || 330) - 40);
  const unit = Math.max(
    1e-9,
    Math.min(
      (trackReq - (leftTotals.length - 1) * gap) / Math.max(1, totalLeft),
      (trackReq - (rightTotals.length - 1) * gap) / Math.max(1, totalRight)
    )
  );
  const usedLeft = leftTotals.reduce((s, t) => s + Math.max(minNodeH, unit * t), 0);
  const usedRight = rightTotals.reduce((s, t) => s + Math.max(minNodeH, unit * t), 0);
  const height =
    Math.max(
      usedLeft + Math.max(0, leftTotals.length - 1) * gap,
      usedRight + Math.max(0, rightTotals.length - 1) * gap
    ) + 40; // margins + the totals line

  const { ctx } = sizeCanvas(canvas, width, height);
  ctx.clearRect(0, 0, width, height);
  const trackH = height - 36;

  const leftX = labelW + 4;
  const rightX = width - labelW - nodeW - 4;
  const y0 = 6;

  const left = [];
  let cursor = y0;
  leftCats.forEach((cat, a) => {
    const h = Math.max(minNodeH, unit * leftTotals[a]);
    left.push({ cat, y: cursor, h, total: leftTotals[a], i: a });
    cursor += h + gap;
  });
  const right = [];
  cursor = y0;
  rightCats.forEach((cat, b) => {
    const h = Math.max(minNodeH, unit * rightTotals[b]);
    right.push({ cat, y: cursor, h, total: rightTotals[b], i: b });
    cursor += h + gap;
  });

  // links first, so the nodes sit on top
  const leftOffsets = left.map((n) => n.y);
  const rightOffsets = right.map((n) => n.y);
  const links = [];
  left.forEach((ln) => {
    right.forEach((rn) => {
      const v = matrix[ln.i][rn.i];
      if (!v) return;
      const sy = leftOffsets[ln.i];
      const ty = rightOffsets[rn.i];
      leftOffsets[ln.i] += unit * v;
      rightOffsets[rn.i] += unit * v;
      links.push({ ln, rn, v, sy, ty, h: unit * v });
    });
  });

  const cxOut = leftX + nodeW + (rightX - leftX - nodeW) * 0.4;
  const cxIn = rightX - (rightX - leftX - nodeW) * 0.4;
  const STEPS = 20;
  ctx.globalAlpha = 0.34;
  for (const k of links) {
    if (k.h < 0.3) continue;
    // sample both cubic edges into polylines (also used for hit-testing)
    const top = [];
    const bottom = [];
    for (let s = 0; s <= STEPS; s++) {
      const t = s / STEPS;
      const it = 1 - t;
      const b01 = it * it * it, b02 = 3 * it * it * t, b03 = 3 * it * t * t, b04 = t * t * t;
      const x = b01 * (leftX + nodeW) + b02 * cxOut + b03 * cxIn + b04 * rightX;
      const y1 = b01 * k.sy + b02 * k.sy + b03 * k.ty + b04 * k.ty;
      const y2 = b01 * (k.sy + k.h) + b02 * (k.sy + k.h) + b03 * (k.ty + k.h) + b04 * (k.ty + k.h);
      top.push({ x, y: y1 });
      bottom.push({ x, y: y2 });
    }
    ctx.beginPath();
    ctx.moveTo(top[0].x, top[0].y);
    top.forEach((p) => ctx.lineTo(p.x, p.y));
    for (let s = bottom.length - 1; s >= 0; s--) ctx.lineTo(bottom[s].x, bottom[s].y);
    ctx.closePath();
    const color = options.colorForLeft ? options.colorForLeft(k.ln.cat, k.ln.i) : catColor(k.ln.cat);
    ctx.fillStyle = color;
    ctx.fill();
    k._color = color;
    k._top = top;
    k._bottom = bottom;
  }
  ctx.globalAlpha = 1;

  left.forEach((node) => {
    ctx.fillStyle = options.colorForLeft ? options.colorForLeft(node.cat, node.i) : catColor(node.cat);
    ctx.fillRect(leftX, node.y, nodeW, Math.max(1, node.h));
  });
  right.forEach((node) => {
    ctx.fillStyle = options.colorForRight ? options.colorForRight(node.cat, node.i) : catColor(node.cat);
    ctx.fillRect(rightX, node.y, nodeW, Math.max(1, node.h));
  });

  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  // every category gets a label - the two sides are laid out separately so
  // they never collide, and long names are cut to the label column
  // every row carries a label - the nodes are tall enough for them
  const leftLabeled = left;
  const rightLabeled = right;
  const leftLabels = leftLabeled.map((node) => ({
    text: node.cat,
    x: leftX - 6,
    y: node.y + node.h / 2,
    align: 'right',
    max: labelW - 8,
    nodeY: node.y + node.h / 2,
  }));
  const rightLabels = rightLabeled.map((node) => ({
    text: node.cat,
    x: rightX + nodeW + 6,
    y: node.y + node.h / 2,
    align: 'left',
    max: Math.max(30, width - (rightX + nodeW + 6) - 4),
    nodeY: node.y + node.h / 2,
  }));
  layoutLabels(leftLabels, 12, 8, height - 26);
  layoutLabels(rightLabels, 12, 8, height - 26);

  // leader lines for the labels that had to move away from their node
  ctx.strokeStyle = theme.line || 'rgba(128,128,128,0.45)';
  ctx.lineWidth = 1;
  [...leftLabels, ...rightLabels].forEach((l) => {
    if (Math.abs(l.ly - l.nodeY) < 3) return;
    ctx.beginPath();
    ctx.moveTo(l.align === 'right' ? leftX : rightX + nodeW, l.nodeY);
    ctx.lineTo(l.x + (l.align === 'right' ? 2 : -2), l.ly);
    ctx.stroke();
  });

  [...leftLabels, ...rightLabels].forEach((l) => {
    ctx.fillStyle = l.muted ? theme.muted : theme.fg;
    ctx.textAlign = l.align;
    ctx.fillText(fitLabel(ctx, l.text, l.max), l.x, l.ly);
  });
  ctx.fillStyle = theme.muted;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(totalLeft + ' cells', 2, height - 8);
  ctx.textAlign = 'right';
  ctx.fillText(totalRight + ' cells', width - 2, height - 8);

  canvas._sankey = { links, leftX, rightX, nodeW, left, right, unit };
}

/** Shorten a label so it fits into the given width. */
function fitLabel(ctx, text, maxWidth) {
  if (!maxWidth || ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '\u2026').width > maxWidth) s = s.slice(0, -1);
  return s + '\u2026';
}

/**
 * Place every label as close to its node as possible: only labels that would
 * overlap are moved (down first, up if there is no room) so the order of the
 * rows stays readable.
 */
function layoutLabels(labels, minGap, minY, maxY) {
  if (!labels.length) return labels;
  const sorted = labels.slice().sort((a, b) => a.y - b.y);
  const placed = [];
  const hits = (y) => placed.some((p) => Math.abs(p - y) < minGap);
  sorted.forEach((l) => {
    let ly = Math.min(maxY, Math.max(minY, l.y));
    if (hits(ly)) {
      let down = ly;
      while (down <= maxY && hits(down)) down += minGap;
      if (down <= maxY) {
        ly = down;
      } else {
        let up = ly;
        while (up >= minY && hits(up)) up -= minGap;
        ly = Math.max(minY, up);
      }
    }
    l.ly = ly;
    placed.push(ly);
  });
  return labels;
}

export function drawHeatmap(canvas, rows, cols, matrix, options = {}) {
  const theme = canvasTheme();
  const cellW = options.cellW || 34;
  const cellH = options.cellH || 26;
  const labelW = options.labelW || 150;
  const headerH = options.headerH || 96;
  const width = labelW + cols.length * cellW + 10;
  const height = headerH + rows.length * cellH + 10;
  const { ctx } = sizeCanvas(canvas, width, height);
  ctx.clearRect(0, 0, width, height);

  const scaleMode = options.scaleMode || 'row';
  const rowMax = rows.map((_, r) => Math.max(...matrix[r], 0.0001));
  const colMax = cols.map((_, c) => Math.max(...matrix.map((row) => row[c]), 0.0001));

  // column headers (rotated)
  ctx.save();
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = theme.muted;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  cols.forEach((col, c) => {
    const x = labelW + c * cellW + cellW / 2;
    ctx.save();
    ctx.translate(x, headerH - 6);
    ctx.rotate(-Math.PI / 2);
    const label = col.length > 22 ? col.slice(0, 21) + '…' : col;
    ctx.fillText(label, 0, 0);
    ctx.restore();
  });
  ctx.restore();

  // cells
  rows.forEach((row, r) => {
    const y = headerH + r * cellH;
    ctx.fillStyle = theme.fg;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const label = row.length > 26 ? row.slice(0, 25) + '…' : row;
    ctx.fillText(label, labelW - 8, y + cellH / 2);
    cols.forEach((col, c) => {
      const v = matrix[r][c];
      const norm = scaleMode === 'col' ? v / colMax[c] : v / rowMax[r];
      const t = Math.sqrt(Math.max(0, Math.min(1, norm)));
      ctx.fillStyle = rampColor(VIRIDIS, t);
      ctx.fillRect(labelW + c * cellW, y, cellW - 1, cellH - 1);
      if (cellW >= 30 && v > 0) {
        ctx.fillStyle = t > 0.55 ? '#111' : '#fff';
        ctx.textAlign = 'center';
        ctx.font = '9.5px system-ui, sans-serif';
        ctx.fillText((v * 100).toFixed(0), labelW + c * cellW + cellW / 2, y + cellH / 2);
        ctx.font = '11px system-ui, sans-serif';
      }
    });
  });

  canvas._heatmap = { rows, cols, matrix, cellW, cellH, labelW, headerH };
}

/**
 * Marker dot plot: genes (columns) x categories (rows).
 * `sheet` holds [pct, mean] for every (gene, category) pair, interleaved.
 */
export function drawDotplot(canvas, genes, cats, sheet, options = {}) {
  const theme = canvasTheme();
  const cellW = options.cellW || 30;
  const cellH = options.cellH || 20;
  const width = genes.length * cellW + 10;
  const height = cats.length * cellH + 10;
  const { ctx } = sizeCanvas(canvas, width, height);
  ctx.clearRect(0, 0, width, height);

  const maxMean = options.maxMean || 1;
  // the dots follow the expression colour scheme the user picked for the
  // scatter plots (the same ramp the UMAP / spatial view colours with)
  const ramp = options.scheme || VIRIDIS;
  genes.forEach((gene, g) => {
    cats.forEach((cat, c) => {
      const base = (g * cats.length + c) * 2;
      const pct = sheet[base] || 0;
      const mean = sheet[base + 1] || 0;
      const x = g * cellW + cellW / 2;
      const y = c * cellH + cellH / 2;
      const r = 1.3 + 5.2 * pct;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = rampColor(ramp, Math.max(0, Math.min(1, mean / maxMean)));
      ctx.fill();
      if (options.rings && options.rings.has(gene)) {
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }
    });
  });
  canvas._dotplot = { genes, cats, sheet, cellW, cellH };
}

/**
 * Violin plot of the expression of one gene across the categories.
 * `values` is an array (per category) of Float32Array / arrays.
 */
export function drawViolin(canvas, labels, series, options = {}) {
  const theme = canvasTheme();
  const rowH = options.rowH || 26;
  const width = options.width || 520;
  const height = labels.length * rowH + 30;
  const { ctx } = sizeCanvas(canvas, width, height);
  ctx.clearRect(0, 0, width, height);

  const labelW = options.labelW || 150;
  const plotX = labelW;
  const plotW = Math.max(60, width - labelW - 70);
  const maxValue = options.maxValue || 1;

  // axis
  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plotX, height - 22);
  ctx.lineTo(plotX + plotW, height - 22);
  ctx.stroke();
  ctx.fillStyle = theme.muted;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('0', plotX, height - 20);
  ctx.fillText(maxValue.toFixed(2), plotX + plotW, height - 20);

  const stats = [];
  labels.forEach((label, i) => {
    const values = series[i] || [];
    const y = i * rowH + rowH / 2;
    const hist = histogram(values, 60, maxValue);
    const smooth = smoothHistogram(hist.values, 1.2);
    const scale = plotW / Math.max(1e-9, maxValue);
    const half = Math.max(1, rowH / 2 - 3);

    ctx.beginPath();
    ctx.moveTo(plotX, y);
    for (let b = 0; b < smooth.length; b++) {
      const x = plotX + (b / (smooth.length - 1)) * plotW;
      ctx.lineTo(x, y - smooth[b] * half);
    }
    for (let b = smooth.length - 1; b >= 0; b--) {
      const x = plotX + (b / (smooth.length - 1)) * plotW;
      ctx.lineTo(x, y + smooth[b] * half);
    }
    ctx.closePath();
    ctx.fillStyle = rgba(options.color || theme.accent, 0.55);
    ctx.fill();
    ctx.strokeStyle = options.color || theme.accent;
    ctx.lineWidth = 1;
    ctx.stroke();

    // mean marker
    let sum = 0;
    let n = 0;
    for (const v of values) {
      sum += v;
      n++;
    }
    const mean = n ? sum / n : 0;
    const mx = plotX + mean * scale;
    ctx.strokeStyle = theme.fg;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(mx, y - half);
    ctx.lineTo(mx, y + half);
    ctx.stroke();

    ctx.fillStyle = theme.fg;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(label.length > 24 ? label.slice(0, 23) + '…' : label, labelW - 8, y);
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'left';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText(`${mean.toFixed(2)} · ${n ? Math.round((countPositive(values) / n) * 100) : 0}%`, plotX + plotW + 8, y);

    stats.push({ label, mean, n, max: values.length ? Math.max(...values) : 0 });
  });

  canvas._violin = { stats, labels };
}

function countPositive(values) {
  let n = 0;
  for (const v of values) if (v > 0) n++;
  return n;
}

function histogram(values, bins, maxValue) {
  const counts = new Float64Array(bins);
  for (const v of values) {
    if (v <= 0) {
      counts[0]++;
      continue;
    }
    const b = Math.min(bins - 1, Math.floor((v / maxValue) * bins));
    counts[b]++;
  }
  let max = 0;
  for (const c of counts) max = Math.max(max, c);
  if (max > 0) for (let i = 0; i < bins; i++) counts[i] /= max;
  return { values: counts };
}

function smoothHistogram(values, sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(v);
    sum += v;
  }
  return values.map((_, i) => {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) {
      const idx = Math.min(values.length - 1, Math.max(0, i + k));
      acc += values[idx] * kernel[k + radius];
    }
    return acc / sum;
  });
}
