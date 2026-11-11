// End to end test: drives the app in a headless browser and checks the
// behaviour that matters.
//
//   node tests/e2e.mjs [url]
//
// Uses the puppeteer installation of a sibling project when available, so no
// download is needed.

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const CANDIDATES = [
  process.env.PUPPETEER_PATH || '',
  '/home/ubuntu/zglu_Data/WebProjects/NematodeAtlas_Data-Dev',
  process.cwd(),
].filter(Boolean);

let puppeteer = null;
for (const base of CANDIDATES) {
  try {
    puppeteer = require(require.resolve('puppeteer', { paths: [base] }));
    break;
  } catch (err) {
    /* next */
  }
}
if (!puppeteer) {
  console.error('puppeteer not found - install it with `npm i puppeteer`');
  process.exit(2);
}

const URL_ = process.argv[2] || 'http://127.0.0.1:8099/';
const OUT = process.argv[3] || '/tmp/opencode/oe_shots';
mkdirSync(OUT, { recursive: true });

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ' - ' + detail : ''}`);
    console.log(`  FAIL ${name}${detail ? ' - ' + detail : ''}`);
  }
}

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1100 });

const errors = [];
const missing = [];
page.on('console', (msg) => {
  const text = msg.text();
  if (text.includes('blob:fake')) return; // artefact of the export test
  if (msg.type() === 'error') errors.push(text);
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message} :: ${(err.stack || '').split('\n').slice(0, 4).join(' | ')}`));
page.on('requestfailed', (req) => {
  if (req.method() === 'HEAD' && req.failure()?.errorText === 'net::ERR_ABORTED') return;
  errors.push(`requestfailed: ${req.method()} ${req.url()}`);
});
page.on('response', (res) => {
  if (res.status() >= 400) missing.push(`${res.status()} ${res.url()}`);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n# loading');
await page.goto(URL_, { waitUntil: 'networkidle2', timeout: 90000 });
await wait(2500);

// ---------------------------------------------------------------- overview
console.log('\n# overview');
// dataset count is whatever the live project serves (users may add their own)
const N_DS = await page.evaluate(() =>
  fetch('/api/project').then((r) => r.json()).then((p) => (p.panels || []).length));
let s = await page.evaluate(() => ({
  cards: document.querySelectorAll('.dset-card').length,
  legends: document.querySelectorAll('.legend').length,
  chips: document.querySelectorAll('.dset-card .legend .chip').length,
  grips: document.querySelectorAll('.dset-card .grip').length,
  compositions: document.querySelectorAll('.composition canvas').length,
  busy: document.getElementById('busy')?.textContent || '',
}));
check('every dataset has a card', s.cards === N_DS, `got ${s.cards}, want ${N_DS}`);
check('every card has a legend', s.legends === N_DS, `got ${s.legends}`);
check('legends list categories', s.chips > 20, `got ${s.chips}`);
check('every card has a drag grip', s.grips === N_DS, `got ${s.grips}`);
const tabs = await page.evaluate(() =>
  Array.from(document.querySelectorAll('#dataset-tabs .tab')).map((t) => t.textContent)
);
check('the top tabs list every dataset', tabs.length === N_DS + 1 && tabs[0] === 'All', JSON.stringify(tabs));
check('cards show the sample composition', s.compositions >= 2, `got ${s.compositions}`);
check('loading finished', s.busy === '', s.busy);

// the WebGL canvas must actually contain points
const painted = await page.evaluate(() => {
  const gl = document.querySelector('.oe-gl');
  const ctx = gl.getContext('webgl2');
  const px = new Uint8Array(4 * 400);
  ctx.readPixels(gl.width / 2 - 10, gl.height / 2 - 10, 20, 20, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 0) n++;
  return n;
});
check('the plot is painted', painted > 50, `${painted} pixels`);

// ---------------------------------------------------------------- grouping
console.log('\n# grouping');
const before = await page.evaluate(() => document.querySelector('.dset-card .legend .chip .chip-name').textContent);
await page.select('.dset-card .dset-tools select:nth-of-type(2)', 'cluster');
await wait(700);
const after = await page.evaluate(() => ({
  first: document.querySelector('.dset-card .legend .chip .chip-name').textContent,
  chips: document.querySelectorAll('.dset-card .legend .chip').length,
}));
check('switching the grouping changes the legend', after.first !== before, `${before} -> ${after.first}`);
check('the cluster grouping has more categories', after.chips > 20, `got ${after.chips}`);

// hide a category with the legend
const hidden = await page.evaluate(() => {
  const chip = document.querySelector('.dset-card .legend .chip');
  const name = chip.querySelector('.chip-name').textContent;
  chip.click();
  const again = Array.from(document.querySelectorAll('.dset-card .legend .chip')).find(
    (c) => c.querySelector('.chip-name').textContent === name
  );
  return { name, off: again ? again.classList.contains('off') : false };
});
check('clicking a legend chip hides the category', hidden.off, hidden.name);

// -------------------------------------------------------------- embedding
console.log('\n# embedding');
await page.evaluate(() => {
  const card = document.querySelector('.dset-card');
  const selects = card.querySelectorAll('.dset-tools select');
  selects[0].value = 'umap';
  selects[0].dispatchEvent(new Event('change'));
});
await wait(700);
const emb = await page.evaluate(() => {
  const card = document.querySelector('.dset-card');
  const sel = card.querySelectorAll('.dset-tools select')[0];
  return { value: sel.value, options: Array.from(sel.options).map((o) => o.value) };
});
check('the embedding can be switched', emb.value === 'umap', JSON.stringify(emb.options));
check('the dataset offers several embeddings', emb.options.length >= 2, JSON.stringify(emb.options));

// ------------------------------------------------------------- background
console.log('\n# background image');
await page.evaluate(() => {
  const cb = document.querySelector('.dset-card .mini-check input');
  cb.click();
});
await wait(1500);
const imageOk = await page.evaluate(() => {
  const bg = document.querySelector('.dset-card .oe-bg');
  const ctx = bg.getContext('2d');
  const data = ctx.getImageData(0, 0, bg.width, bg.height).data;
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]) n++;
  return n;
});
check('the histology image is drawn behind the cells', imageOk > 1000, `${imageOk} pixels`);

// -------------------------------------------------------------- selection
console.log('\n# brush selection');
// the mouse defaults to panning - switch the card to the select mode first
await page.evaluate(() => {
  const card = document.querySelector('.dset-card');
  const modeSel = Array.from(card.querySelectorAll('.dset-tools select')).find(
    (x) => x.options[0]?.textContent === 'Select'
  );
  modeSel.value = 'select';
  modeSel.dispatchEvent(new Event('change'));
});
const box = await page.evaluate(() => {
  const rect = document.querySelector('.dset-card .oe-top').getBoundingClientRect();
  return { x: rect.left, y: rect.top };
});
await page.mouse.move(box.x + 120, box.y + 120);
await page.mouse.down();
await page.mouse.move(box.x + 260, box.y + 240, { steps: 8 });
await page.mouse.move(box.x + 340, box.y + 330, { steps: 8 });
await page.mouse.up();
await wait(700);
const selInfo = await page.evaluate(() => ({
  text: document.querySelector('.dset-card .selection .composition-title')?.textContent || '',
  chips: document.querySelectorAll('.dset-card .selection .legend .chip').length,
}));
check('brushing selects cells', /Selection/.test(selInfo.text), selInfo.text);
check('the selection shows its composition', selInfo.chips > 0, `got ${selInfo.chips}`);

// double click resets the view and drops the selection
const reset = await page.evaluate(() => {
  const card = document.querySelector('.dset-card');
  const top = card.querySelector('.oe-top');
  const r = top.getBoundingClientRect();
  top.dispatchEvent(
    new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      deltaY: -240,
    })
  );
  top.dispatchEvent(
    new MouseEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    })
  );
  return true;
});
await wait(600);
const afterReset = await page.evaluate(() => ({
  selection: document.querySelectorAll('.dset-card .selection .composition-title').length,
}));
check('a double click clears the selection', reset && afterReset.selection === 0, JSON.stringify(afterReset));

// -------------------------------------------------------- card ordering
console.log('\n# card drag ordering');
const drag = await page.evaluate(() => {
  const grid = document.getElementById('overview-grid');
  const before = Array.from(grid.children).map((c) => c.dataset.ds);
  const first = grid.children[0];
  const second = grid.children[1];
  const grip = second.querySelector('.grip');
  const dt = new DataTransfer();
  grip.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }));
  first.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
  grip.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  const after = Array.from(grid.children).map((c) => c.dataset.ds);
  const stored = JSON.parse(localStorage.getItem('oe.cardOrder:' + document.title) + '');
  return { before, after, stored };
});
check('dragging a card reorders the grid', drag.after[0] === drag.before[1] && drag.after[1] === drag.before[0], JSON.stringify(drag.after));
check('the new order is saved', Array.isArray(drag.stored) && drag.stored[0] === drag.after[0], JSON.stringify(drag.stored));

// ---------------------------------------------------------------- compare
console.log('\n# compare');
const compare = await page.evaluate(() => ({
  rows: document.querySelectorAll('.data-table tbody tr').length,
  cols: document.querySelectorAll('.data-table thead th').length,
  first: Array.from(document.querySelectorAll('.data-table tbody tr')[0]?.children || []).map((td) => td.textContent),
}));
check('the comparison table lists the categories', compare.rows > 5, `got ${compare.rows}`);
check('the comparison table has one column per dataset', compare.cols === N_DS + 1, `got ${compare.cols}, want ${N_DS + 1}`);
check('the first row has percentages', /%/.test(compare.first.join(' ')), compare.first.join(' '));

// ---------------------------------------------------------------- markers
console.log('\n# markers');
const markers = await page.evaluate(() => {
  const grid = document.querySelector('.dotplot-grid');
  if (!grid) return null;
  const ctx = grid.getContext('2d');
  const data = ctx.getImageData(0, 0, grid.width, grid.height).data;
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]) n++;
  return { dots: n, genes: grid._dotplot?.genes?.length || 0, cats: grid._dotplot?.cats?.length || 0 };
});
check('the marker dot plot is drawn', markers && markers.dots > 100, JSON.stringify(markers));
check('the dot plot has genes and categories', markers && markers.genes > 10 && markers.cats > 3, JSON.stringify(markers));

// ------------------------------------------------------------------- gene
console.log('\n# gene query');
await page.type('#gene-input', 'CSKR_111915');
await wait(400);
await page.click('#gene-go');
await wait(2500);
let gene = await page.evaluate(() => ({
  chips: Array.from(document.querySelectorAll('#gene-chips .chip.gene-chip')).map((c) =>
    c.querySelector('.chip-name').textContent
  ),
  active: document.querySelector('#gene-chips .chip.gene-chip.active .chip-name')?.textContent || '',
  hash: window.location.hash,
  geneBar: Array.from(document.querySelectorAll('.dset-card .gene-bar')).filter((b) => b.style.display !== 'none').length,
  clearBtn: document.getElementById('gene-clear')?.style.display !== 'none',
  dotplot: !!document.querySelector('.dset-card details'),
}));
check('the query is stored as a chip', gene.chips.length === 1, gene.chips.join(','));
check('the query is stored in the URL', /gene=/.test(gene.hash), gene.hash);
check('the gene input has a clear button', gene.clearBtn === true);
check('every card offers the gene dotplot', gene.dotplot === true, String(gene.dotplot));
check('the old gene panel is gone', await page.evaluate(() => !document.getElementById('gene-body')), '');

// the cards are coloured by the expression of the gene
const coloured = await page.evaluate(() => {
  const bars = Array.from(document.querySelectorAll('.dset-card .gene-bar')).filter(
    (b) => b.style.display !== 'none'
  );
  if (!bars.length) return { n: 0, cards: 0 };
  const gl = bars[0].closest('.dset-card')?.querySelector('.oe-gl');
  if (!gl) return { n: 0, cards: bars.length };
  const ctx = gl.getContext('webgl2');
  const px = new Uint8Array(4 * gl.width * gl.height);
  ctx.readPixels(0, 0, gl.width, gl.height, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 0 && (px[i] || px[i + 1] || px[i + 2])) n++;
  return { n, cards: bars.length };
});
check('cards colour by the queried gene', coloured.cards >= 1, `${coloured.cards} cards`);
check('the gene plot has coloured cells', coloured.n > 100, `${coloured.n}`);

// gene-mode: the category legend / composition under the plot are hidden
const geneMode = await page.evaluate(() => ({
  mode: document.querySelectorAll('.dset-card.gene-mode').length,
  hiddenLegend: Array.from(document.querySelectorAll('.dset-card.gene-mode > .legend'))
    .every((l) => getComputedStyle(l).display === 'none'),
  compositionGone: Array.from(document.querySelectorAll('.dset-card.gene-mode > .composition'))
    .every((l) => getComputedStyle(l).display === 'none'),
}));
check('cards with the gene enter gene-mode', geneMode.mode >= 1, `${geneMode.mode}`);
check('gene-mode hides the legend and composition', geneMode.hiddenLegend && geneMode.compositionGone);

// the in-card gene dotplot aggregates the gene per category
await page.evaluate(() => {
  const details =
    document.querySelector('.dset-card.focused details') ||
    document.querySelector('.dset-card details');
  details.open = true;
});
await wait(1800);
const cardDot = await page.evaluate(() => {
  const details =
    document.querySelector('.dset-card.focused details.gene-dot') ||
    document.querySelector('.dset-card details.gene-dot');
  if (!details) return null;
  const grid = details.querySelector('.gp');
  if (!grid) return null;
  return {
    rows: grid.querySelectorAll('.gp-row').length - 1,
    cats: Array.from(grid.querySelectorAll('.gp-body .gp-cat')).map((e) =>
      e.childNodes[0]?.textContent || ''
    ),
    dots: grid.querySelectorAll('.gp-dot').length,
    tip: Boolean(grid.querySelector('.gp-cell[data-gene]')),
    legend: /color = mean expression/.test(grid.querySelector('.gp-legend')?.textContent || ''),
  };
});
check('the card dotplot lists the categories', cardDot && cardDot.rows >= 3, JSON.stringify(cardDot?.rows));
check('the card dotplot draws dots', cardDot && cardDot.dots >= 1, JSON.stringify(cardDot?.dots));
check('the card dotplot tooltips cells', Boolean(cardDot?.tip));
check('the card dotplot has a legend', Boolean(cardDot?.legend));

// switching the active gene chip (second gene) re-colours the cards
await page.evaluate(() => {
  document.getElementById('gene-input').value = 'CSKR_100004';
});
await page.type('#gene-input', ' ');
await wait(200);
await page.click('#gene-go');
await wait(1200);
await page.evaluate(() => {
  const second = Array.from(document.querySelectorAll('#gene-chips .chip.gene-chip'))[1];
  second.click();
});
await wait(1500);
gene = await page.evaluate(() => ({
  active: document.querySelector('#gene-chips .chip.gene-chip.active .chip-name')?.textContent || '',
  chips: document.querySelectorAll('#gene-chips .chip.gene-chip').length,
}));
check('clicking a chip selects the displayed gene', gene.active === 'CSKR_100004' && gene.chips === 2, JSON.stringify(gene));

// a prefix that matches several genes adds them all ('CSKR_', 'Smp-')
await page.click('#gene-clear');
await wait(800);
await page.evaluate(() => {
  document.getElementById('gene-input').value = 'CSKR_';
});
await page.click('#gene-go');
await wait(1500);
const prefix = await page.evaluate(() => ({
  chips: document.querySelectorAll('#gene-chips .gene-chip').length,
  closes: document.querySelectorAll('#gene-chips .chip-close').length,
  bars: Array.from(document.querySelectorAll('.dset-card .gene-bar')).filter((b) => b.style.display !== 'none').length,
}));
check('a gene prefix adds every matching gene', prefix.chips >= 2 && prefix.closes === prefix.chips, JSON.stringify(prefix));
check('the prefix query colours the cards', prefix.bars >= 1, `${prefix.bars}`);
// removing the single remaining chip restores group colours
await page.waitForFunction(() => document.querySelectorAll('#gene-chips .gene-chip').length >= 1);
await page.evaluate(() => {
  const chips = document.querySelectorAll('#gene-chips .gene-chip');
  for (let i = chips.length - 1; i; i--) chips[i].querySelector('.chip-close').click();
});
await wait(600);
await page.evaluate(() => document.querySelector('#gene-chips .gene-chip .chip-close').click());
await wait(1200);
const chipClear = await page.evaluate(() => ({
  chips: document.querySelectorAll('#gene-chips .gene-chip').length,
  geneMode: document.querySelectorAll('.dset-card.gene-mode').length,
}));
check('removing the last chip clears the query', chipClear.chips === 0 && chipClear.geneMode === 0, JSON.stringify(chipClear));

// with the query empty the same footer falls back to the group flows
await page.evaluate(() => { document.querySelector('.dset-card details').open = true; });
await wait(1200);
const flows = await page.evaluate(() => {
  const d = document.querySelector('.dset-card details.group-cmp');
  if (!d) return null;
  const canvases = Array.from(d.querySelectorAll('canvas'));
  return {
    summary: d.querySelector('summary')?.textContent || '',
    sankey: canvases.some((c) => c._sankey),
    bars: canvases.filter((c) => c._segments).length,
    selects: d.querySelectorAll('select').length,
  };
});
check('the footer falls back to group flows', flows && /Group flows/.test(flows.summary), JSON.stringify(flows));
check('the group flows render a sankey and bars', flows && flows.sankey && flows.bars >= 1 && flows.selects === 2, JSON.stringify(flows));
await page.evaluate(() => { document.querySelector('.dset-card details').open = false; });

// ------------------------------------------------- search by description
console.log('\n# gene search by description');
await page.evaluate(() => {
  document.getElementById('gene-input').value = '';
});
await page.type('#gene-input', 'Paramyosin');
await wait(700);
const suggestions = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.suggest-item .chip-name')).map((n) => n.textContent)
);
check('a product description finds the gene', suggestions[0] === 'CSKR_100004', suggestions.slice(0, 3).join(', '));
// picking a suggestion puts the gene into the query
await page.evaluate(() => document.querySelector('.suggest-item').click());
await wait(1000);

// the clear button removes the whole gene query
await page.click('#gene-clear');
await wait(1200);
const cleared = await page.evaluate(() => ({
  chips: document.querySelectorAll('#gene-chips .chip').length,
  active: !!document.querySelector('#gene-chips .chip.gene-chip.active'),
  clearVisible: document.getElementById('gene-clear').style.display !== 'none',
  geneMode: document.querySelectorAll('.dset-card.gene-mode').length,
}));
check('clearing removes the chips', cleared.chips === 0, JSON.stringify(cleared));
check('clearing hides the clear button', !cleared.clearVisible);
check('clearing restores the group legend', cleared.geneMode === 0);

// ------------------------------------------------- quantitative metadata
console.log('\n# colour by a metric');
const metricInfo = await page.evaluate(async () => {
  const field = Array.from(document.querySelectorAll('#toolbar .tool-field')).find(
    (f) => f.querySelector('.tool-label')?.textContent === 'Colour by'
  );
  if (!field) return { ok: false };
  const sel = field.querySelector('select');
  const values = Array.from(sel.options).map((o) => o.value);
  const metric = values.find((v) => v === 'nCount_RNA') || values.find((v) => v !== 'group');
  if (!metric) return { ok: false, values };
  sel.value = metric;
  sel.dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 2500));
  const card = Array.from(document.querySelectorAll('.dset-card')).find((c) => c.classList.contains('metric-mode'));
  return {
    ok: true,
    metric,
    values: values.length,
    bar: card ? Array.from(card.querySelectorAll('.gene-bar')).some((b) => b.style.display === 'flex') : false,
    legend: card ? getComputedStyle(card.querySelector('.legend')).display === 'none' : false,
  };
});
check('the toolbar offers the quantitative metadata', metricInfo.ok && metricInfo.values > 2, JSON.stringify(metricInfo));
check('a metric colours the cards', metricInfo.bar === true, JSON.stringify(metricInfo));
check('the category legend is hidden in metric mode', metricInfo.legend === true);
// back to the categories
await page.evaluate(() => {
  const field = Array.from(document.querySelectorAll('#toolbar .tool-field')).find(
    (f) => f.querySelector('.tool-label')?.textContent === 'Colour by'
  );
  const sel = field.querySelector('select');
  sel.value = 'group';
  sel.dispatchEvent(new Event('change'));
});
await wait(1500);

// ------------------------------------------------------------------- help
console.log('\n# the help dialog');
await page.click('#help-toggle');
await wait(400);
const help = await page.evaluate(() => ({
  open: document.getElementById('help-dialog')?.style.display,
  text: document.getElementById('help-body')?.textContent.replace(/\s+/g, ' ') || '',
  author: document.querySelector('.help-author')?.textContent.replace(/\s+/g, ' ').trim() || '',
}));
check('the help dialog opens', help.open === 'flex', String(help.open));
check('the help explains the data location', /project directory|uploads/.test(help.text), help.text.slice(0, 90));
check('the help mentions the author', /zglu/.test(help.author), help.author);
await page.evaluate(() => document.getElementById('help-close').click());
await wait(200);

// ----------------------------------------------------------------- export
console.log('\n# export');
const exported = await page.evaluate(async () => {
  const card = document.querySelector('.dset-card');
  const btn = card.querySelector('.export-btn');
  if (!btn) return { ok: false, reason: 'no button' };
  let captured = null;
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (blob) => {
    captured = blob;
    return 'blob:fake';
  };
  btn.click();
  await new Promise((r) => setTimeout(r, 2500));
  URL.createObjectURL = origCreate;
  if (!captured) return { ok: false, reason: 'no blob' };
  const head = new Uint8Array(await captured.slice(0, 8).arrayBuffer());
  return { ok: true, size: captured.size, magic: Array.from(head) };
});
check('the PNG export produces a file', exported.ok, JSON.stringify(exported));
check('the exported file is a PNG', exported.magic && exported.magic[0] === 0x89 && exported.magic[1] === 0x50, JSON.stringify(exported.magic));

// ------------------------------------------------------------------ theme
console.log('\n# theme');
await page.click('#theme-toggle');
await wait(900);
const theme = await page.evaluate(() => ({
  theme: document.documentElement.dataset.theme,
  painted: (() => {
    const gl = document.querySelector('.oe-gl');
    const ctx = gl.getContext('webgl2');
    const px = new Uint8Array(4 * 400);
    ctx.readPixels(gl.width / 2 - 10, gl.height / 2 - 10, 20, 20, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 0) n++;
    return n;
  })(),
}));
check('the theme switches', theme.theme === 'light' || theme.theme === 'dark', theme.theme);
check('the plot is repainted after the theme change', theme.painted > 50, `${theme.painted}`);

await page.screenshot({ path: path.join(OUT, 'e2e.png'), fullPage: false });

// ----------------------------------------------------------------- report
console.log('\n# errors');
check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
check('no missing resources', missing.length === 0, missing.slice(0, 5).join(' | '));

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) failures.forEach((f) => console.log('  - ' + f));
await browser.close();
process.exit(failed ? 1 : 0);
