// End to end test for the browser only mode (no server).
//
//   node tests/e2e_local.mjs
//
// The app is served as a plain static site, so there is no /api/project:
// the browser reads the .h5ad with h5wasm, builds the bundle itself and
// keeps it in IndexedDB.

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const CANDIDATES = [process.env.PUPPETEER_PATH || '', process.cwd()].filter(Boolean);

let puppeteer = null;
for (const base of CANDIDATES) {
  try {
    puppeteer = require(require.resolve('puppeteer', { paths: [base] }));
    break;
  } catch (err) { /* next */ }
}
if (!puppeteer) {
  console.error('puppeteer not found - install it with `npm i puppeteer`');
  process.exit(2);
}

const ROOT = process.cwd();
const PORT = Number(process.env.OE_LOCAL_PORT || 8098);
const URL_ = `http://127.0.0.1:${PORT}/`;
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'tiny.h5ad');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : ' - ' + detail}`);
  ok ? passed++ : failed++;
};

// ------------------------------------------------------------------- server
const site = mkdtempSync(path.join(tmpdir(), 'oe_local_'));
cpSync(path.join(ROOT, 'web'), site, { recursive: true });
mkdirSync(path.join(site, 'data'), { recursive: true });
writeFileSync(path.join(site, 'data', 'project.json'), JSON.stringify({ name: 'Local', panels: [] }));

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', site], {
  stdio: ['ignore', 'ignore', 'ignore'],
});
for (let i = 0; i < 60; i++) {
  await wait(300);
  try {
    const r = await fetch(URL_);
    if (r.ok) break;
  } catch (err) { /* not yet */ }
}

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  protocolTimeout: 600000,
});
const page = await browser.newPage();
// the delete button asks for a confirmation
page.on('dialog', async (d) => { await d.accept(); });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 160)));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text().slice(0, 160));
});
await page.setViewport({ width: 1400, height: 900 });

console.log('\n# the browser only mode');
await page.goto(URL_, { waitUntil: 'networkidle2', timeout: 60000 });
await wait(2500);
let s = await page.evaluate(() => ({
  local: window.__OMICSEXPLORER_LOCAL__ === true,
  tabs: document.querySelectorAll('#dataset-tabs .tab').length,
}));
check('the app runs without a server', s.local === true, JSON.stringify(s));
check('there is no dataset yet', s.tabs === 1, `${s.tabs} tabs`);

console.log('\n# the dialog of the browser mode');
await page.click('#add-data');
await wait(300);
s = await page.evaluate(() => ({
  accept: document.getElementById('upload-input')?.getAttribute('accept'),
  zone: document.getElementById('drop-zone')?.textContent.replace(/\s+/g, ' ') || '',
  pathTab: getComputedStyle(document.querySelector('.add-tabs button[data-pane="path"]')).display,
}));
check('only .h5ad files are offered', s.accept === '.h5ad', String(s.accept));
check('the dialog says the file stays local', /in your browser/.test(s.zone), s.zone.slice(0, 80));
check('the server path pane is hidden', s.pathTab === 'none', s.pathTab);

console.log('\n# the help dialog');
await page.evaluate(() => document.getElementById('add-close').click());
await page.click('#help-toggle');
await wait(400);
s = await page.evaluate(() => ({
  open: document.getElementById('help-dialog')?.style.display,
  text: document.getElementById('help-body')?.textContent.replace(/\s+/g, ' ') || '',
  author: document.querySelector('.help-author')?.textContent.replace(/\s+/g, ' ').trim() || '',
}));
check('the help dialog opens', s.open === 'flex', String(s.open));
check('the help explains where the data lives', /storage of this browser/.test(s.text), s.text.slice(0, 80));
check('the help mentions the author', /zglu/.test(s.author), s.author);
await page.evaluate(() => document.getElementById('help-close').click());

console.log('\n# adding a dataset in the browser');
await page.click('#add-data');
await wait(300);
const input = await page.$('#upload-input');
await input.uploadFile(FIXTURE);
await page.waitForSelector('#add-info input[type="checkbox"]', { timeout: 120000 });
s = await page.evaluate(() => ({
  file: document.querySelector('#add-info .file-name')?.textContent,
  groups: Array.from(document.querySelectorAll('#add-info .add-groups label')).map((l) => l.textContent.trim()),
  embs: document.querySelectorAll('#add-info .add-embeddings input').length,
}));
check('the file is read in the browser', s.file === 'tiny.h5ad', String(s.file));
check('the groupings are detected', s.groups.length >= 1, JSON.stringify(s.groups));
check('the embeddings are detected', s.embs >= 1, `${s.embs}`);

await page.evaluate(() => {
  Array.from(document.querySelectorAll('#add-info .add-actions button'))
    .find((b) => /Convert & add/.test(b.textContent))
    .click();
});
await page.waitForFunction(() => document.querySelectorAll('.dset-card').length > 0, { timeout: 300000, polling: 500 });
s = await page.evaluate(() => ({
  cards: document.querySelectorAll('.dset-card').length,
  name: document.querySelector('.dset-card .dset-name')?.textContent,
  legend: document.querySelectorAll('.dset-card .legend .chip').length,
  points: (() => {
    // the WebGL buffer is cleared once the frame is composited, so we look at
    // the overlay canvas: it holds the category labels, which are placed with
    // the coordinates - so it is only drawn when the plot has data
    const top = document.querySelector('.dset-card .oe-top');
    if (!top) return -1;
    const ctx = top.getContext('2d');
    const data = ctx.getImageData(0, 0, top.width, top.height).data;
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
    return n;
  })(),
}));
check('the dataset becomes a card', s.cards === 1, `${s.cards}`);
check('the card shows the categories', s.legend >= 2, `${s.legend}`);
check('the plot is drawn', s.points > 50, `${s.points} pixels`);

console.log('\n# the gene query in the local mode');
await page.type('#gene-input', 'GENE_005');
await page.keyboard.press('Enter');
await wait(3000);
s = await page.evaluate(() => ({
  chips: document.querySelectorAll('#gene-chips .gene-chip').length,
  geneMode: document.querySelectorAll('.dset-card.gene-mode').length,
  bar: Array.from(document.querySelectorAll('.dset-card .gene-bar')).some((b) => b.textContent.includes('GENE_005')),
}));
check('the gene is found', s.chips === 1, `${s.chips}`);
check('the card is coloured by the gene', s.geneMode === 1, `${s.geneMode}`);
check('the colour bar shows the gene', s.bar === true, String(s.bar));

await page.evaluate(() => { document.querySelector('.dset-card details').open = true; });
await wait(2500);
s = await page.evaluate(() => {
  const g = document.querySelector('.card-foot-body .gp');
  return g ? { rows: g.querySelectorAll('.gp-row').length - 1, dots: g.querySelectorAll('.gp-dot').length } : null;
});
check('the dotplot is built from the local blob', s && s.rows >= 2 && s.dots >= 1, JSON.stringify(s));

// the values of the blob have to land on the right cells (the encoding is
// shared with the python side, a mismatch shifts every value by one cell)
const values = await page.evaluate(async () => {
  const mod = await import('./src/core/data.js');
  const { listFiles } = await import('./src/core/localfs.js');
  const files = await listFiles('data/');
  const dir = files.find((f) => /\/index\.json$/.test(f) && !f.endsWith('project.json'));
  const id = dir.replace('data/', '').replace('/index.json', '');
  const ds = await mod.loadDataset(id);
  const expr = await mod.loadGeneExpr(ds, 'GENE_005');
  const codes = ds.codes.get('cell_type');
  const cats = ds.categories['cell_type'];
  const groups = {};
  for (let i = 0; i < ds.n; i++) {
    const c = codes[i];
    const cat = c >= 0 ? cats[c] : 'unknown';
    groups[cat] = groups[cat] || { sum: 0, n: 0 };
    groups[cat].sum += expr.values[i] || 0;
    groups[cat].n += 1;
  }
  return {
    nnz: expr.nnz,
    max: expr.max,
    means: Object.fromEntries(
      Object.entries(groups).map(([k, g]) => [k, +(g.sum / g.n).toFixed(2)])
    ),
  };
});
// the reference values (computed with anndata from tests/fixtures/tiny.h5ad)
//   A 2.07 · B 1.76 · C 1.88 · max 4.0 · 89 expressing cells
check('the expression lands on the right cells', values.nnz === 89 && Math.abs(values.max - 4) < 0.05, JSON.stringify(values));
check(
  'the category means are correct',
  Math.abs(values.means.A - 2.07) < 0.02 &&
    Math.abs(values.means.B - 1.76) < 0.02 &&
    Math.abs(values.means.C - 1.88) < 0.02,
  JSON.stringify(values.means)
);

console.log('\n# the data survives a reload');
await page.reload({ waitUntil: 'networkidle2' });
await wait(3000);
s = await page.evaluate(() => ({
  cards: document.querySelectorAll('.dset-card').length,
  name: document.querySelector('.dset-card .dset-name')?.textContent,
}));
check('the dataset is still there', s.cards === 1, JSON.stringify(s));

console.log('\n# deleting a dataset');
await page.evaluate(() => document.querySelectorAll('#dataset-tabs .tab-del')[0].click());
await wait(2500);
s = await page.evaluate(async () => {
  const { listFiles, getJSON } = await import('./src/core/localfs.js');
  return {
    cards: document.querySelectorAll('.dset-card').length,
    tabs: document.querySelectorAll('#dataset-tabs .tab').length,
    files: await listFiles('data/tiny/'),
    panels: (await getJSON('data/project.json'))?.panels || [],
  };
});
check('the dataset is gone', s.cards === 0 && s.tabs === 1, JSON.stringify({ cards: s.cards, tabs: s.tabs }));
check('its files are deleted from the browser', s.files.length === 0, JSON.stringify(s.files));
check('the project does not list it any more', s.panels.length === 0, JSON.stringify(s.panels));

console.log('\n# errors');
check('no console errors', errors.length === 0, errors.slice(0, 3).join(' ; '));

await browser.close();
server.kill();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
