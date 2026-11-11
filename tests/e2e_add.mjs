// End to end test for the runtime "add dataset" flow (the ＋ Data dialog).
//
//   .venv/bin/python tests/make_add_fixture.py /tmp/opencode/oe_addprobe
//   node tests/e2e_add.mjs [url]
//
// With no url it launches its own server for /tmp/opencode/oe_addprobe.

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

const ROOT = process.cwd();
const FIXTURE = process.env.OE_FIXTURE || '/tmp/opencode/oe_addprobe';
const PATCH = `${FIXTURE}/patch.h5ad`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const isUrlOnly = () => Boolean(process.argv[2]);

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

// ------------------------------------------------------------- start server
let server = null;
let URL_ = process.argv[2] || '';
if (!URL_) {  const py = process.env.OE_PY || `${ROOT}/.venv/bin/python3`;
  URL_ = 'http://127.0.0.1:8097/';
  server = spawn(py, ['-m', 'omicexplorer.cli', 'serve', '-p', `${FIXTURE}/project.yaml`, '--no-build', '--port', '8097'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = await (async () => {
    server.stderr.on('data', (chunk) => {
      if (String(chunk).startsWith('fatal')) process.stderr.write(chunk);
    });
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(URL_ + 'api/project');
        if (r.ok) return true;
      } catch (err) {
        /* not up yet */
      }
      await wait(500);
    }
    return false;
  })();
  if (!ready) {
    console.error('the fixture server did not start');
    if (server && server.exitCode === null) server.kill();
    process.exit(2);
  }
} else {
  URL_ = URL_.endsWith('/') ? URL_ : URL_ + '/';
}

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 1000 });

const errors = [];
const missing = [];
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('response', (res) => {
  if (res.status() >= 400) missing.push(`${res.status()} ${res.url()}`);
});

console.log('\n# the dialog itself');
await page.goto(URL_, { waitUntil: 'networkidle2', timeout: 60000 });
await wait(1500);
let s = await page.evaluate(() => ({ open: !!document.getElementById('add-dialog') }));
check('the dialog is in the page', s.open);

await page.click('#add-data');
await wait(400);
s = await page.evaluate(() => ({ visible: document.getElementById('add-dialog').style.display === 'flex' }));
check('the dialog opens', s.visible);

await page.evaluate(() => document.querySelector('.add-tabs button[data-pane="path"]').click());
await wait(200);
s = await page.evaluate(() => (document.getElementById('add-pane-path').style.display || '').trim());
check('the server path pane can be selected', s === '');

// ----------------------------------------------------------------- discover
console.log('\n# discovery');
await page.type('#path-input', PATCH);
await page.click('#path-scan');
await page.waitForSelector('#add-info input[type="checkbox"]', { timeout: 30000 });
s = await page.evaluate(() => ({
  name: document.querySelector('#add-info .file-name')?.textContent || '',
  groups: document.querySelectorAll('#add-info .add-groups input').length,
  embs: document.querySelectorAll('#add-info .add-embeddings input').length,
}));
check('the file is discovered', s.name === 'patch.h5ad', s.name);
check('the groupings are offered', s.groups === 2, `${s.groups}`);
check('the embeddings are offered', s.embs >= 2, `${s.embs}`);

// ---------------------------------------------------------------- addition
console.log('\n# convert & add');
const before = await page.evaluate(() => document.querySelectorAll('.dset-card').length);
await page.evaluate(() => {
  const buttons = Array.from(document.querySelectorAll('#add-info .add-actions button'));
  buttons.find((b) => /Convert & add/.test(b.textContent)).click();
});
try {
  await page.waitForFunction(() => document.querySelectorAll('.dset-card').length > 1, { timeout: 120000 });
} catch (err) {
  /* handled below */
}
await wait(1500);
s = await page.evaluate(() => ({
  cards: document.querySelectorAll('.dset-card').length,
  title: document.querySelector('.dset-card.focused .dset-name')?.textContent || '',
  chips: document.querySelectorAll('.dset-card.focused .legend .chip').length,
  tabs: Array.from(document.querySelectorAll('#dataset-tabs .tab .tab-name')).map((t) => t.textContent),
  dels: document.querySelectorAll('#dataset-tabs .tab-del').length,
}));
check('the new dataset card is added', s.cards === before + 1, `${s.cards} (was ${before})`);
check('the card focuses and names the dataset', /patch/i.test(s.title), s.title);
check('the card shows its legend', s.chips > 0, `${s.chips}`);
check('the dataset tabs contain the new card', s.tabs.includes('patch'), s.tabs.join(', '));
check('every dataset tab has a delete button', s.dels === s.tabs.length, `${s.dels} of ${s.tabs.length}`);

// gl painting of the new card
const painted = await page.evaluate(() => {
  const gl = document.querySelector('.dset-card.focused .oe-gl');
  if (!gl) return 0;
  const ctx = gl.getContext('webgl2');
  const px = new Uint8Array(4 * gl.width * gl.height);
  ctx.readPixels(0, 0, gl.width, gl.height, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
  let n = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n++;
  return n;
});
check('the new card paints cells', painted > 200, `${painted} pixels`);

// ------------------------------------------------------ persisted manifest
console.log('\n# persistence');
s = await page.evaluate(async () => {
  const r = await fetch('/api/project', { cache: 'no-store' });
  const p = await r.json();
  return p.panels.map((x) => x.id);
});
check('project.json contains the added dataset', s.length === before + 1, s.join(', '));

let autoOk = '';
if (!isUrlOnly()) {
  const { readFileSync } = await import('node:fs');
  try {
    autoOk = readFileSync(`${FIXTURE}/datasets.auto.yaml`, 'utf8');
  } catch (err) {
    autoOk = '';
  }
}
check('datasets.auto.yaml lists the new dataset', /id:\s*patch\b/.test(autoOk), autoOk.slice(0, 60));

// ------------------------------------------------------- other behaviours
console.log('\n# mode + group comparison');
const modeBefore = await page.evaluate(() => document.querySelectorAll('.dset-card.focused .dset-tools select')[2].value);
check('the mode defaults to pan', modeBefore === 'pan', modeBefore);
await page.evaluate(() => document.querySelector('.dset-card.focused').scrollIntoView({ block: 'center' }));
await wait(300);
const top = await page.evaluate(() => {
  const rect = document.querySelector('.dset-card.focused .oe-top').getBoundingClientRect();
  return { x: rect.left, y: rect.top };
});
await page.mouse.move(top.x + 60, top.y + 300);
await page.mouse.down();
await page.mouse.move(top.x + 300, top.y + 420, { steps: 8 });
await page.mouse.up();
await wait(600);
const modeAfter = await page.evaluate(() => document.querySelectorAll('.dset-card.focused .dset-tools select')[2].value);
check('the mode returns to pan after a brush', modeAfter === 'pan', `${modeBefore} -> ${modeAfter}`);

// the in-card gene dotplot (replaces the old group flows)
console.log('\n# the gene dotplot in the cards');
await page.evaluate(async () => {
  const q = async (gene) => {
    const input = document.getElementById('gene-input');
    input.value = gene;
    document.getElementById('gene-go').click();
  };
  await q('GENE_000');
});
await wait(2000);
await page.evaluate(() => {
  const details =
    document.querySelector('.dset-card.focused details') ||
    document.querySelector('.dset-card details');
  details.setAttribute('open', 'open');
});
await wait(2500);
const cmp = await page.evaluate(() => {
  const card = document.querySelector('.dset-card.focused') || document.querySelector('.dset-card');
  const details = card.querySelector('details.gene-dot');
  const grid = details?.querySelector('.gp');
  if (!grid) return null;
  return {
    rows: grid.querySelectorAll('.gp-row').length - 1,
    dots: grid.querySelectorAll('.gp-dot').length,
    cats: Array.from(grid.querySelectorAll('.gp-body .gp-cat')).length,
    legend: /color = mean expression/.test(grid.querySelector('.gp-legend')?.textContent || ''),
  };
});
check('the card gene dotplot renders', !!cmp, String(cmp));
check('the card gene dotplot lists categories', cmp && cmp.rows >= 3, `${cmp?.rows}`);
check('the card gene dotplot draws dots', cmp && cmp.dots >= 1, `${cmp?.dots}`);
check('the card gene dotplot has a legend', cmp && cmp.legend);

await page.screenshot({ path: `${tmpdir()}/oe_add_e2e.png` });

console.log('\n# errors');
check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
check('no missing resources', missing.length === 0, missing.slice(0, 5).join(' | '));

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) failures.forEach((f) => console.log('  - ' + f));

await browser.close();
if (server) server.kill();
process.exit(failed ? 1 : 0);

async function readTrial() {
  return '';
}
