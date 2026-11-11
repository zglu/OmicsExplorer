// Read an .h5ad file in the browser with h5wasm (HDF5 compiled to WebAssembly).
//
// The reader returns the same pieces the python side uses:
//
//   { nCells, nGenes, genes[], cells[], obs{}, obsm{} }
//
//   obs[name] = { type: 'category'|'number'|'string', values[], categories? }
//   obsm[name] = { data: Float32Array, n, dims }

let h5 = null;

/** Load the h5wasm module (4 MB, only fetched when a file is added). */
export async function loadH5() {
  if (h5) return h5;
  h5 = await import('../../vendor/h5wasm/hdf5_hl.js');
  await h5.ready;
  return h5;
}

function isNumeric(dtype) {
  // h5wasm reports e.g. '<f' (little endian float), '|i8', 'S' for strings
  const d = String(dtype || '').replace(/^[<>=|]/, '');
  return /^[iuf]/.test(d) && !d.startsWith('S');
}

/** BigInt arrays (h5wasm uses them for indices) become plain numbers. */
function toNumbers(values) {
  if (!values) return values;
  if (typeof values.length !== 'number') return values;
  if (typeof values[0] === 'bigint') {
    const out = new Int32Array(values.length);
    for (let i = 0; i < values.length; i++) out[i] = Number(values[i]);
    return out;
  }
  return values;
}

/**
 * The values of a dataset.  `json_value` decodes variable length strings,
 * `value` would give the raw bytes.
 */
function valuesOf(node) {
  if (!node) return null;
  if (node.json_value !== undefined) return node.json_value;
  return node.value;
}

/** Read one dataset of the h5ad into plain JS arrays. */
function readDataset(ds) {
  const value = valuesOf(ds);
  const shape = ds.shape || [];
  const n = shape.length ? shape[0] : (value ? value.length : 0);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = value[i];
  return { values: out, shape, dtype: ds.dtype };
}

/** The categorical encoding anndata uses (categories + codes). */
function readCategorical(group) {
  const cats = Array.from(valuesOf(group.get('categories')));
  const codes = toNumbers(valuesOf(group.get('codes')));
  const values = new Array(codes.length);
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    values[i] = c < 0 || c === 4294967295 ? '' : cats[c] ?? '';
  }
  return values;
}

/** The index of obs / var (anndata 0.13 stores it as a group). */
function readIndex(group) {
  const node = group.get('_index');
  if (!node) return null;
  if (node.value !== undefined && !node.get) {
    const v = Array.from(valuesOf(node));
    return v.map((x) => String(x));
  }
  const values = node.get ? node.get('values') : null;
  if (values) {
    const v = Array.from(valuesOf(values));
    const maskNode = node.get('mask');
    const mask = maskNode ? Array.from(valuesOf(maskNode)) : null;
    if (mask && mask.some(Boolean)) return v.filter((_, i) => !mask[i]).map((x) => String(x));
    return v.map((x) => String(x));
  }
  return null;
}

/**
 * Read an h5ad from a File / ArrayBuffer.
 * @param {File|ArrayBuffer} file
 */
export async function readH5ad(file) {
  const lib = await loadH5();
  const buffer = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  const name = 'upload.h5ad';
  lib.FS.writeFile(name, new Uint8Array(buffer));
  let h5file;
  try {
    h5file = new lib.File(name, 'r');
    const root = h5file;

    // --- obs -----------------------------------------------------------
    const obs = {};
    let cells = [];
    const obsGroup = root.get('obs');
    if (obsGroup) {
      cells = readIndex(obsGroup) || [];
      for (const key of obsGroup.keys()) {
        if (key.startsWith('_')) continue;
        const node = obsGroup.get(key);
        if (node instanceof lib.Group) {
          if (node.get('categories') && node.get('codes')) {
            obs[key] = { type: 'category', values: readCategorical(node) };
          } else if (node.get('values')) {
            const v = Array.from(valuesOf(node.get('values')));
            obs[key] = { type: 'number', values: v };
          }
        } else {
          const d = readDataset(node);
          obs[key] = { type: isNumeric(d.dtype) ? 'number' : 'string', values: d.values };
        }
      }
    }

    // --- var (gene names) ---------------------------------------------
    const varGroup = root.get('var');
    let genes = [];
    if (varGroup) {
      const idx = readIndex(varGroup);
      if (idx && idx.length) {
        genes = idx;
      } else {
        for (const key of ['_index', 'gene_symbols', 'gene_name', 'feature_name']) {
          const node = varGroup.get(key);
          if (node) {
            genes = Array.from(valuesOf(node)).map((x) => String(x));
            break;
          }
        }
      }
    }

    // --- obsm ----------------------------------------------------------
    const obsm = {};
    const obsmGroup = root.get('obsm');
    if (obsmGroup) {
      for (const key of obsmGroup.keys()) {
        if (key.startsWith('_')) continue;
        const node = obsmGroup.get(key);
        if (node instanceof lib.Dataset) {
          const d = readDataset(node);
          obsm[key] = { values: d.values, shape: d.shape };
        }
      }
    }

    // --- X (the expression matrix) -------------------------------------
    const X = readMatrix(root.get('X'), lib);

    return {
      nCells: cells.length || (X ? X.nCells : 0),
      nGenes: genes.length || (X ? X.nGenes : 0),
      cells,
      genes,
      obs,
      obsm,
      X,
    };
  } finally {
    try { h5file?.close(); } catch (err) { /* ignore */ }
    try { lib.FS.unlink(name); } catch (err) { /* ignore */ }
  }
}

/**
 * The expression matrix, transposed to gene major (the format the blob
 * writer expects).  Both the sparse (CSC/CSR) and the dense layout are
 * supported.
 */
function readMatrix(node, lib) {
  if (!node) return null;
  const shape = readAttr(node, 'shape');
  if (node.value) {
    // dense
    const data = valuesOf(node);
    return {
      dense: true,
      values: data,
      nCells: shape ? shape[0] : data.length,
      nGenes: shape ? shape[1] : 0,
      shape,
    };
  }
  // sparse: the group holds data / indices / indptr
  const dataNode = node.get('data');
  const indicesNode = node.get('indices');
  const indptrNode = node.get('indptr');
  if (!dataNode || !indicesNode || !indptrNode) return null;
  const encoding =
    readAttr(node, 'encoding-type')?.[0] || readAttr(node, 'encoding')?.[0] || 'csc_matrix';
  return {
    dense: false,
    encoding,
    data: valuesOf(dataNode),
    indices: toNumbers(valuesOf(indicesNode)),
    indptr: toNumbers(valuesOf(indptrNode)),
    nCells: shape ? shape[0] : 0,
    nGenes: shape ? shape[1] : 0,
    shape,
  };
}

function readAttr(node, name) {
  const attrs = node.attrs;
  if (!attrs) return null;
  const a = attrs[name];
  if (!a) return null;
  return toNumbers(Array.from(a.value));
}
