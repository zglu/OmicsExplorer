// Data layer.
//
// Everything the app shows is read from the static bundle:
//
//   data/project.json          the datasets of the project
//   data/<dataset>/index.json  features, groups, embeddings, images
//   data/<dataset>/obs/*.parquet      one string column "value" per cell
//   data/<dataset>/obsm/*.parquet     two float32 columns "<emb>_1" / "<emb>_2"
//   data/<dataset>/X.bin + X.index.json   gene major expression blob
//
// The expression blob is read with a single HTTP range request per gene and
// inflated with the browser's native DecompressionStream.

import { parquetRead, asyncBufferFromUrl } from '../../vendor/hyparquet.js';

const BUILD = new URL(import.meta.url).searchParams.get('v') || '';

export function stamped(url) {
  if (!BUILD) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${BUILD}`;
}

export async function fetchJSON(url, { bust = false } = {}) {
  let full = stamped(url);
  if (bust) {
    full += `${full.includes('?') ? '&' : '?'}t=${Date.now()}`;
  }
  const r = await fetch(full);
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return r.json();
}

// ------------------------------------------------------------------ parquet

async function readParquetRaw(url, columns) {
  const file = await asyncBufferFromUrl({ url: stamped(url) });
  const rows = await new Promise((resolve, reject) => {
    parquetRead({ file, columns, rowFormat: 'array', onComplete: resolve }).catch(reject);
  });
  const out = {};
  columns.forEach((name, i) => {
    const values = new Array(rows.length);
    for (let r = 0; r < rows.length; r++) values[r] = rows[r][i];
    out[name] = values;
  });
  return { columns: out, n: rows.length };
}

/**
 * Read a parquet file into plain arrays.  Falls back to a full download when
 * the server does not honour range requests.
 */
export async function readParquet(url, columns) {
  try {
    return await readParquetRaw(url, columns);
  } catch (err) {
    console.warn('parquet range read failed, retrying with a full download', err);
    const bust = `${url}${url.includes('?') ? '&' : '?'}r=${Date.now()}`;
    const file = await asyncBufferFromUrl({ url: bust });
    const rows = await new Promise((resolve, reject) => {
      parquetRead({ file, columns, rowFormat: 'array', onComplete: resolve }).catch(reject);
    });
    const out = {};
    columns.forEach((name, i) => {
      const values = new Array(rows.length);
      for (let r = 0; r < rows.length; r++) values[r] = rows[r][i];
      out[name] = values;
    });
    return { columns: out, n: rows.length };
  }
}

// ------------------------------------------------------------------ project

export const state = {
  project: null,
  panels: new Map(),     // id -> dataset record
  panelOrder: [],
  species: [],
  ontology: {},
};

export async function loadProject(bust = false) {
  // the API knows about an empty project (nothing built yet); a static site
  // has no API at all - then the exported data/project.json is used
  let project = null;
  try {
    project = await fetchJSON('/api/project', { bust });
  } catch (err) {
    project = await fetchJSON('data/project.json', { bust });
  }
  state.project = project;
  // species may be a list or a mapping of id -> {name, color}
  state.species = Array.isArray(project.species)
    ? project.species
    : Object.entries(project.species || {}).map(([id, s]) => ({ id, ...(s || {}) }));
  state.ontology = (project.ontology && project.ontology.cell_types) || {};
  state.panelOrder = (project.panels || []).map((p) => p.id);
  return project;
}

export function panelSpec(id) {
  return (state.project?.panels || []).find((p) => p.id === id) || null;
}

export function speciesColor(id) {
  const sp = (state.species || []).find((s) => s.id === id);
  return (sp && sp.color) || '#888';
}

// ------------------------------------------------------------------ dataset

const panelPromises = new Map();

export function dataset(id) {
  return state.panels.get(id) || null;
}

/**
 * Load one dataset: its metadata, every requested grouping and every
 * embedding.  The promise is cached so switching views never re-downloads.
 */
export function loadDataset(id) {
  if (panelPromises.has(id)) return panelPromises.get(id);
  const promise = loadDatasetImpl(id);
  panelPromises.set(id, promise);
  return promise;
}

async function loadDatasetImpl(id) {
  const spec = panelSpec(id);
  if (!spec) throw new Error(`unknown dataset '${id}'`);
  const dir = spec.dir || `data/${id}`;
  const meta = await fetchJSON(`${dir}/index.json`);

  const ds = {
    id,
    spec,
    meta,
    dir,
    n: meta.count,
    categories: meta.categories || {},
    groupNames: meta.obs || Object.keys(meta.categories || {}),
    metrics: meta.metrics || [],
    metricCache: new Map(),
    localFormat: Boolean(meta.local),
    embeddings: meta.embeddings || [],
    images: meta.images || [],
    units: meta.units || null,
    binSize: meta.bin_size || null,
    codes: new Map(),
    coords: new Map(),
    featureIndex: new Map(),
    exprCache: new Map(),
    xIndex: null,
  };

  // --- groupings -----------------------------------------------------
  await Promise.all(
    ds.groupNames.map(async (group) => {
      const cats = ds.categories[group] || [];
      const lookup = new Map(cats.map((c, i) => [c, i]));
      try {
        const col = await readColumn(ds, 'obs', group, ['value']);
        const values = col ? col.values || (col.columns && col.columns.value) || [] : [];
        const codes = new Int32Array(values.length).fill(-1);
        for (let i = 0; i < values.length; i++) {
          const idx = lookup.get(values[i]);
          codes[i] = idx === undefined ? -1 : idx;
        }
        ds.codes.set(group, codes);
      } catch (err) {
        console.warn(`[${id}] could not read group '${group}'`, err);
      }
    })
  );

  // --- embeddings ----------------------------------------------------
  await Promise.all(
    ds.embeddings.map(async (emb) => {
      try {
        const col = await readColumn(ds, 'obsm', emb.name, emb.columns || [
          `${emb.name}_1`,
          `${emb.name}_2`,
        ]);
        let c1 = [];
        let c2 = [];
        if (col) {
          if (col.flat) {
            // the local format stores [x0, y0, x1, y1, ...]
            const flat = col.flat;
            c1 = new Float32Array(flat.length / 2);
            c2 = new Float32Array(flat.length / 2);
            for (let i = 0; i < c1.length; i++) {
              c1[i] = flat[i * 2];
              c2[i] = flat[i * 2 + 1];
            }
          } else if (col.columns) {
            c1 = col.columns[(emb.columns || [])[0]] || [];
            c2 = col.columns[(emb.columns || [])[1]] || [];
          }
        }
        const xy = new Float32Array(c1.length * 2);
        for (let i = 0; i < c1.length; i++) {
          xy[i * 2] = c1[i];
          xy[i * 2 + 1] = c2[i] ?? 0;
        }
        ds.coords.set(emb.name, xy);
      } catch (err) {
        console.warn(`[${id}] could not read embedding '${emb.name}'`, err);
      }
    })
  );

  // --- expression index ----------------------------------------------
  try {
    ds.xIndex = await fetchJSON(`${dir}/X.index.json`);
    for (const feature of meta.features || []) {
      ds.featureIndex.set(normaliseFeature(feature), feature);
    }
  } catch (err) {
    console.warn(`[${id}] no expression index`, err);
  }

  state.panels.set(id, ds);
  return ds;
}

/**
 * Read one obs / obsm column.  The local (browser built) datasets store the
 * columns as small binary files, the server bundles use parquet.
 */
async function readColumn(ds, kind, name, columns) {
  if (ds.localFormat) {
    // the browser build stores the columns as small binary files
    const res = await fetch(stamped(`${ds.dir}/${kind}/${name}.bin`));
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (kind === 'obsm') return { flat: new Float32Array(buf) };
    const text = new TextDecoder().decode(new Uint8Array(buf));
    if (text.startsWith('[')) return { values: JSON.parse(text) };
    return { values: Array.from(new Float64Array(buf)) };
  }
  const { columns: cols } = await readParquet(`${ds.dir}/${kind}/${name}.parquet`, columns);
  return { columns: cols };
}

/**
 * Load one quantitative metadata column (nCount_RNA, a signature score, ...).
 * Returns a dense Float32Array with one value per cell.
 */
export async function loadMetric(ds, name) {
  if (!ds) return null;
  if (ds.metricCache.has(name)) return ds.metricCache.get(name);
  const meta = ds.metrics.find((m) => m.name === name);
  if (!meta) return null;
  try {
    const col = await readColumn(ds, 'obs', name, ['value']);
    const values = col ? col.values || (col.columns && col.columns.value) || [] : [];
    const out = new Float32Array(ds.n);
    for (let i = 0; i < Math.min(values.length, ds.n); i++) out[i] = Number(values[i]);
    ds.metricCache.set(name, { values: out, ...meta });
    return ds.metricCache.get(name);
  } catch (err) {
    console.warn(`[${ds.id}] could not read metric '${name}'`, err);
    return null;
  }
}

export function normaliseFeature(name) {
  return String(name).toLowerCase().replace(/-/g, '_');
}

// -------------------------------------------------------------- expression

async function gunzip(buffer) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream is not supported by this browser');
  }
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Decode one gene block.
 * The layout is: varint deltas of the cell indices, then the high byte and
 * the low byte of the quantised value.
 */
function decodeGeneBlock(bytes, n) {
  const cells = new Int32Array(n);
  let p = 0;
  let prev = -1;
  for (let i = 0; i < n; i++) {
    let v = 0;
    let shift = 0;
    let b;
    do {
      b = bytes[p++];
      v |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    prev += v - 1;
    cells[i] = prev;
  }
  const hi = bytes.subarray(p, p + n);
  const lo = bytes.subarray(p + n, p + 2 * n);
  return { cells, hi, lo };
}

/**
 * Load the expression of one gene for one dataset.
 * Returns a dense Float32Array plus a few summary statistics.
 */
export async function loadGeneExpr(ds, geneId) {
  if (!ds) return null;
  if (ds.exprCache.has(geneId)) return ds.exprCache.get(geneId);
  if (!ds.xIndex || !ds.xIndex.genes) return null;
  const local = ds.featureIndex.get(normaliseFeature(geneId));
  if (!local) return null;
  const rec = ds.xIndex.genes[local];
  if (!rec) return null;

  const [offset, length, nEntries] = rec;
  const values = new Float32Array(ds.n);
  let nnz = 0;

  if (length > 0) {
    const url = `${ds.dir}/X.bin`;
    const range = `bytes=${offset}-${offset + length - 1}`;
    let raw = await fetchRange(url, range);
    // every gene block stored in X.bin is gzipped (see omicexplorer/blob.py)
    if (raw[0] === 0x1f && raw[1] === 0x8b) raw = await gunzip(raw);
    const { cells, hi, lo } = decodeGeneBlock(raw, nEntries);
    const scale = ds.xIndex.scale;
    for (let i = 0; i < nEntries; i++) {
      values[cells[i]] = ((hi[i] << 8) | lo[i]) * scale;
    }
    nnz = nEntries;
  }

  const stats = summarise(values);
  const result = { values, nnz, ...stats, gene: local };
  ds.exprCache.set(geneId, result);
  return result;
}

async function fetchRange(url, range) {
  let response = await fetch(stamped(url), { headers: { Range: range } });
  if (response.status === 206) {
    const buf = await response.arrayBuffer();
    return new Uint8Array(buf);
  }
  // The server ignored the range header: fall back to a full download and
  // slice locally.
  const full = new Uint8Array(await response.arrayBuffer());
  const m = range.match(/bytes=(\d+)-(\d+)/);
  if (!m) return full;
  const start = parseInt(m[1], 10);
  const end = parseInt(m[2], 10);
  return full.subarray(start, end + 1);
}

function summarise(values) {
  const nonZero = [];
  for (let i = 0; i < values.length; i++) if (values[i] > 0) nonZero.push(values[i]);
  nonZero.sort((a, b) => a - b);
  const pct = (q) => (nonZero.length ? nonZero[Math.min(nonZero.length - 1, Math.floor(q * nonZero.length))] : 0);
  return {
    max: nonZero.length ? nonZero[nonZero.length - 1] : 0,
    p80: pct(0.8),
    p85: pct(0.85),
    p90: pct(0.9),
    p95: pct(0.95),
    p99: pct(0.99),
    pctl: pct(0.99),
    expressing: nonZero.length,
  };
}
