// Smoke test: load the app in a headless browser, collect console errors and
// take a screenshot.
//
//   node tests/smoke.mjs [url]
//
// Uses the puppeteer installation of the sibling nematode-atlas project when
// it is available, so no download is needed.

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

const CANDIDATES = [
  '/home/ubuntu/zglu_Data/WebProjects/NematodeAtlas_Data-Dev',
  process.cwd(),
];

let puppeteer = null;
for (const base of CANDIDATES) {
  try {
    puppeteer = require(require.resolve('puppeteer', { paths: [base] }));
    console.log('using puppeteer from', base);
    break;
  } catch (err) {
    /* try the next one */
  }
}
if (!puppeteer) {
  console.error('puppeteer not found - install it with `npm i puppeteer`');
  process.exit(2);
}

const URL_ = process.argv[2] || 'http://127.0.0.1:8099/';
const OUT = process.argv[3] || '/tmp/opencode/oe_shots';
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1100, deviceScaleFactor: 1 });

const errors = [];
const logs = [];
page.on('console', (msg) => {
  const text = `${msg.type()}: ${msg.text()}`;
  logs.push(text);
  if (msg.type() === 'error') errors.push(text);
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
page.on('requestfailed', (req) => {
  // Chrome reports HEAD requests as ERR_ABORTED - that is a known artifact
  // and not an actual failure.
  const aborted = req.failure()?.errorText === 'net::ERR_ABORTED';
  if (req.method() === 'HEAD' && aborted) return;
  errors.push(`requestfailed: ${req.method()} ${req.url()} ${req.failure()?.errorText}`);
});

await page.goto(URL_, { waitUntil: 'networkidle2', timeout: 90000 });
await new Promise((r) => setTimeout(r, 2500));

const stats = await page.evaluate(() => {
  const cards = document.querySelectorAll('.dset-card');
  const gl = document.querySelector('.oe-gl');
  let painted = null;
  if (gl) {
    const ctx = gl.getContext('webgl2');
    painted = !!ctx;
  }
  return {
    title: document.title,
    cards: cards.length,
    legends: document.querySelectorAll('.legend').length,
    chips: document.querySelectorAll('.legend .chip').length,
    hasWebGL: painted,
    compareCanvas: !!document.querySelector('.heatmap-canvas'),
    busy: document.getElementById('busy')?.textContent || '',
  };
});

console.log('stats:', JSON.stringify(stats, null, 2));
await page.screenshot({ path: path.join(OUT, 'overview.png'), fullPage: false });

// gene query
await page.type('#gene-input', 'CRM22_000001');
await new Promise((r) => setTimeout(r, 400));
await page.click('#gene-go');
await new Promise((r) => setTimeout(r, 2500));
const geneStats = await page.evaluate(() => ({
  chips: document.querySelectorAll('.gene-chip').length,
  geneBar: Array.from(document.querySelectorAll('.dset-card .gene-bar')).filter((b) => b.style.display !== 'none').length,
  dotplot: !!document.querySelector('.dset-card details.gene-dot'),
  tabs: document.querySelectorAll('#dataset-tabs .tab').length,
}));
console.log('gene:', JSON.stringify(geneStats));
await page.screenshot({ path: path.join(OUT, 'gene.png'), fullPage: false });

if (errors.length) {
  console.error('\nERRORS:');
  errors.forEach((e) => console.error('  ' + e));
} else {
  console.log('\nno console errors');
}
await browser.close();
process.exit(errors.length ? 1 : 0);
