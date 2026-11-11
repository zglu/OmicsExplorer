// Build a web bundle from an .h5ad file, in the browser.
//
// The result is the same set of files the python builder produces (index.json,
// X.bin + X.index.json, the obs/obsm columns and genes.json), so the rest of
// the app does not care whether the data came from a server or from here.
//
// The obs/obsm columns are stored as small binary files (.bin) instead of
// parquet - the local reader knows the difference.

import { readH5ad } from './h5ad.js';
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
  values.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
  return [...counts.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
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
  const { data, indices, indptr: srcPtr, encoding } = X;
  const outIdx = [];
  const outVal = [];
  const outPtr = new Int32Array(nGenes + 1);
  if (encoding === 'csr_matrix') {
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
export async function buildDatasetFromH5ad(file, opts = {}) {
  const h5ad = await readH5ad(file);
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

  // --- obsm ------------------------------------------------------------
  for (const [name, arr] of Object.entries(h5ad.obsm)) {
    if (!content.embeddings.includes(name)) continue;
    await putFile(`${dir}/obsm/${name}.bin`, Float32Array.from(arr.values).buffer);
  }

  // --- index.json ------------------------------------------------------
  const indexPayload = {
    id,
    name: opts.name || id,
    species: opts.species || '',
    kind: 'umap',
    description: `Added in the browser from ${opts.filename || 'a h5ad file'}`,
    count: h5ad.nCells,
    features: h5ad.genes,
    features_count: h5ad.genes.length,
    embeddings: content.embeddings.map((name) => ({
      name,
      label: name,
      kind: 'umap',
      columns: [`${name}_1`, `${name}_2`],
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
