// Build a web bundle from an .h5ad file, in the browser.
//
// The result is the same set of files the python builder produces (index.json,
// X.bin + X.index.json, the obs/obsm columns and genes.json), so the rest of
// the app does not care whether the data came from a server or from here.
//
// The obs/obsm columns are stored as small binary files (.bin) instead of
// parquet - the local reader knows the difference.

import { loadH5, readH5ad } from './h5ad.js';
import { buildExpressionBlob } from './blobwriter.js';
import { getJSON, putFile, putJSON } from './localfs.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Encode a string column (one JSON array). */
function encodeStrings(values) {
  return textEncoder.encode(JSON.stringify(values));
}

/** Encode a numeric column. */
function encodeNumbers(values) {
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Number(values[i]) || 0;
  return out.buffer;
}

/** The categories of a grouping (sorted like the python side does). */
function categoriesOf(values) {
  const counts = new Map();
  values.forEach((v) => {
    const key = String(v);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return [...counts.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * The distance to the nearest neighbour (median) - the grid pitch.
 * The median difference of the sorted coordinates does not work for the
 * hexagonal Visium layout, where every row is offset by half a pitch.
 */
export function estimatePitch(xy) {
  const n = xy.length / 2;
  if (n < 2) return 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = xy[i * 2], y = xy[i * 2 + 1];
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  const cell = Math.max(1e-6, Math.max(x1 - x0, y1 - y0) / Math.sqrt(n));
  const cols = Math.max(1, Math.ceil((x1 - x0) / cell) + 1);
  const rows = Math.max(1, Math.ceil((y1 - y0) / cell) + 1);
  const buckets = new Map();
  for (let i = 0; i < n; i++) {
    const bx = Math.floor((xy[i * 2] - x0) / cell);
    const by = Math.floor((xy[i * 2 + 1] - y0) / cell);
    const key = by * cols + bx;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(i);
  }
  const dists = [];
  for (let i = 0; i < n; i++) {
    const bx = Math.floor((xy[i * 2] - x0) / cell);
    const by = Math.floor((xy[i * 2 + 1] - y0) / cell);
    let best = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = buckets.get((by + dy) * cols + (bx + dx));
        if (!list) continue;
        for (const j of list) {
          if (j === i) continue;
          const ddx = xy[i * 2] - xy[j * 2];
          const ddy = xy[i * 2 + 1] - xy[j * 2 + 1];
          const d = ddx * ddx + ddy * ddy;
          if (d < best) best = d;
        }
      }
    }
    if (best < Infinity) dists.push(Math.sqrt(best));
  }
  if (!dists.length) return 0;
  dists.sort((a, b) => a - b);
  return dists[Math.floor(dists.length / 2)];
}

/**
 * The geometry of a coordinate array: does the data sit on a regular grid
 * (one cell per grid position -> drawn as tiles) or not (cells at arbitrary
 * positions -> drawn as dots)?  Mirrors python's ``converter._grid_info``.
 */
export function gridInfoOf(xy) {
  const n = xy.length / 2;
  if (n < 2) return { is_grid: false };
  const xs = new Set();
  const ys = new Set();
  for (let i = 0; i < n; i++) {
    xs.add(xy[i * 2]);
    ys.add(xy[i * 2 + 1]);
  }
  // a lattice has far fewer distinct x (and y) values than cells
  const coarse = xs.size <= Math.max(2, n / 4) && ys.size <= Math.max(2, n / 4);
  return { is_grid: coarse };
}

/**
 * The geometry of a spatial embedding: the grid pitch, the size of one spot
 * and how many microns one data unit is.  Everything is converted to microns.
 */
export function analyseSpatial(xy, scalefactors, imageShape, fullresShape, visiumPitchUm = 100) {
  const n = xy.length / 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = xy[i * 2], y = xy[i * 2 + 1];
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  const fits = (shape) => {
    if (!shape || !shape[0] || !shape[1]) return false;
    return x0 >= -1 && y0 >= -1 && x1 <= shape[1] + 1 && y1 <= shape[0] + 1;
  };
  const spotFullres = Number(scalefactors?.spot_diameter_fullres || 0);
  const hiresScalef = Number(scalefactors?.tissue_hires_scalef || 0);
  const pitch = estimatePitch(xy);
  let space = 'um';
  if (fits(imageShape)) space = 'hires_px';
  else if (fits(fullresShape)) space = 'fullres_px';
  const umPerData = space !== 'um' && pitch > 0 ? visiumPitchUm / pitch : 1;
  let sizeUm = space === 'fullres_px' ? spotFullres * umPerData
    : space === 'hires_px' ? spotFullres * hiresScalef * umPerData
      : 0;
  // the spot diameter in the file is an estimate - never let the spots
  // touch: they keep at most 60% of the grid pitch
  if (sizeUm > 0 && pitch > 0) sizeUm = Math.min(sizeUm, 0.6 * pitch * umPerData);
  return { pitch, space, umPerData, size: sizeUm };
}

/** Pick the groupings and the embeddings to use. */
export function detectContent(h5ad, groups = null, embeddings = null) {
  const groupNames = [];
  const categories = {};
  for (const [name, col] of Object.entries(h5ad.obs)) {
    if (col.type === 'number') continue;
    const unique = new Set(col.values.filter((v) => v !== '')).size;
    if (unique < 2 || unique > Math.max(64, Math.floor(h5ad.nCells / 2))) continue;
    groupNames.push(name);
    categories[name] = categoriesOf(col.values);
  }
  const embNames = Object.keys(h5ad.obsm).filter((k) => {
    const shape = h5ad.obsm[k].shape || [];
    return shape.length === 2 && shape[0] === h5ad.nCells && shape[1] >= 2;
  });
  return {
    groups: groups || groupNames,
    embeddings: embeddings || embNames,
    categories,
  };
}

/**
 * Turn the h5ad matrix into the gene major layout the blob writer wants.
 * anndata stores X as cells x genes (CSR or CSC); the blob is gene major.
 */
function matrixToGeneMajor(X, nCells) {
  const nGenes = X.nGenes;
  const cellIndices = [];
  const values = [];
  const indptr = new Int32Array(nGenes + 1);
  if (X.dense) {
    // dense: cells x genes -> gene major
    const data = X.values;
    for (let g = 0; g < nGenes; g++) {
      indptr[g] = cellIndices.length;
      for (let c = 0; c < nCells; c++) {
        const v = data[c * nGenes + g];
        if (v) {
          cellIndices.push(c);
          values.push(v);
        }
      }
    }
    indptr[nGenes] = cellIndices.length;
    return { cellIndices: Int32Array.from(cellIndices), values: Float32Array.from(values), indptr };
  }
  // sparse
  const { data, indices, indptr: srcPtr } = X;
  const outIdx = [];
  const outVal = [];
  const outPtr = new Int32Array(nGenes + 1);
  // the encoding says how the matrix is stored; when it is missing the length
  // of indptr does (nGenes + 1 -> gene major, nCells + 1 -> cell major)
  const geneMajor = X.encoding
    ? String(X.encoding).startsWith('csc')
    : srcPtr.length === nGenes + 1;
  if (!geneMajor) {
    // csr: rows are cells, columns are genes -> transpose
    const counts = new Int32Array(nGenes);
    for (let k = 0; k < indices.length; k++) counts[indices[k]]++;
    const starts = new Int32Array(nGenes + 1);
    for (let g = 0; g < nGenes; g++) starts[g + 1] = starts[g] + counts[g];
    const cursor = starts.slice(0, nGenes);
    for (let c = 0; c < nCells; c++) {
      const a = srcPtr[c];
      const b = srcPtr[c + 1];
      for (let k = a; k < b; k++) {
        const g = indices[k];
        const p = cursor[g]++;
        outIdx[p] = c;
        outVal[p] = data[k];
      }
    }
    for (let g = 0; g < nGenes; g++) outPtr[g] = starts[g];
    outPtr[nGenes] = outIdx.length;
    return { cellIndices: Int32Array.from(outIdx), values: Float32Array.from(outVal), indptr: outPtr };
  }
  // csc: columns are genes -> already gene major
  for (let g = 0; g < nGenes; g++) {
    outPtr[g] = outIdx.length;
    const a = srcPtr[g];
    const b = srcPtr[g + 1];
    for (let k = a; k < b; k++) {
      outIdx.push(indices[k]);
      outVal.push(data[k]);
    }
  }
  outPtr[nGenes] = outIdx.length;
  return { cellIndices: Int32Array.from(outIdx), values: Float32Array.from(outVal), indptr: outPtr };
}

/**
 * Build a dataset from an .h5ad file and store it in the local project.
 *
 * @param {File|ArrayBuffer} file
 * @param {object} opts  {id, name, groups, embeddings}
 */
/** The spatial metadata of an h5ad: scalefactors and the image sizes. */
async function readSpatialMeta(file) {
  try {
    const lib = await loadH5();
    const buffer = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
    const name = 'meta.h5ad';
    lib.FS.writeFile(name, new Uint8Array(buffer));
    let h5file;
    try {
      h5file = new lib.File(name, 'r');
      const uns = h5file.get('uns');
      if (!uns) return null;
      const spatial = uns.get('spatial');
      if (!spatial) return null;
      for (const sample of spatial.keys()) {
        if (sample.startsWith('_')) continue;
        const group = spatial.get(sample);
        if (!group || !group.get) continue;
        const scalefactors = {};
        const sf = group.get('scalefactors');
        if (sf) {
          for (const key of sf.keys()) {
            const v = sf.get(key);
            const value = v && v.json_value !== undefined ? v.json_value : v?.value;
            scalefactors[key] = Number(Array.isArray(value) ? value[0] : value);
          }
        }
        const shapeOf = (imgName) => {
          const node = group.get('images')?.get(imgName);
          return node && node.shape ? [Number(node.shape[0]), Number(node.shape[1])] : [0, 0];
        };
        return {
          sample,
          scalefactors,
          hiresShape: shapeOf('hires'),
          fullresShape: shapeOf('fullres'),
        };
      }
      return null;
    } finally {
      try { h5file?.close(); } catch (err) { /* ignore */ }
      try { lib.FS.unlink(name); } catch (err) { /* ignore */ }
    }
  } catch (err) {
    console.warn('could not read the spatial metadata', err);
    return null;
  }
}

export async function buildDatasetFromH5ad(file, opts = {}) {
  const h5ad = await readH5ad(file);
  const spatialMeta = await readSpatialMeta(file);
  const content = detectContent(h5ad, opts.groups, opts.embeddings);
  const id = opts.id || slug(opts.name || 'dataset');
  const dir = `data/${id}`;

  // --- expression blob ------------------------------------------------
  const { cellIndices, values, indptr } = matrixToGeneMajor(h5ad.X, h5ad.nCells);
  const { blob, index } = await buildExpressionBlob(
    h5ad.genes, cellIndices, values, indptr, h5ad.nCells
  );
  await putFile(`${dir}/X.bin`, await blob.arrayBuffer());
  await putJSON(`${dir}/X.index.json`, index);

  // --- obs (groupings and metrics) ------------------------------------
  const metrics = [];
  for (const [name, col] of Object.entries(h5ad.obs)) {
    if (!content.groups.includes(name) && col.type !== 'number') continue;
    if (col.type === 'number') {
      const values = col.values.map((v) => Number(v) || 0);
      let lo = Infinity;
      let hi = -Infinity;
      let sum = 0;
      values.forEach((v) => {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        sum += v;
      });
      if (!Number.isFinite(lo)) {
        lo = 0;
        hi = 0;
      }
      await putFile(`${dir}/obs/${name}.bin`, encodeNumbers(values));
      metrics.push({ name, min: lo, max: hi, mean: sum / (values.length || 1) });
    } else {
      await putFile(`${dir}/obs/${name}.bin`, encodeStrings(col.values));
    }
  }

  // --- the geometry of the spatial embedding (microns) -------------------
  const grids = {};
  if (spatialMeta && h5ad.obsm) {
    for (const [name, arr] of Object.entries(h5ad.obsm)) {
      // only the spatial embedding is in image pixels - the others (pca, ...)
      // must never be scaled to microns
      if (name !== 'spatial') continue;
      const info = analyseSpatial(arr.values, spatialMeta.scalefactors, spatialMeta.hiresShape, spatialMeta.fullresShape);
      if (!info.pitch) continue;
      // the coordinates are converted to microns
      const xy = arr.values;
      for (let i = 0; i < xy.length; i++) xy[i] *= info.umPerData;
      const grid = gridInfoOf(xy);
      const gridEntry = {
        pitch: info.pitch * info.umPerData,
        is_grid: grid.is_grid,
        size: info.size,
        space: info.space,
      };
      // spots with a gap (Visium) are round, contiguous bins are square
      if (info.size) {
        gridEntry.shape = info.size < info.pitch * info.umPerData * 0.95 ? 'circle' : 'square';
      }
      grids[name] = gridEntry;
    }
  }

  // --- obsm ------------------------------------------------------------
  // written *after* the geometry block above: it converts the spatial
  // coordinates to microns so that the scale bar, the spot size and a
  // potential image transform match the stored coordinates
  for (const [name, arr] of Object.entries(h5ad.obsm)) {
    if (!content.embeddings.includes(name)) continue;
    await putFile(`${dir}/obsm/${name}.bin`, Float32Array.from(arr.values).buffer);
  }

  // --- index.json ------------------------------------------------------
  const indexPayload = {
    id,
    name: opts.name || id,
    grids,
    species: opts.species || '',
    kind: 'umap',
    description: `Added in the browser from ${opts.filename || 'a h5ad file'}`,
    count: h5ad.nCells,
    features: h5ad.genes,
    features_count: h5ad.genes.length,
    embeddings: content.embeddings.map((name) => ({
      name,
      label: name,
      kind: name === 'spatial' ? 'spatial' : 'umap',
      columns: [`${name}_1`, `${name}_2`],
      grid: grids[name] || undefined,
    })),
    obs: content.groups,
    categories: Object.fromEntries(content.groups.map((g) => [g, content.categories[g] || []])),
    metrics,
    samples: [],
    images: [],
    units: null,
    bin_size: null,
    default_group: content.groups[0] || null,
    default_embedding: content.embeddings[0] || null,
    scale: index.scale,
    codec: 'gz-uint16',
    local: true,
  };
  await putJSON(`${dir}/index.json`, indexPayload);

  // --- the project + the gene index ------------------------------------
  const project = (await getJSON('data/project.json')) || {
    name: 'OmicsExplorer',
    subtitle: 'runs entirely in your browser',
    data_dir: 'data',
    species: {},
    ontology: { cell_types: {} },
    panels: [],
  };
  project.panels = (project.panels || []).filter((p) => p.id !== id);
  project.panels.push({
    id,
    name: indexPayload.name,
    species: indexPayload.species,
    kind: indexPayload.kind,
    description: indexPayload.description,
    dir: `data/${id}`,
    n_cells: indexPayload.count,
    n_features: indexPayload.features_count,
    groups: Object.fromEntries(content.groups.map((g) => [g, { column: g, label: g }])),
    default_group: indexPayload.default_group,
    embeddings: Object.fromEntries(
      content.embeddings.map((e) => [e, { obsm: e, kind: 'umap', label: e }])
    ),
    images: [],
    samples: [],
    units: null,
    bin_size: null,
  });
  await putJSON('data/project.json', project);

  const genes = (await getJSON('data/genes.json')) || { genes: {} };
  h5ad.genes.forEach((gene) => {
    const entry = genes.genes[gene] || { panels: [] };
    if (!entry.panels.includes(id)) entry.panels.push(id);
    genes.genes[gene] = entry;
  });
  await putJSON('data/genes.json', genes);

  return { id, index: indexPayload, project };
}

function slug(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'dataset';
}

export { textDecoder };
