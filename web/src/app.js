// The application: draggable dataset cards, cross-dataset comparison and
// the gene query panel.

import {
  state,
  loadProject,
  loadDataset,
  loadGeneExpr,
  loadMetric,
  speciesColor,
  normaliseFeature,
  fetchJSON,
} from './core/data.js';
import {
  groupColorFor,
  registerGroupColors,
  canvasTheme,
  SCHEMES,
} from './core/palette.js';
import {
  categoriesOf,
  codesOf,
  groupCounts,
  compositionAcross,
} from './core/composition.js';
import {
  ensureGeneIndex,
  ensureGeneDetails,
  resolveGene,
  prefixGenes,
  searchGenes,
  panelsForGene,
  geneProduct,
} from './core/genes.js';
import { ScatterViewer } from './views/scatter.js';
import { drawStackedBars, drawHeatmap, drawSankey, drawDotplot } from './views/charts.js';
import { initAddData } from './core/opendata.js';
import { $, el, esc, fmt, fmtPct, debounce, toast, addExportButtons, sizeCanvas } from './core/util.js';

const app = {
  datasets: [],
  focusId: null,
  geneQuery: [],
  activeGene: null,
  exprScheme: 'viridis',
  percentile: 99,
  hidden: new Map(),
  viewers: new Map(),
  cards: new Map(),
  exprCache: new Map(),
  compareRef: null,
  colourBy: 'group',
  dotNormalise: 'gene', // 'gene' = per gene scale, 'absolute' = one scale
  groupFlow: {},
  busy: false,
};

// ------------------------------------------------------------------- setup

export async function init() {
  const initialHash = window.location.hash;
  // a static site (no server): read the data from the browser store
  const { detectMode } = await import('./core/localfetch.js');
  await detectMode();
  initHelp();
  await loadProject();
  await ensureGeneIndex();
  await ensureGeneDetails();
  document.title = state.project.name;

  renderHeader();
  renderToolbar();
  await loadAll();
  bindGlobalEvents();
  applyUrlState(initialHash);
  initAddData({ onAdded: datasetAdded });
}

export async function loadAll() {
  // restore the card order the user last saved (drag & drop)
  const saved = savedOrder().filter((id) => state.panelOrder.includes(id));
  const ids = [...saved, ...state.panelOrder.filter((id) => !saved.includes(id))];
  state.panelOrder = ids;
  setBusy(true, 'Loading datasets…');
  for (const id of ids) {
    try {
      const ds = await loadDataset(id);
      app.datasets.push(ds);
    } catch (err) {
      console.error(err);
      toast(`Could not load ${id}: ${err.message}`);
    }
  }
  setBusy(false);
  app.focusId = app.datasets[0]?.id || null;
  renderHeader();
  renderOverview();
  renderCompare();
  renderMarkers();
  renderFooter();
  applyColourBy();
}

/**
 * A dataset that was just converted + registered through the web UI.
 * Fetch the fresh project.json, load the dataset and show it without a
 * full page reload.
 */
export async function datasetAdded(id) {
  setBusy(true, 'Loading the new dataset…');
  try {
    await loadProject(true);
    state.panelOrder = state.project.panels.map((p) => p.id);
    await ensureGeneIndex(true);
    // genes.json may also have been rewritten
    if (!state.panelOrder.includes(id)) throw new Error(`dataset '${id}' missing from project.json`);
    const ds = await loadDataset(id);
    app.datasets.push(ds);
    app.focusId = ds.id;
    renderHeader();
    refreshToolbarOptions();
    const card = buildCard(ds);
    $('#overview-grid').appendChild(card);
    fitCard(card);
    card.classList.add('focused');
    document.querySelectorAll('.dset-card').forEach((c) => c.classList.toggle('focused', c.dataset.ds === id));
    if (app.geneQuery.length) applyCardGene(card, ds);
    applyColourBy();
    renderCompare();
    renderMarkers();
    renderFooter();
    updateUrlState();
  } catch (err) {
    console.error(err);
    toast(`Could not show the new dataset: ${err.message}`);
  } finally {
    setBusy(false);
  }
}

function setBusy(on, message) {
  app.busy = on;
  const el = $('#busy');
  if (!el) return;
  el.textContent = on ? message || 'Loading…' : '';
  el.style.display = on ? 'block' : 'none';
}

// ----------------------------------------------------------------- header

function renderHeader() {
  const brand = $('#brand');
  brand.innerHTML = `<span class="brand-title">${esc(state.project.name)}</span>` +
    (state.project.subtitle ? `<span class="brand-sub">${esc(state.project.subtitle)}</span>` : '');

  const tabs = $('#dataset-tabs');
  tabs.innerHTML = '';
  const all = el('button', 'tab active', 'All');
  all.addEventListener('click', () => {
    state.panelOrder.forEach((id) => (app.hidden.get(id) ? null : null));
    document.querySelectorAll('.dset-card').forEach((c) => (c.style.display = ''));
    all.classList.add('active');
    document.querySelectorAll('#dataset-tabs .tab').forEach((t) => (t === all ? null : t.classList.remove('active')));
  });
  tabs.appendChild(all);
  for (const ds of app.datasets) {
    const tab = el('span', 'tab');
    const name = el('span', 'tab-name', ds.meta.name || ds.id);
    tab.appendChild(name);
    tab.addEventListener('click', (ev) => {
      if (ev.target === del) return;
      document.querySelectorAll('#dataset-tabs .tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.dset-card').forEach((c) => {
        c.style.display = c.dataset.ds === ds.id ? '' : 'none';
      });
      focusDataset(ds.id);
    });
    // delete button
    const del = el('span', 'tab-del', '\u00d7');
    del.title = `Remove ${ds.meta.name || ds.id} from the project`;
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeDataset(ds);
    });
    tab.appendChild(del);
    tabs.appendChild(tab);
  }
}

/** Delete one dataset: drop it from the project and from the cards. */
async function removeDataset(ds) {
  const name = ds.meta.name || ds.id;
  if (!window.confirm(
    `Remove the dataset "${name}" from this project?\n\n` +
    'The built data is deleted. If this dataset was uploaded, its copy in uploads/ is deleted too; ' +
    'uploading the same file again will restore it.'
  )) {
    return;
  }
  try {
    const res = await fetch('/api/datasets/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: ds.id }),
    });
    if (!res.ok) throw new Error(await res.text());
    // drop it from the running app
    app.datasets = app.datasets.filter((d) => d.id !== ds.id);
    app.cards.delete(ds.id);
    state.panelOrder = state.panelOrder.filter((id) => id !== ds.id);
    const card = document.querySelector(`.dset-card[data-ds="${CSS.escape(ds.id)}"]`);
    if (card) card.remove();
    await loadProject(true);
    renderHeader();
    renderCompare();
    renderMarkers();
    renderFooter();
    toast(`Removed ${name}`);
  } catch (err) {
    toast(`Could not remove ${name}: ${err.message}`);
  }
}

function renderToolbar() {
  const bar = $('#toolbar');
  bar.innerHTML = '';

  const groupWrap = el('label', 'tool-field');
  groupWrap.append(el('span', 'tool-label', 'Grouping'));
  const groupSel = el('select', 'tool-select');
  groupSel.addEventListener('change', () => {
    for (const ds of app.datasets) {
      const card = app.cards.get(ds.id);
      if (card && card.groupSelect) {
        card.groupSelect.value = groupSel.value;
        card.groupSelect.dispatchEvent(new Event('change'));
      }
    }
  });
  groupWrap.appendChild(groupSel);
  bar.appendChild(groupWrap);

  const embWrap = el('label', 'tool-field');
  embWrap.append(el('span', 'tool-label', 'Embedding'));
  const embSel = el('select', 'tool-select');
  embSel.addEventListener('change', () => {
    for (const ds of app.datasets) {
      const card = app.cards.get(ds.id);
      if (card && card.embSelect) {
        card.embSelect.value = embSel.value;
        card.embSelect.dispatchEvent(new Event('change'));
      }
    }
  });
  embWrap.appendChild(embSel);
  bar.appendChild(embWrap);

  const schemeWrap = el('label', 'tool-field');
  schemeWrap.append(el('span', 'tool-label', 'Colours'));
  const schemeSel = el('select', 'tool-select');
  for (const name of Object.keys(SCHEMES)) {
    const opt = el('option', null, name[0].toUpperCase() + name.slice(1));
    opt.value = name;
    schemeSel.appendChild(opt);
  }
  schemeSel.value = app.exprScheme;
  schemeSel.addEventListener('change', () => {
    app.exprScheme = schemeSel.value;
    updateCardsForGene();
    applyColourBy();
  });
  schemeWrap.appendChild(schemeSel);
  bar.appendChild(schemeWrap);

  // colour the cells by a quantitative metadata column
  const colourWrap = el('label', 'tool-field');
  colourWrap.append(el('span', 'tool-label', 'Colour by'));
  const colourSel = el('select', 'tool-select');
  colourSel.addEventListener('change', () => {
    app.colourBy = colourSel.value;
    if (app.colourBy !== 'group' && app.geneQuery.length) {
      // the gene colouring wins - make that visible
      toast('The gene query still colours the cards - clear it to see the metric');
    }
    applyColourBy();
  });
  colourWrap.appendChild(colourSel);
  bar.appendChild(colourWrap);

  app.groupSelect = groupSel;
  app.embSelect = embSel;
  app.colourSelect = colourSel;
}

function refreshToolbarOptions() {
  const groups = new Set();
  const embs = new Set();
  const metrics = new Set();
  app.datasets.forEach((ds) => {
    ds.groupNames.forEach((g) => groups.add(g));
    ds.embeddings.forEach((e) => embs.add(e.name));
    (ds.metrics || []).forEach((m) => metrics.add(m.name));
  });
  fillSelect(app.groupSelect, [...groups], app.groupSelect.value);
  fillSelect(app.embSelect, [...embs], app.embSelect.value);
  if (app.colourSelect) {
    const values = ['group', ...[...metrics].sort()];
    app.colourSelect.innerHTML = '';
    values.forEach((v) => {
      const opt = el('option', null, v === 'group' ? 'Grouping' : v);
      opt.value = v;
      app.colourSelect.appendChild(opt);
    });
    if (!values.includes(app.colourBy)) app.colourBy = 'group';
    app.colourSelect.value = app.colourBy;
  }
}

/**
 * Colour every card by the selected quantitative metadata (or by its
 * grouping).  Datasets without that metric keep their category colours.
 */
async function applyColourBy() {
  const metric = app.colourBy && app.colourBy !== 'group' ? app.colourBy : null;
  for (const ds of app.datasets) {
    const card = app.cards.get(ds.id);
    if (!card) continue;
    if (!metric) {
      card.viewer.setMetric(null);
      card.metricMode = false;
      card.classList.remove('metric-mode');
      if (card.metricBar) card.metricBar.style.display = 'none';
      continue;
    }
    const data = await loadMetric(ds, metric);
    if (!data) {
      card.viewer.setMetric(null);
      card.metricMode = false;
      card.classList.remove('metric-mode');
      if (card.metricBar) card.metricBar.style.display = 'none';
      continue;
    }
    card.viewer.setMetric(data.values, data.min, data.max, app.exprScheme);
    card.metricMode = true;
    card.classList.add('metric-mode');
    if (card.metricBar) {
      card.metricBar.innerHTML = '';
      const bar = el('div', 'colorbar');
      bar.style.background = `linear-gradient(to right, ${rampCss(app.exprScheme)})`;
      card.metricBar.append(
        el('span', 'muted', metric),
        bar,
        el('span', 'muted', `${fmt(data.min)} - ${fmt(data.max)}`)
      );
      card.metricBar.style.display = 'flex';
    }
  }
}

function fillSelect(select, values, current) {
  if (!select) return;
  select.innerHTML = '';
  values.forEach((v) => {
    const opt = el('option', null, v);
    opt.value = v;
    select.appendChild(opt);
  });
  if (values.includes(current)) select.value = current;
}

// --------------------------------------------------------------- overview

function renderOverview() {
  const host = $('#overview-grid');
  host.innerHTML = '';
  app.cards.clear();
  app.datasets.forEach((ds) => {
    const card = buildCard(ds);
    host.appendChild(card);
    fitCard(card);
  });
  refreshToolbarOptions();
}

/** Size the viewer to the actual card width (the cards live in a grid). */
function fitCard(card) {
  requestAnimationFrame(() => {
    const wrap = card.plotWrap;
    if (!wrap || !card.viewer) return;
    const width = Math.round(wrap.clientWidth || card.viewer.width);
    if (width < 80) return;
    card.viewer.width = width;
    card.viewer.height = Math.round(Math.min(520, Math.max(260, width * 0.78)));
    card.viewer.resize();
  });
}

function buildCard(ds) {
  const card = el('div', 'dset-card');
  card.dataset.ds = ds.id;

  const head = el('div', 'dset-head');
  const grip = el('span', 'grip', '⠿');
  grip.title = 'Drag to reorder the cards';
  head.appendChild(grip);
  const title = el('div', 'dset-title');
  const species = ds.spec.species;
  title.innerHTML =
    `<span class="dset-name">${esc(ds.meta.name || ds.id)}</span>` +
    (species ? `<span class="dset-species" style="background:${speciesColor(species)}"></span>` : '') +
    `<span class="dset-count">${fmt(ds.n)} cells</span>`;
  head.appendChild(title);
  const geneBar = el('div', 'colorbar-wrap gene-bar');
  geneBar.style.display = 'none';
  head.appendChild(geneBar);

  const metricBar = el('div', 'colorbar-wrap gene-bar');
  metricBar.style.display = 'none';
  head.appendChild(metricBar);

  const tools = el('div', 'dset-tools');

  // embedding selector
  const embSel = el('select', 'mini-select');
  ds.embeddings.forEach((e) => {
    const opt = el('option', null, e.label || e.name);
    opt.value = e.name;
    embSel.appendChild(opt);
  });
  embSel.value = ds.meta.default_embedding || ds.embeddings[0]?.name || '';
  if (!embSel.value && embSel.options.length) embSel.value = embSel.options[0].value;
  embSel.addEventListener('change', () => {
    card.embedding = embSel.value;
    applyEmbedding(card, ds);
  });
  tools.appendChild(embSel);

  // grouping selector
  const groupSel = el('select', 'mini-select');
  ds.groupNames.forEach((g) => {
    const opt = el('option', null, (ds.meta.categories?.[g] ? g : g));
    opt.value = g;
    groupSel.appendChild(opt);
  });
  groupSel.value = ds.meta.default_group || ds.groupNames[0] || '';
  if (!groupSel.value && groupSel.options.length) groupSel.value = groupSel.options[0].value;
  groupSel.addEventListener('change', () => {
    card.group = groupSel.value;
    applyGroup(card, ds);
  });
  tools.appendChild(groupSel);

  // image toggle (spatial)
  const images = ds.images || [];
  if (images.length) {
    const toggle = el('label', 'mini-check');
    const input = el('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => {
      card.imageOn = input.checked;
      const viewer = app.viewers.get(ds.id);
      if (viewer) {
        viewer.setImage(
          input.checked
            ? { url: imageUrl(ds, images[0]), transform: images[0].transform }
            : null
        );
      }
    });
    toggle.append(input, el('span', null, images[0].label || 'Image'));
    tools.appendChild(toggle);

    const opacity = el('input', 'mini-range');
    opacity.type = 'range';
    opacity.min = '0';
    opacity.max = '100';
    opacity.value = '100';
    opacity.title = 'Image opacity';
    opacity.addEventListener('input', () => {
      const viewer = app.viewers.get(ds.id);
      if (viewer) viewer.setImageOpacity(parseInt(opacity.value, 10) / 100);
    });
    tools.appendChild(opacity);
  }

  // pan / select mode
  const modeSel = el('select', 'mini-select');
  [['select', 'Select'], ['pan', 'Pan']].forEach(([v, label]) => {
    const opt = el('option', null, label);
    opt.value = v;
    modeSel.appendChild(opt);
  });
  modeSel.value = 'pan';
  modeSel.addEventListener('change', () => {
    const viewer = app.viewers.get(ds.id);
    if (viewer) viewer.mode = modeSel.value;
  });
  tools.appendChild(modeSel);

  head.appendChild(tools);
  card.appendChild(head);

  const body = el('div', 'dset-body');
  const plotWrap = el('div', 'plot-wrap');
  body.appendChild(plotWrap);
  card.appendChild(body);

  const legend = el('div', 'legend');
  card.appendChild(legend);

  const composition = el('div', 'composition');
  card.appendChild(composition);

  const selection = el('div', 'composition selection');
  card.appendChild(selection);

  const note = el('div', 'dset-desc');
  note.textContent = ds.meta.description || '';
  card.appendChild(note);

  // per-dataset footer: gene dotplot while querying, group flows otherwise
  card.appendChild(buildCardFoot(card, ds));

  // ---- viewer --------------------------------------------------------
  const viewer = new ScatterViewer(plotWrap, {
    width: 440,
    height: 350,
    onHover: (cell) => showTooltip(cell, ds, card),
    onReset: () => {
      // double click: back to the full view and no selection
      card.selectedCells = null;
      renderSelection(card, ds);
    },
    onSelect: (cells, ev, isBrush) => {
      if (isBrush && cells.length) {
        card.selectedCells = cells;
        renderSelection(card, ds);
        toast(`${cells.length} cells selected`);
        // a brushed selection is finished - go back to panning
        viewer.mode = 'pan';
        modeSel.value = 'pan';
      } else if (!isBrush && cells >= 0) {
        card.selectedCells = [cells];
        renderSelection(card, ds);
      }
    },
  });
  app.viewers.set(ds.id, viewer);

  card.embedding = embSel.value;
  card.group = groupSel.value;
  card.groupSelect = groupSel;
  card.embSelect = embSel;
  card.viewer = viewer;
  card.legend = legend;
  card.composition = composition;
  card.selectionHost = selection;
  card.geneBar = geneBar;
  card.metricBar = metricBar;
  card.plotWrap = plotWrap;
  card.dsRef = ds;

  card.addEventListener('click', (ev) => {
    if (ev.target.closest('select, button, input, label')) return;
    focusDataset(ds.id);
  });

  enableCardDrag(card);
  applyEmbedding(card, ds);
  applyGroup(card, ds);
  app.cards.set(ds.id, card);
  addExportButtons(card, `omicsexplorer_${ds.id}`);
  return card;
}

/** The URL of a background image (relative to the bundle root). */
function imageUrl(ds, image) {
  const base = state.project?.data_dir || 'data';
  return `${base}/${image.path}`;
}

function applyEmbedding(card, ds) {
  const viewer = card.viewer;
  const emb = ds.embeddings.find((e) => e.name === card.embedding) || ds.embeddings[0];
  if (!emb) return;
  card.embeddingSpec = emb;
  const xy = ds.coords.get(emb.name);
  if (!xy) return;
  viewer.setCoords(xy);
  // bin-like data (one cell per grid position) is drawn as tiles, cell-like
  // data as small dots.
  const grid = emb.grid || {};
  const isGrid = !!grid.is_grid;
  // grid data is drawn as tiles; spots with a gap (Visium) stay round
  const round = isGrid && grid.shape === 'circle';
  viewer.setSquarePoints(isGrid && !round);
  viewer.setPointPitch(isGrid ? grid.pitch : 0);
  viewer.setPointSize(isGrid && !round ? 0 : (grid.size || 0));
  viewer.setLabels(emb.kind !== 'spatial');
  if (emb.kind === 'spatial' && ds.units) {
    viewer.setScaleBar({ units: ds.units, perUnit: 1 });
  } else {
    viewer.setScaleBar(null);
  }
  const images = ds.images || [];
  if (card.imageOn && images.length) {
    viewer.setImage({ url: imageUrl(ds, images[0]), transform: images[0].transform });
  } else {
    viewer.setImage(null);
  }
  if (card.group) applyGroup(card, ds);
  updateUrlState();
}

function applyGroup(card, ds) {
  const group = card.group || ds.groupNames[0];
  if (!group) return;
  card.group = group;
  const cats = categoriesOf(ds, group);
  const codes = codesOf(ds, group);
  registerGroupColors(group, cats);
  const hidden = app.hidden.get(ds.id) || new Set();
  app.hidden.set(ds.id, hidden);
  card.viewer.setCodes(codes, cats, group);
  card.viewer.setHidden(hidden);
  renderLegend(card, ds);
  renderComposition(card, ds);
  refreshCardFoot(card);
  updateUrlState();
}

function renderLegend(card, ds) {
  const group = card.group;
  const cats = categoriesOf(ds, group);
  const { counts, total } = groupCounts(ds, group);
  const hidden = app.hidden.get(ds.id) || new Set();
  card.legend.innerHTML = '';
  cats.forEach((cat, i) => {
    const chip = el('span', 'chip' + (hidden.has(cat) ? ' off' : ''));
    const swatch = el('i');
    swatch.style.background = groupColorFor(group, cat, i);
    chip.append(swatch, el('span', 'chip-name', cat), el('span', 'chip-count', `${fmt(counts[i])} · ${fmtPct(total ? counts[i] / total : 0, 1)}`));
    chip.title = 'Click to hide / show the category';
    chip.addEventListener('click', (ev) => {
      if (hidden.has(cat)) hidden.delete(cat);
      else hidden.add(cat);
      card.viewer.setHidden(hidden);
      renderLegend(card, ds);
    });
    card.legend.appendChild(chip);
  });
}

/** Composition of the dataset by sample, stacked by the current grouping. */
function renderComposition(card, ds) {
  const host = card.composition;
  if (!host) return;
  host.innerHTML = '';
  const sampleGroup = ds.groupNames.find((g) => g === 'sample');
  if (!sampleGroup) return;
  const { rows, cats } = compositionAcross(ds, card.group, sampleGroup);
  if (!rows.length) return;
  const title = el('div', 'composition-title', `Composition by ${sampleGroup}`);
  host.appendChild(title);
  const canvas = el('canvas');
  host.appendChild(canvas);
  const width = Math.max(280, Math.round(card.plotWrap?.clientWidth || 640));
  const matrix = rows.map((r) => Array.from(r.values));
  drawStackedBars(canvas, rows.map((r) => r.label), cats, matrix, {
    width,
    rowH: 20,
    labelWidth: 120,
    colorFor: (cat, i) => groupColorFor(card.group, cat, i),
    formatTotal: (t) => fmt(t),
  });
  // tooltip
  canvas.addEventListener('mousemove', (ev) => {
    const segs = canvas._segments;
    if (!segs) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const tip = $('#tooltip');
    let found = null;
    for (const row of segs) {
      for (const seg of row) {
        if (x >= seg.x0 && x <= seg.x1 && y >= seg.y0 && y <= seg.y1) found = seg;
      }
    }
    if (!found) {
      tip.style.display = 'none';
      return;
    }
    tip.innerHTML = `<b>${esc(found.label)}</b><br><span class="tip-muted">${fmt(found.value)} cells</span>`;
    tip.style.display = 'block';
  });
  canvas.addEventListener('mouseleave', () => {
    const tip = $('#tooltip');
    if (tip) tip.style.display = 'none';
  });
}

function showTooltip(cell, ds, card) {
  const tip = $('#tooltip');
  if (!tip) return;
  if (cell === null || cell === undefined || cell < 0) {
    tip.style.display = 'none';
    return;
  }
  if (card.viewer.expr && card.gene) {
    const v = card.viewer.expr[cell] || 0;
    tip.innerHTML =
      `<b>${esc(card.gene)}</b> <span class="tip-muted">${v.toFixed(2)}</span><br>` +
      `<span class="tip-muted">cell #${fmt(cell)} · ${esc(ds.meta.name || ds.id)}</span>`;
    tip.style.display = 'block';
    return;
  }
  if (card.viewer.metric) {
    const value = card.viewer.metric[cell];
    const metricName = app.colourBy && app.colourBy !== 'group' ? app.colourBy : 'value';
    tip.innerHTML =
      `<b>${esc(metricName)}</b> <span class="tip-muted">${isFinite(value) ? fmt(value) : '-'}</span><br>` +
      `<span class="tip-muted">cell #${fmt(cell)} · ${esc(ds.meta.name || ds.id)}</span>`;
    tip.style.display = 'block';
    return;
  }
  const cats = categoriesOf(ds, card.group);
  const codes = codesOf(ds, card.group);
  const c = codes ? codes[cell] : -1;
  const cat = c >= 0 ? cats[c] : 'unknown';
  const colour = groupColorFor(card.group, cat, c);
  tip.innerHTML =
    `<span class="tip-dot" style="background:${colour}"></span>` +
    `<b>${esc(cat)}</b><br><span class="tip-muted">cell #${fmt(cell)} · ${esc(ds.meta.name || ds.id)}</span>`;
  tip.style.display = 'block';
}

function focusDataset(id) {
  app.focusId = id;
  document.querySelectorAll('.dset-card').forEach((c) => c.classList.toggle('focused', c.dataset.ds === id));
  updateUrlState();
}

// ------------------------------------------------------------- the help box

/** The "?" dialog: how to add, where the data lives, how to remove it. */
function initHelp() {
  const btn = document.getElementById('help-toggle');
  const dialog = document.getElementById('help-dialog');
  const body = document.getElementById('help-body');
  if (!btn || !dialog || !body) return;

  const local = window.__OMICSEXPLORER_LOCAL__ === true;
  body.innerHTML = local
    ? `<p>This is the <b>browser version</b>: everything happens on your own
         computer, no file is ever uploaded to a server.</p>
       <h4>Which files?</h4>
       <ul>
         <li><b>.h5ad</b> (AnnData / Seurat exported as h5ad) - read directly in the browser.</li>
         <li>Seurat <b>.rds</b> files need the server version (a small R container converts them).</li>
       </ul>
       <h4>Where is my data?</h4>
       <ul>
         <li>In the <b>storage of this browser</b> (IndexedDB), on this computer only.</li>
         <li>It stays when you reload the page and it disappears when you clear the
             browser data of this site - export a copy if you need it.</li>
       </ul>
       <h4>How do I add data?</h4>
       <ul>
         <li>Press <b>＋ Data</b> and drop the <code>.h5ad</code> file into the dialog.</li>
         <li>Pick the groupings and the embedding you want to see, then
             <b>Convert &amp; add</b>. The file is parsed in the browser (a moment for
             large files).</li>
       </ul>
       <h4>How do I remove data?</h4>
       <ul>
         <li>Press the <b>×</b> next to the dataset in the bar at the top.</li>
         <li>The dataset and its files are deleted from this browser.</li>
       </ul>
       <h4>What can I do with it?</h4>
       <ul>
         <li>Scroll to zoom, drag to select cells, shift-drag to pan, double click resets.</li>
         <li>Search a gene to colour the cells and to fill the dotplot of every dataset.</li>
         <li>Drag the <b>⠿</b> handle to reorder the cards.</li>
       </ul>`
    : `<p>This is the <b>server version</b>: the data is converted once and then
         served from the project directory.</p>
       <h4>Which files?</h4>
       <ul>
         <li><b>.h5ad</b> (AnnData / Seurat exported as h5ad) and Seurat <b>.rds</b>
             (converted with R on the server).</li>
       </ul>
       <h4>Where is my data?</h4>
       <ul>
         <li>In the project directory: <code>data/</code> holds the built bundle,
             <code>uploads/</code> the files you uploaded and the conversion cache.</li>
       </ul>
       <h4>How do I add data?</h4>
       <ul>
         <li>Press <b>＋ Data</b>: upload a file or point to a path on the server.</li>
         <li>Pick the groupings and the embedding, then <b>Convert &amp; add</b>.</li>
       </ul>
  <h4>How do I remove data?</h4>
  <ul>
    <li>Press the <b>×</b> next to the dataset in the bar at the top - the built
        data is deleted and the dataset is hidden from the project.</li>
    <li>The copy of an uploaded file (uploads/) is deleted with it; uploading
        the same file again restores the dataset. Files you only referenced by
        path are not touched.</li>
  </ul>
       <h4>What can I do with it?</h4>
       <ul>
         <li>Scroll to zoom, drag to select cells, shift-drag to pan, double click resets.</li>
         <li>Search a gene to colour the cells and to fill the dotplot of every dataset.</li>
         <li>Drag the <b>⠿</b> handle to reorder the cards.</li>
       </ul>`;

  const open = () => {
    dialog.style.display = 'flex';
  };
  const close = () => {
    dialog.style.display = 'none';
  };
  btn.addEventListener('click', open);
  document.getElementById('help-close').addEventListener('click', close);
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog) close();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') close();
  });
}

// ---------------------------------------------------- card drag ordering

const ORDER_KEY = 'oe.cardOrder';

function orderKey() {
  return ORDER_KEY + ':' + (state.project?.name || 'default');
}

function savedOrder() {
  try {
    const raw = JSON.parse(localStorage.getItem(orderKey()) || '[]');
    return Array.isArray(raw) ? raw.map(String) : [];
  } catch (err) {
    return [];
  }
}

function saveOrder(ids) {
  localStorage.setItem(orderKey(), JSON.stringify(ids));
}

/**
 * HTML5 drag & drop from the grip handle: reorders the cards and keeps the
 * dataset order (which drives the comparison) in sync.
 */
function enableCardDrag(card) {
  const grip = card.querySelector('.grip');
  if (!grip) return;
  grip.draggable = true;
  grip.addEventListener('dragstart', (ev) => {
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', card.dataset.ds);
    ev.dataTransfer.setData('application/x-oe-card', card.dataset.ds);
    card.classList.add('dragging');
  });
  grip.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    commitCardOrder();
  });
  card.addEventListener('dragover', (ev) => {
    const grid = card.parentElement;
    if (!grid) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    const dragging = grid.querySelector('.dset-card.dragging');
    if (!dragging || dragging === card) return;
    const rect = card.getBoundingClientRect();
    const after = ev.clientY ? (ev.clientY - rect.top) > rect.height / 2 : false;
    grid.insertBefore(dragging, after ? card.nextSibling : card);
  });
}

/** Synchronise app.datasets (and the saved order) with the card DOM order. */
function commitCardOrder() {
  const grid = $('#overview-grid');
  if (!grid) return;
  const ids = Array.from(grid.children).map((c) => c.dataset.ds);
  app.datasets.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  state.panelOrder = ids;
  saveOrder(ids);
  renderCompare();
}

// --------------------------------------------------------------- compare

function renderCompare() {
  const host = $('#compare-body');
  if (!host) return;
  host.innerHTML = '';
  if (!app.datasets.length) return;

  // the reference dataset defines the rows (its categories define the compare)
  const focusDs = app.datasets.find((d) => d.id === app.focusId) || app.datasets[0];
  let ds = app.datasets.find((d) => d.id === app.compareRef);
  if (!ds || !ds.groupNames.length) ds = focusDs;
  app.compareRef = ds.id;

  const controls = el('div', 'compare-controls');

  // reference dataset selector
  const refSel = el('select', 'tool-select');
  app.datasets.forEach((d) => {
    refSel.appendChild(el('option', null, d.meta.name || d.id)).value = d.id;
  });
  refSel.value = ds.id;
  refSel.title = 'Reference dataset - its categories define the rows of the comparison';
  refSel.addEventListener('change', () => {
    // renderCompare validates app.compareGroup against the new reference
    app.compareRef = refSel.value;
    renderCompare();
  });
  controls.append(wrapField('Reference', refSel));

  // grouping (column) selector of the reference dataset
  const groupSel = el('select', 'tool-select');
  const groups = ds.groupNames;
  groups.forEach((g) => {
    groupSel.appendChild(el('option', null, g)).value = g;
  });
  groupSel.value = ds.meta.default_group || groups[0];
  groupSel.addEventListener('change', () => {
    app.compareGroup = groupSel.value;
    renderCompare();
  });
  app.compareGroup = app.compareGroup && groups.includes(app.compareGroup) ? app.compareGroup : groupSel.value;
  groupSel.value = app.compareGroup;

  controls.appendChild(wrapField('Grouping', groupSel));
  host.appendChild(controls);

  // rows = categories, columns = datasets
  const group = app.compareGroup;
  const refCats = categoriesOf(ds, group);
  const columns = app.datasets.map((d) => d.id);
  const colNames = app.datasets.map((d) => d.meta.name || d.id);
  const colTotals = app.datasets.map((d) => d.n || 0); // total cells of the dataset
  // sort the rows by their abundance in the reference dataset
  const refCounts = groupCounts(ds, group).counts;
  const refOrder = refCats.map((c, i) => i).sort((a, b) => (refCounts[b] || 0) - (refCounts[a] || 0));
  const cats = refOrder.map((i) => refCats[i]);
  const matrix = cats.map(() => columns.map(() => 0));
  app.datasets.forEach((d, ci) => {
    const { cats: dCats, counts, total } = groupCounts(d, group);
    const lookup = new Map(dCats.map((c, i) => [c, i]));
    cats.forEach((cat, ri) => {
      const idx = lookup.get(cat);
      matrix[ri][ci] = idx === undefined ? 0 : counts[idx] / Math.max(1, total);
    });
  });

  const caption = el('div', 'compare-caption');
  caption.innerHTML =
    `Share of each dataset that falls into the <b>${esc(group)}</b> categories of ` +
    `<b>${esc(ds.meta.name || ds.id)}</b>`;
  host.appendChild(caption);

  const canvas = el('canvas', 'heatmap-canvas');
  const holder = el('div', 'chart-holder');
  holder.appendChild(canvas);
  host.appendChild(holder);
  drawHeatmap(canvas, cats, colNames, matrix, { cellW: 86, cellH: 24, labelW: 190, scaleMode: 'col' });

  // colour scale
  const scale = el('div', 'compare-scale');
  const bar = el('div', 'colorbar');
  bar.style.background = `linear-gradient(to right, ${rampCss('viridis')})`;
  scale.append(el('span', 'muted', '0%'), bar, el('span', 'muted', 'highest share'));
  host.appendChild(scale);

  canvas.addEventListener('mousemove', (ev) => {
    const geo = canvas._heatmap;
    if (!geo) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const c = Math.floor((x - geo.labelW) / geo.cellW);
    const r = Math.floor((y - geo.headerH) / geo.cellH);
    const tip = $('#tooltip');
    if (c < 0 || c >= geo.cols.length || r < 0 || r >= geo.rows.length) {
      tip.style.display = 'none';
      return;
    }
    tip.innerHTML = `<b>${esc(geo.rows[r])}</b><br>${esc(geo.cols[c])} · ${fmtPct(geo.matrix[r][c])}`;
    tip.style.display = 'block';
  });

  // table
  const table = el('table', 'data-table compare-table');
  const thead = el('thead');
  const hr = el('tr');
  hr.appendChild(el('th', null, 'Category'));
  columns.forEach((c, ci) => {
    const th = el('th');
    th.innerHTML = `<span class="th-name">${esc(colNames[ci])}</span>` +
      `<span class="th-sub">${fmt(colTotals[ci])} cells</span>`;
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  const tbody = el('tbody');
  cats.forEach((cat, ri) => {
    const tr = el('tr');
    tr.appendChild(el('td', null, cat));
    columns.forEach((c, ci) => tr.appendChild(el('td', 'num', fmtPct(matrix[ri][ci]))));
    tbody.appendChild(tr);
  });
  table.append(thead, tbody);
  const wrap = el('div', 'table-wrap');
  wrap.appendChild(table);
  host.appendChild(wrap);
}

// ------------------------------------------------- gene query panel flow

/**
 * The queried genes colour the dataset cards.  Clicking a chip selects the
 * gene that is shown on the cards.
 */
function setActiveGene(gene) {
  app.activeGene = gene;
  renderChips();
  updateCardsForGene();
  jumpToGene(gene);
  updateUrlState();
}

/**
 * Scroll to the first dataset that contains the gene - the user usually
 * wants to look at it right away.
 */
function jumpToGene(gene) {
  if (!gene) return;
  const has = (ds) => ds.featureIndex?.has(normaliseFeature(gene));
  const current = app.datasets.find((d) => d.id === app.focusId);
  let target = current && has(current) ? current : app.datasets.find(has);
  if (!target) {
    toast(`${gene} is not in any of the loaded datasets`);
    return;
  }
  const card = app.cards.get(target.id);
  if (!card) return;
  focusDataset(target.id);
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderChips() {
  const box = $('#gene-chips');
  if (!box) return;
  box.innerHTML = '';
  if (!app.geneQuery.length) {
    box.style.display = 'none';
    return;
  }
  box.style.display = 'flex';
  app.geneQuery.forEach((gene, i) => {
    const chip = el('span', 'chip gene-chip' + (gene === app.activeGene ? ' active' : ''));
    const name = el('span', 'chip-name', gene);
    const x = el('span', 'chip-close', '\u00d7');
    x.title = 'Remove from the query';
    x.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (app.geneQuery.length > 1) {
        const next = app.geneQuery.slice();
        next.splice(i, 1);
        setGeneQuery(next);
      } else {
        setGeneQuery([]); // removing the only chip is a full clear
      }
    });
    chip.append(name, x);
    chip.addEventListener('click', (ev) => {
      if (ev.target === x) return;
      setActiveGene(gene); // choose which gene the cards colour by
    });
    box.appendChild(chip);
  });
}

async function runGeneQuery(raw) {
  const tokens = String(raw || '')
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const next = [...app.geneQuery];
  let unknown = [];
  for (const token of tokens) {
    const gene = resolveGene(token);
    if (gene) {
      if (!next.includes(gene) && next.length < 8) next.push(gene);
      continue;
    }
    // a prefix that matches several genes adds them all ('CSKR_', 'Smp-')
    const prefix = prefixGenes(token, 8 - Math.max(0, tokens.length - 1));
    if (prefix.length) {
      for (const g of prefix) {
        if (!next.includes(g) && next.length < 8) next.push(g);
      }
    } else {
      unknown.push(token);
    }
  }
  if (unknown.length) toast(`Unknown gene: ${unknown.join(', ')}`);
  if (next.length === app.geneQuery.length) return;
  setGeneQuery(next, { jump: true });
  $('#gene-input').value = '';
}

/**
 * Colour every card by the active gene (datasets that lack the feature stay
 * in their group colours).
 */
async function updateCardsForGene() {
  app.datasets.forEach((ds) => {
    const card = app.cards.get(ds.id);
    if (card) applyCardGene(card, ds);
  });
  refreshOpenDotplots();
  renderCompare();
}

/** Re-render any open in-card footer (dotplot or flows). */
function refreshOpenDotplots() {
  refreshFeet();
}

async function applyCardGene(card, ds) {
  const gene = app.activeGene && ds.featureIndex.has(normaliseFeature(app.activeGene))
    ? app.activeGene
    : null;
  card.gene = gene;
  // with a gene colouring the plot the category legend / composition adds nothing
  card.classList.toggle('gene-mode', Boolean(gene));
  if (card.metricBar && gene) card.metricBar.style.display = 'none';
  const viewer = card.viewer;
  if (!gene) {
    viewer.setExpression(null);
    if (card.geneBar) card.geneBar.style.display = 'none';
    return;
  }
  const expr = await loadGeneExpr(ds, gene);
  if (card.gene !== gene) return; // a new selection happened meanwhile
  if (!expr) {
    viewer.setExpression(null);
    card.classList.remove('gene-mode');
    if (card.geneBar) card.geneBar.style.display = 'none';
    return;
  }
  const maxValue = expr[`p${app.percentile}`] || expr.max || 1;
  viewer.setExpression(expr.values, maxValue, app.exprScheme);
  if (card.geneBar) {
    card.geneBar.innerHTML = '';
    const bar = el('div', 'colorbar');
    bar.style.background = `linear-gradient(to right, ${rampCss(app.exprScheme)})`;
    card.geneBar.append(
      el('span', 'muted', gene),
      bar,
      el('span', 'muted', `0 - ${maxValue.toFixed(2)}`)
    );
    card.geneBar.style.display = 'flex';
  }
}

export function setGeneQuery(genes, opts = {}) {
  if (!genes.includes(app.activeGene)) app.activeGene = genes[0] || null;
  app.geneQuery = genes;
  const clear = $('#gene-clear');
  if (clear) clear.style.display = genes.length ? '' : 'none';
  renderChips();
  updateCardsForGene();
  if (opts.jump) jumpToGene(app.activeGene);
  updateUrlState();
}

function rampCss(name) {
  const ramp = SCHEMES[name] || SCHEMES.viridis;
  const step = Math.max(1, Math.floor(ramp.length / 8));
  const stops = [];
  for (let i = 0; i < ramp.length; i += step) stops.push(ramp[i]);
  stops.push(ramp[ramp.length - 1]);
  return stops.join(',');
}

// ---------------------------------------------------------------- events

function bindGlobalEvents() {
  const input = $('#gene-input');
  const suggest = $('#gene-suggest');
  const run = () => runGeneQuery(input.value);

  $('#gene-go').addEventListener('click', run);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      run();
    } else if (ev.key === 'Escape') {
      suggest.style.display = 'none';
    }
  });
  input.addEventListener('input', debounce(() => showSuggestions(input.value, suggest), 160));

  $('#gene-clear').addEventListener('click', () => {
    input.value = '';
    suggest.style.display = 'none';
    setGeneQuery([]);
  });

  $('#theme-toggle').addEventListener('click', () => {
    const root = document.documentElement;
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    root.dataset.theme = next;
    localStorage.setItem('theme', next);
    document.dispatchEvent(new CustomEvent('themechange'));
    repaintAll();
  });

  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('#gene-search')) suggest.style.display = 'none';
  });

  window.addEventListener('hashchange', () => applyUrlState());
  window.addEventListener('resize', debounce(() => {
    repaintAll();
    app.cards.forEach((card) => fitCard(card));
    refreshFeet(); // the flows are drawn for the card width
  }, 250));

  const close = $('#gene-close');
  if (close) {
    close.addEventListener('click', () => {
      setGeneQuery([]);
    });
  }
}

function showSuggestions(query, box) {
  const q = String(query || '').trim();
  if (!q) {
    box.style.display = 'none';
    return;
  }
  const hits = searchGenes(q, 12);
  box.innerHTML = '';
  if (!hits.length) {
    box.style.display = 'none';
    return;
  }
  hits.forEach((gene) => {
    const item = el('div', 'suggest-item');
    item.append(el('span', 'chip-name', gene));
    const panels = panelsForGene(gene);
    if (panels.length) item.append(el('span', 'muted', panels.join(', ')));
    item.addEventListener('click', () => {
      $('#gene-input').value = '';
      box.style.display = 'none';
      setGeneQuery([...app.geneQuery, gene].slice(0, 8), { jump: true });
    });
    box.appendChild(item);
  });
  box.style.display = 'block';
}

function repaintAll() {
  app.datasets.forEach((ds) => {
    const card = app.cards.get(ds.id);
    if (!card) return;
    fitCard(card);
    card.viewer.render();
    renderLegend(card, ds);
    renderComposition(card, ds);
  });
  renderCompare();
}

// ------------------------------------------------- card footer (dual mode)

/**
 * The collapsible footer of every card: the gene dotplot while genes are
 * queried, otherwise the sankey / stacked-bars flow comparison.
 */
function buildCardFoot(card, ds) {
  const details = el('details', 'tc-foot');
  const summary = el('summary');
  details.appendChild(summary);
  const body = el('div', 'card-foot-body');
  details.appendChild(body);
  details.dataset.mode = '';
  card.cardFoot = details;
  card.cardFootBody = body;
  details.addEventListener('toggle', () => {
    if (details.open) refreshCardFoot(card, ds);
  });
  refreshCardFoot(card, ds, true);
  return details;
}

function refreshCardFoot(card, ds, force = false) {
  if (!card.cardFoot) return;
  ds = ds || card.dsRef;
  const details = card.cardFoot;
  const body = card.cardFootBody;
  const mode = app.geneQuery.length ? 'genes' : 'flows';
  if (mode !== details.dataset.mode || force) {
    details.dataset.mode = mode;
    details.className = mode === 'genes' ? 'gene-dot' : 'group-cmp';
  }
  const summary = details.querySelector('summary');
  if (mode === 'genes') {
    summary.textContent = 'Gene dotplot (mean expression \u00b7 % cells)';
    if (details.open) {
      // always repaint: the query may have changed (new / removed genes)
      body.innerHTML = '';
      renderGeneDotplot(card, body);
    }
  } else {
    summary.textContent = 'Group flows (sankey / stacked bars)';
    if (details.open) {
      body.innerHTML = '';
      renderGroupFlow(card, ds, body);
    }
  }
}

/**
 * Update the footer of every card: the label and the mode follow the query,
 * the content is only drawn when the card is open.
 */
function refreshFeet() {
  app.cards.forEach((card) => refreshCardFoot(card));
}

// ----------------------------------------------------- in-card gene dotplot

/** Aggregate the query genes for one dataset: rows = categories, cols = genes. */
async function geneDotAgg(ds, group, genes) {
  const codes = codesOf(ds, group);
  const cats = categoriesOf(ds, group);
  if (!codes || !cats.length) return null;
  const nCat = cats.length;
  const stats = [];
  for (const gene of genes) {
    if (!ds.featureIndex.has(normaliseFeature(gene))) continue;
    const expr = await loadGeneExpr(ds, gene);
    if (!expr) continue;
    const totals = new Float64Array(nCat);
    const sums = new Float64Array(nCat);
    const pos = new Float64Array(nCat);
    const vals = expr.values;
    for (let i = 0; i < vals.length; i++) {
      const c = codes[i];
      if (c < 0 || c >= nCat) continue;
      totals[c] += 1;
      if (vals[i] > 0) {
        sums[c] += vals[i];
        pos[c] += 1;
      }
    }
    const mean = new Float64Array(nCat);
    const pct = new Float64Array(nCat);
    for (let c = 0; c < nCat; c++) {
      if (totals[c]) {
        mean[c] = sums[c] / totals[c];
        pct[c] = pos[c] / totals[c];
      }
    }
    let geneMax = 0;
    for (let c = 0; c < nCat; c++) geneMax = Math.max(geneMax, mean[c]);
    stats.push({ gene, mean, pct, max: geneMax });
  }
  const { counts } = groupCounts(ds, group);
  return { cats, counts, stats };
}

function renderGeneDotplot(card, host) {
  const ds = card.dsRef;
  if (!ds || !host) return;
  host.innerHTML = '';
  const genes = app.geneQuery;
  if (!genes.length) {
    host.appendChild(el('p', 'muted', 'Search one or more genes (top right) to see their expression per category here.'));
    return;
  }
  host.appendChild(el('div', 'dotplot-loading', 'Aggregating \u2026'));

  const token = (card.dotToken = (card.dotToken || 0) + 1);
  geneDotAgg(ds, card.group, genes).then((agg) => {
    if (!agg || !host.isConnected) return;
    // the query may have been cleared or changed while we were aggregating
    if (card.dotToken !== token) return;
    if (card.cardFoot && card.cardFoot.dataset.mode !== 'genes') return;
    host.innerHTML = '';
    if (!agg.stats.length) {
      host.appendChild(el('p', 'muted', 'None of the queried genes is present in this dataset.'));
      return;
    }
    const DOT_MAX = 13;
    const DOT_MIN = 3;
    let absMax = 0;
    let pctMax = 0;
    agg.stats.forEach((s) => {
      for (let c = 0; c < s.mean.length; c++) {
        absMax = Math.max(absMax, s.mean[c]);
        pctMax = Math.max(pctMax, s.pct[c]);
      }
    });
    if (!absMax) absMax = 1;
    if (!pctMax) pctMax = 1;
    const perGene = app.dotNormalise === 'gene';

    const grid = el('div', 'gp');
    const head = el('div', 'gp-row gp-head');
    head.appendChild(el('span', 'gp-cat'));
    agg.stats.forEach((s) => {
      const cell = el('span', 'gp-x');
      const label = el('span', null, s.gene);
      label.title = s.gene;
      cell.appendChild(label);
      head.appendChild(cell);
    });
    grid.appendChild(head);

    const body = el('div', 'gp-body');
    agg.cats.forEach((cat, ci) => {
      const row = el('div', 'gp-row');
      const catCell = el('span', 'gp-cat', cat);
      if (agg.counts?.[ci] !== undefined) {
        const n = el('span', 'gp-n', `n=${fmt(agg.counts[ci])}`);
        n.title = `${cat}: ${fmt(agg.counts[ci])} cells`;
        catCell.appendChild(n);
      }
      row.appendChild(catCell);
      agg.stats.forEach((s) => {
        const mean = s.mean[ci] || 0;
        const pct = s.pct[ci] || 0;
        // colour: either one scale for all genes or the scale of this gene
        const scaleMax = perGene ? (s.max || absMax) : absMax;
        const tMean = Math.min(1, mean / (scaleMax || 1));
        const tPct = Math.min(1, pct / pctMax);
        const cell = el('span', 'gp-cell');
        if (mean > 0) {
          const size = (DOT_MIN + tPct * (DOT_MAX - DOT_MIN)).toFixed(1);
          const dot = el('span', 'gp-dot');
          dot.style.width = `${size}px`;
          dot.style.height = `${size}px`;
          dot.style.background = `hsl(212, 62%, ${Math.round(86 - 60 * tMean)}%)`;
          cell.appendChild(dot);
        }
        cell.dataset.gene = s.gene;
        cell.dataset.cat = cat;
        cell.dataset.mean = String(mean);
        cell.dataset.pct = String(pct);
        cell.dataset.n = String(agg.counts?.[ci] ?? '');
        row.appendChild(cell);
      });
      body.appendChild(row);
    });
    grid.appendChild(body);
    const legend = el('div', 'gp-legend');
    legend.textContent = perGene
      ? `\u25cf color = mean expression (per gene) \u2502 size = % expressing cells`
      : `\u25cf color = mean expression \u2502 size = % expressing cells \u2502 max ${fmt(absMax)}`;
    grid.appendChild(legend);
    host.appendChild(grid);

    // the normalise switch
    const controls = el('div', 'gp-controls');
    controls.appendChild(el('span', 'muted', 'Normalise'));
    const sel = el('select', 'mini-select');
    [['gene', 'per gene'], ['absolute', 'absolute mean']].forEach(([value, label]) => {
      const opt = el('option', null, label);
      opt.value = value;
      sel.appendChild(opt);
    });
    sel.value = app.dotNormalise;
    sel.title = 'Colour the dots by the scale of each gene or by one absolute scale';
    sel.addEventListener('change', () => {
      app.dotNormalise = sel.value;
      renderGeneDotplot(card, host);
    });
    controls.appendChild(sel);
    host.appendChild(controls);
    wireDotplotTooltip(grid);
  });
}

// ----------------------------------------------------- group flows (sankey)

/** Collapsible per-dataset sankey / stacked bar comparison of two groupings. */
function renderGroupFlow(card, ds, host) {
  if (!host) return;
  host.innerHTML = '';
  const groups = ds.groupNames.filter((g) => (ds.categories[g] || []).length);
  if (groups.length < 2) {
    host.appendChild(el('p', 'muted', 'This dataset needs two groupings (e.g. cell type and sample) for a flow comparison.'));
    return;
  }
  const pref = app.groupFlow[ds.id] || {};
  const controls = el('div', 'group-cmp-controls');

  const aSel = el('select', 'mini-select');
  const bSel = el('select', 'mini-select');
  groups.forEach((g) => {
    aSel.appendChild(el('option', null, g)).value = g;
    bSel.appendChild(el('option', null, g)).value = g;
  });
  let groupA = pref.a || ds.meta.default_group || groups[0];
  if (!groups.includes(groupA)) groupA = groups[0];
  const others = groups.filter((g) => g !== groupA);
  const bDefault = [...others].sort((x, y) => (ds.categories[y]?.length || 0) - (ds.categories[x]?.length || 0))[0];
  let groupB = pref.b || bDefault;
  if (!groups.includes(groupB) || groupB === groupA) groupB = bDefault;
  if (groupA === groupB) groupB = groups.find((g) => g !== groupA) || groupB;
  aSel.value = groupA;
  bSel.value = groupB;
  app.groupFlow[ds.id] = { a: groupA, b: groupB };
  aSel.addEventListener('change', () => {
    app.groupFlow[ds.id].a = aSel.value;
    if (bSel.value === aSel.value) {
      const alt = groups.find((g) => g !== aSel.value);
      if (alt) {
        bSel.value = alt;
        app.groupFlow[ds.id].b = alt;
      }
    }
    renderGroupFlow(card, ds, host);
  });
  bSel.addEventListener('change', () => {
    app.groupFlow[ds.id].b = bSel.value;
    renderGroupFlow(card, ds, host);
  });
  controls.append(wrapField('Rows', aSel), wrapField('Segments', bSel));
  host.appendChild(controls);

  const catsA = categoriesOf(ds, groupA);
  const catsB = categoriesOf(ds, groupB);
  const codesA = codesOf(ds, groupA);
  const codesB = codesOf(ds, groupB);
  if (!catsA.length || !catsB.length || !codesA || !codesB) {
    host.appendChild(el('p', 'muted', 'The groupings of this dataset could not be loaded.'));
    return;
  }

  const matrix = Array.from(catsA, () => new Float64Array(catsB.length));
  const totalsA = new Float64Array(catsA.length);
  const totalsB = new Float64Array(catsB.length);
  for (let i = 0; i < ds.n; i++) {
    const a = codesA[i];
    const b = codesB[i];
    if (a < 0 || a >= catsA.length || b < 0 || b >= catsB.length) continue;
    matrix[a][b] += 1;
    totalsA[a] += 1;
    totalsB[b] += 1;
  }

  const leftIdx = catsA.map((c, i) => i).sort((x, y) => totalsA[y] - totalsA[x]);
  const MAX_CATS = 50;
  const rightIdx = catsB
    .map((c, i) => i)
    .sort((x, y) => totalsB[y] - totalsB[x])
    .slice(0, MAX_CATS);
  if (catsB.length > MAX_CATS) {
    host.appendChild(el('p', 'muted', `Only the ${MAX_CATS} most abundant ${groupB} categories are shown.`));
  }

  const skMatrix = leftIdx.map((ra) => rightIdx.map((cb) => matrix[ra][cb]));

  // the flow has to fit into the card - the label columns are part of it
  const width = Math.max(300, Math.round(card.plotWrap?.clientWidth || 560));
  const labelW = Math.min(132, Math.round(width * 0.28));
  const flowHeight = Math.min(
    520,
    Math.max(240, 72 + Math.max(leftIdx.length, rightIdx.length) * 13)
  );

  // sankey
  host.appendChild(el('div', 'composition-title', `${groupA} \u2192 ${groupB} (sankey)`));
  const sHolder = el('div', 'chart-holder');
  const sCanvas = el('canvas');
  sHolder.appendChild(sCanvas);
  host.appendChild(sHolder);
  drawSankey(sCanvas, leftIdx.map((i) => catsA[i]), rightIdx.map((i) => catsB[i]), skMatrix, {
    width,
    height: flowHeight,
    labelWidth: labelW,
    colorForLeft: (cat, i) => groupColorFor(groupA, cat, leftIdx[i]),
  });
  // a second canvas carries the little bump that follows the mouse
  const cursorCanvas = el('canvas', 'flow-cursor');
  cursorCanvas.width = sCanvas.width;
  cursorCanvas.height = sCanvas.height;
  cursorCanvas.style.width = sCanvas.style.width || `${width}px`;
  cursorCanvas.style.height = sCanvas.style.height || `${flowHeight}px`;
  sHolder.appendChild(cursorCanvas);
  bindSankeyTooltip(sCanvas, cursorCanvas);

  // stacked bars
  host.appendChild(el('div', 'composition-title', `${groupA} \u00d7 ${groupB}`));
  const barHolder = el('div', 'chart-holder');
  const barCanvas = el('canvas');
  barHolder.appendChild(barCanvas);
  host.appendChild(barHolder);
  const rows = leftIdx.map((ra) => ({
    label: `${catsA[ra]} \u00b7 ${fmt(totalsA[ra])}`,
    values: rightIdx.map((cb) => matrix[ra][cb]),
  }));
  drawStackedBars(
    barCanvas,
    rows.map((r) => r.label),
    rightIdx.map((i) => catsB[i]),
    rows.map((r) => r.values),
    {
      width,
      rowH: 20,
      labelWidth: labelW,
      absolute: true, // show how many cells, not "100%" per row
      colorFor: (cat, i) => groupColorFor(groupB, cat, rightIdx[i]),
      formatTotal: (t) => `${fmt(t)} cells`,
    }
  );
  bindSegmentTooltip(barCanvas);
}

// ----------------------------------------------------- in-card tooltips

function bindSankeyTooltip(canvas, cursorCanvas) {
  const octx = cursorCanvas ? cursorCanvas.getContext('2d') : null;
  const ratio = cursorCanvas ? cursorCanvas.width / Math.max(1, canvas.clientWidth) : 1;
  const drawBump = (x, y, color) => {
    if (!octx) return;
    octx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
    if (x < 0) return;
    const r = 6 * ratio;
    octx.save();
    octx.beginPath();
    octx.arc(x * ratio, y * ratio, r, 0, Math.PI * 2);
    octx.fillStyle = color || 'rgba(120, 140, 170, 0.85)';
    octx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    octx.shadowBlur = 5 * ratio;
    octx.shadowOffsetY = 1.5 * ratio;
    octx.fill();
    octx.restore();
    octx.beginPath();
    octx.arc(x * ratio, y * ratio, r, 0, Math.PI * 2);
    octx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    octx.lineWidth = 1.4 * ratio;
    octx.stroke();
  };
  canvas.addEventListener('mousemove', (ev) => {
    const geo = canvas._sankey;
    if (!geo) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const tip = $('#tooltip');
    let hit = null;
    if (x >= geo.leftX && x <= geo.rightX + geo.nodeW) {
      for (const k of geo.links) {
        if (!k._top || k.v <= 0) continue;
        for (let s = 1; s < k._top.length; s++) {
          const a = k._top[s - 1];
          const b = k._top[s];
          if (x < a.x || x > b.x) continue;
          const t = (x - a.x) / Math.max(1e-9, b.x - a.x);
          const yTop = a.y + t * (b.y - a.y);
          if (y >= yTop - 1.5 && y <= yTop + k.h + 1.5) hit = k;
          break;
        }
        if (hit) break;
      }
    }
    if (!hit) {
      tip.style.display = 'none';
      drawBump(-1, -1, null);
      return;
    }
    const denom = geo.left.reduce((sum, n) => sum + n.total, 0) || 1;
    tip.innerHTML = `<b>${esc(hit.ln.cat)}</b> \u2192 <b>${esc(hit.rn.cat)}</b><br>` +
      `<span class="tip-muted">${fmt(hit.v)} cells \u00b7 ${fmtPct(hit.v / denom, 1)}</span>`;
    tip.style.display = 'block';
    // the bump marks the exact spot under the mouse
    drawBump(x, y, hit._color);
  });
  canvas.addEventListener('mouseleave', () => {
    const tip = $('#tooltip');
    if (tip) tip.style.display = 'none';
    drawBump(-1, -1, null);
  });
}

function bindSegmentTooltip(canvas) {
  canvas.addEventListener('mousemove', (ev) => {
    const segs = canvas._segments;
    if (!segs) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const tip = $('#tooltip');
    let found = null;
    for (const row of segs) {
      for (const seg of row) {
        if (x >= seg.x0 && x <= seg.x1 && y >= seg.y0 && y <= seg.y1) found = seg;
      }
    }
    if (!found) {
      tip.style.display = 'none';
      return;
    }
    tip.innerHTML = `<b>${esc(found.label)}</b><br><span class="tip-muted">${fmt(found.value)} cells</span>`;
    tip.style.display = 'block';
  });
  canvas.addEventListener('mouseleave', () => {
    const tip = $('#tooltip');
    if (tip) tip.style.display = 'none';
  });
}

/** The styled tooltip for the in-card gene dotplot cells. */
function wireDotplotTooltip(grid) {
  grid.addEventListener('mousemove', (ev) => {
    const cell = ev.target.closest('.gp-cell');
    const tip = $('#tooltip');
    if (!cell || !tip) {
      if (tip) tip.style.display = 'none';
      return;
    }
    const pct = parseFloat(cell.dataset.pct) || 0;
    const n = cell.dataset.n;
    tip.innerHTML =
      `<b>${esc(cell.dataset.gene)}</b> \u00b7 <b>${esc(cell.dataset.cat)}</b>` +
      (n !== '' ? ` <span class="tip-muted">n=${esc(n)}</span>` : '') +
      `<br><span class="tip-muted">mean ${fmt(parseFloat(cell.dataset.mean))}` +
      (pct > 0 ? ` \u00b7 ${fmtPct(pct, 1)} expressing cells` : '') +
      `</span>`;
    tip.style.display = 'block';
  });
  grid.addEventListener('mouseleave', () => {
    const tip = $('#tooltip');
    if (tip) tip.style.display = 'none';
  });
}

/** Collapsible per-dataset dotplot of the query genes. */
// ------------------------------------------------------------- url state

function updateUrlState() {
  const params = new URLSearchParams();
  if (app.focusId) params.set('ds', app.focusId);
  if (app.geneQuery.length) params.set('gene', app.geneQuery.join(','));
  const hash = params.toString();
  if (hash) history.replaceState(null, '', `#${hash}`);
}

function applyUrlState(hash = window.location.hash) {
  hash = String(hash).replace(/^#/, '');
  if (!hash) return;
  const params = new URLSearchParams(hash);
  const ds = params.get('ds');
  if (ds && app.datasets.some((d) => d.id === ds) && ds !== app.focusId) {
    app.focusId = ds;
    document.querySelectorAll('.dset-card').forEach((c) => c.classList.toggle('focused', c.dataset.ds === ds));
  }
  const gene = params.get('gene');
  if (gene) {
    const genes = gene.split(',').map((g) => resolveGene(g) || g).filter(Boolean);
    if (genes.length && genes.join(',') !== app.geneQuery.join(',')) {
      setGeneQuery(genes);
    }
  }
}

/** Composition of the cells the user selected with the brush. */
function renderSelection(card, ds) {
  const host = card.selectionHost;
  if (!host) return;
  host.innerHTML = '';
  const cells = card.selectedCells || [];
  if (!cells.length) return;
  const group = card.group;
  const cats = categoriesOf(ds, group);
  const codes = codesOf(ds, group);
  const counts = new Int32Array(cats.length);
  for (const i of cells) {
    const c = codes ? codes[i] : -1;
    if (c >= 0 && c < counts.length) counts[c]++;
  }
  const n = cells.length;
  const head = el('div', 'composition-title');
  head.innerHTML = `Selection · ${fmt(n)} cells`;
  const clear = el('button', 'mini-btn', 'Clear');
  clear.addEventListener('click', () => {
    card.selectedCells = null;
    card.viewer.setSelection(null);
    renderSelection(card, ds);
  });
  head.appendChild(clear);
  host.appendChild(head);

  const present = cats.map((c, i) => [c, counts[i]]).filter(([, v]) => v > 0);
  present.sort((a, b) => b[1] - a[1]);
  if (!present.length) {
    host.appendChild(el('p', 'muted', 'No cells of this dataset in the selection.'));
    return;
  }
  const canvas = el('canvas');
  host.appendChild(canvas);
  const labels = present.map(([c]) => c);
  const values = present.map(([, v]) => v);
  drawStackedBars(canvas, [`${fmt(n)} cells`], labels, [values], {
    width: Math.max(280, Math.round(card.plotWrap?.clientWidth || 640)),
    rowH: 26,
    labelWidth: 110,
    colorFor: (cat) => groupColorFor(group, cat),
    formatTotal: (t) => fmt(t),
  });
  // the legend of the selection
  const legend = el('div', 'legend');
  labels.forEach((cat, i) => {
    const chip = el('span', 'chip');
    const swatch = el('i');
    swatch.style.background = groupColorFor(group, cat, i);
    chip.append(swatch, el('span', 'chip-name', cat), el('span', 'chip-count', `${fmt(values[i])} · ${fmtPct(values[i] / n, 1)}`));
    legend.appendChild(chip);
  });
  host.appendChild(legend);
}

// -------------------------------------------------------------- markers

let markerData = null;
const markerStatsCache = new Map();

async function ensureMarkers() {
  if (markerData) return markerData;
  try {
    markerData = await fetchJSON('data/markers.json');
  } catch (err) {
    console.warn('no markers.json', err);
    markerData = { panels: {} };
  }
  return markerData;
}

async function ensureMarkerStats(datasetId) {
  if (markerStatsCache.has(datasetId)) return markerStatsCache.get(datasetId);
  let payload = null;
  try {
    payload = await fetchJSON(`data/${datasetId}/marker_stats.json`);
  } catch (err) {
    payload = null;
  }
  markerStatsCache.set(datasetId, payload);
  return payload;
}

async function renderMarkers() {
  const section = $('#marker-section');
  const body = $('#marker-body');
  if (!section || !body) return;
  await ensureMarkers();

  const available = app.datasets.filter((d) => markerData.panels?.[d.id]);
  if (!available.length) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  const ds = available.find((d) => d.id === app.focusId) || available[0];
  const groups = Object.keys(markerData.panels[ds.id] || {});
  const group = app.markerGroup && groups.includes(app.markerGroup) ? app.markerGroup : groups[0];
  app.markerGroup = group;
  const topN = app.markerTopN || 10;

  const controls = el('div', 'toolbar');
  const dsSel = el('select', 'tool-select');
  available.forEach((d) => {
    const opt = el('option', null, d.meta.name || d.id);
    opt.value = d.id;
    dsSel.appendChild(opt);
  });
  dsSel.value = ds.id;
  dsSel.addEventListener('change', () => {
    app.focusId = dsSel.value;
    renderMarkers();
  });
  controls.appendChild(wrapField('Dataset', dsSel));

  const groupSel = el('select', 'tool-select');
  groups.forEach((g) => {
    const opt = el('option', null, g);
    opt.value = g;
    groupSel.appendChild(opt);
  });
  groupSel.value = group;
  groupSel.addEventListener('change', () => {
    app.markerGroup = groupSel.value;
    renderMarkers();
  });
  controls.appendChild(wrapField('Grouping', groupSel));

  const nSel = el('select', 'tool-select');
  [5, 10, 20, 50].forEach((n) => {
    const opt = el('option', null, `top ${n}`);
    opt.value = String(n);
    nSel.appendChild(opt);
  });
  nSel.value = String(topN);
  nSel.addEventListener('change', () => {
    app.markerTopN = parseInt(nSel.value, 10);
    renderMarkers();
  });
  controls.appendChild(wrapField('Markers', nSel));

  body.innerHTML = '';
  body.appendChild(controls);

  const stats = await ensureMarkerStats(ds.id);
  const markers = markerData.panels[ds.id][group] || {};
  const cats = Object.keys(markers);

  // every category owns a contiguous block of columns
  const columns = [];
  const ownRange = new Map();
  cats.forEach((cat) => {
    const start = columns.length;
    const seen = new Set();
    for (const rec of (markers[cat] || []).slice(0, topN)) {
      if (seen.has(rec.gene)) continue;
      seen.add(rec.gene);
      columns.push({ gene: rec.gene, cat });
    }
    ownRange.set(cat, [start, columns.length]);
  });

  // the sheet holds [pct, mean] per (gene, category)
  const sheet = new Float32Array(columns.length * cats.length * 2);
  const statGroup = stats?.[group];
  const geneIndex = new Map((statGroup?.genes || []).map((g, i) => [g, i]));
  const catIndex = new Map((statGroup?.cats || cats).map((c, i) => [c, i]));
  columns.forEach((col, gi) => {
    const si = geneIndex.get(col.gene);
    if (si === undefined) return;
    cats.forEach((cat, ci) => {
      const cj = catIndex.get(cat);
      if (cj === undefined) return;
      sheet[(gi * cats.length + ci) * 2] = statGroup.pct[si][cj];
      sheet[(gi * cats.length + ci) * 2 + 1] = statGroup.mean[si][cj];
    });
  });

  const wrap = el('div', 'dotplot-wrap');
  const headCanvas = el('canvas', 'dotplot-header');
  const bodyWrap = el('div', 'dotplot-body');
  const labelCanvas = el('canvas', 'dotplot-labels');
  const gridCanvas = el('canvas', 'dotplot-grid');
  bodyWrap.append(labelCanvas, gridCanvas);
  wrap.append(headCanvas, bodyWrap);
  body.appendChild(wrap);

  const cellW = 22;
  const cellH = 20;
  drawDotplot(gridCanvas, columns.map((c) => c.gene), cats, sheet, {
    cellW,
    cellH,
    maxMean: maxMeanOf(sheet),
    rings: new Set(columns.filter((c) => isTopMarker(markers[c.cat], c.gene)).map((c) => c.gene)),
  });
  drawDotplotLabels(labelCanvas, cats, columns, ownRange, cellH);
  drawDotplotHeader(headCanvas, columns, cellW);

  gridCanvas.addEventListener('mousemove', (ev) => {
    const geo = gridCanvas._dotplot;
    if (!geo) return;
    const rect = gridCanvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const gi = Math.floor(x / cellW);
    const ci = Math.floor(y / cellH);
    const tip = $('#tooltip');
    if (gi < 0 || gi >= geo.genes.length || ci < 0 || ci >= geo.cats.length) {
      tip.style.display = 'none';
      return;
    }
    const rec = sheet[(gi * geo.cats.length + ci) * 2];
    const mean = sheet[(gi * geo.cats.length + ci) * 2 + 1];
    tip.innerHTML =
      `<b>${esc(geo.genes[gi])}</b><br>${esc(geo.cats[ci])}<br>` +
      `<span class="tip-muted">${fmtPct(rec, 1)} expressing · mean ${mean.toFixed(2)}</span>`;
    tip.style.display = 'block';
  });
  gridCanvas.addEventListener('mouseleave', () => {
    const tip = $('#tooltip');
    if (tip) tip.style.display = 'none';
  });
}

function wrapField(label, control) {
  const field = el('label', 'tool-field');
  field.append(el('span', 'tool-label', label), control);
  return field;
}

function maxMeanOf(sheet) {
  let max = 0;
  for (let i = 1; i < sheet.length; i += 2) max = Math.max(max, sheet[i]);
  return max || 1;
}

function isTopMarker(records, gene) {
  if (!records) return false;
  return records.some((r) => r.gene === gene);
}

function drawDotplotLabels(canvas, cats, columns, ownRange, cellH) {
  const theme = canvasTheme();
  const width = 200;
  const height = cats.length * cellH + 10;
  const { ctx } = sizeCanvas(canvas, width, height);
  ctx.clearRect(0, 0, width, height);
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  cats.forEach((cat, i) => {
    const y = i * cellH + cellH / 2;
    const range = ownRange.get(cat) || [0, 0];
    ctx.fillStyle = theme.fg;
    ctx.textAlign = 'right';
    const label = cat.length > 24 ? cat.slice(0, 23) + '…' : cat;
    ctx.fillText(label, width - 52, y);
    ctx.fillStyle = theme.muted;
    ctx.font = '9.5px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${range[1] - range[0]}`, width - 46, y);
    ctx.font = '11px system-ui, sans-serif';
  });
}

function drawDotplotHeader(canvas, columns, cellW) {
  const theme = canvasTheme();
  const width = columns.length * cellW + 10;
  const height = 100;
  const { ctx } = sizeCanvas(canvas, width, height);
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = theme.muted;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  columns.forEach((col, i) => {
    ctx.save();
    ctx.translate(i * cellW + cellW / 2, height - 6);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(col.gene, 0, 0);
    ctx.restore();
  });
  ctx.restore();
}

// --------------------------------------------------------------- footer

function renderFooter() {
  const foot = $('#footer');
  if (!foot) return;
  foot.innerHTML = '';
  const cols = el('div', 'footer-cols');
  const c1 = el('div', 'footer-col');
  c1.innerHTML = `<h4>${esc(state.project.name)}</h4><p class="muted">${esc(state.project.subtitle || '')}</p>`;
  const c2 = el('div', 'footer-col');
  c2.innerHTML =
    '<h4>Datasets</h4><ul>' +
    app.datasets.map((d) => `<li>${esc(d.meta.name || d.id)} <span class="muted">${fmt(d.n)} cells</span></li>`).join('') +
    '</ul>';
  const c3 = el('div', 'footer-col');
  c3.innerHTML =
    '<h4>Usage</h4><p class="muted">Wheel zooms · drag selects · shift-drag pans · double click resets</p>' +
    '<p class="muted">Press <b>?</b> in the top bar for how to add and remove data.</p>' +
    '<p class="muted">OmicsExplorer · by <a href="https://github.com/zglu" target="_blank" rel="noopener">zglu</a></p>';
  cols.append(c1, c2, c3);
  foot.appendChild(cols);
}
