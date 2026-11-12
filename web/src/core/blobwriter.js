// Write the expression blob (X.bin + X.index.json) in the browser.
//
// The format is the one the python side writes (see omicsexplorer/blob.py):
//
//   X.index.json  {"n": cells, "scale": float,
//                  "genes": {"<gene>": [offset, length, n_entries]}}
//   X.bin         one gzip block per gene: varint deltas of the cell indices,
//                 then the high bytes and the low bytes of the 16 bit values.

/**
 * Round like numpy's rint (half to even) - the python writer is the
 * reference, so the two encoders have to agree bit by bit.
 */
function roundHalfToEven(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Quantise the values and encode one gene block. */
function encodeGeneBlock(cells, values, scale) {
  const n = cells.length;
  if (!n) return new Uint8Array(0);
  const q = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const v = roundHalfToEven((values[i] || 0) / scale);
    q[i] = v < 0 ? 0 : v > 65535 ? 65535 : v;
  }
  // varint deltas of the cell indices (ascending, starting at 0)
  // the format is: delta[i] = cells[i] - cells[i-1] + 1 (with cells[-1] = -1),
  // exactly what the python writer (omicexplorer/blob.py) produces
  const deltas = [];
  let prev = -1;
  for (let i = 0; i < n; i++) {
    deltas.push(cells[i] - prev + 1);
    prev = cells[i];
  }
  const varintBytes = [];
  for (const d of deltas) {
    let value = d;
    while (value >= 0x80) {
      varintBytes.push((value & 0x7f) | 0x80);
      value >>>= 7;
    }
    varintBytes.push(value & 0x7f);
  }
  const out = new Uint8Array(varintBytes.length + 2 * n);
  out.set(varintBytes, 0);
  const hi = out.subarray(varintBytes.length, varintBytes.length + n);
  const lo = out.subarray(varintBytes.length + n);
  for (let i = 0; i < n; i++) {
    hi[i] = (q[i] >> 8) & 0xff;
    lo[i] = q[i] & 0xff;
  }
  return out;
}

/** gzip a block (CompressionStream is available in every modern browser). */
async function gzip(bytes) {
  if (typeof CompressionStream === 'undefined') return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Build the expression blob.
 *
 * @param {string[]} genes          gene names (matrix columns)
 * @param {Int32Array} cellIndices  the cell index of every stored entry
 * @param {Float32Array} values     the value of every stored entry
 * @param {Int32Array} indptr       gene g owns entries [indptr[g], indptr[g+1])
 * @param {number} nCells
 * @param {number} [scale]          quantisation step (default: max / 65535)
 * @returns {Promise<{blob: Blob, index: object}>}
 */
export async function buildExpressionBlob(genes, cellIndices, values, indptr, nCells, scale = null) {
  let max = 0;
  for (let i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
  const step = scale != null && scale > 0 ? scale : (max > 0 ? max / 65535 : 1);
  const chunks = [];
  const map = {};
  let offset = 0;
  for (let g = 0; g < genes.length; g++) {
    const a = indptr[g];
    const b = indptr[g + 1];
    const n = b - a;
    if (!n) {
      map[genes[g]] = [offset, 0, 0];
      continue;
    }
    const cells = cellIndices.slice(a, b);
    const vals = values.slice(a, b);
    const block = await gzip(encodeGeneBlock(cells, vals, step));
    chunks.push(block);
    map[genes[g]] = [offset, block.length, n];
    offset += block.length;
  }
  return {
    blob: new Blob(chunks, { type: 'application/octet-stream' }),
    index: { n: nCells, scale: step, genes: map },
  };
}
