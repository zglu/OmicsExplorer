"""The browser h5ad reader must not truncate 2-D datasets.

The bug: ``readDataset`` took ``shape[0]`` elements of the *flattened* array
h5wasm returns, so every obsm entry lost half of its points (a (n, 2) spatial
array came back as n elements - n/2 points).  This test runs the real reader
(web/src/core/h5ad.js with the vendored h5wasm) in node.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import h5py
import numpy as np
import pytest
import scipy.sparse as sp

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(not NODE, reason="node is not available")


def write_h5ad(path: Path, dense: np.ndarray, obsm: dict[str, np.ndarray], var_columns: dict[str, list[str]] | None = None) -> None:
    csc = sp.csc_matrix(dense)
    strings = h5py.string_dtype(encoding="utf-8")
    with h5py.File(path, "w") as fh:
        x = fh.create_group("X")
        x.attrs["encoding-type"] = "csc_matrix"
        x.attrs["encoding-version"] = "0.1.0"
        x.attrs["shape"] = [dense.shape[0], dense.shape[1]]
        x.create_dataset("indptr", data=np.asarray(csc.indptr, dtype=np.int64))
        x.create_dataset("indices", data=np.asarray(csc.indices, dtype=np.int32))
        x.create_dataset("data", data=np.asarray(csc.data, dtype=np.float32))
        obs = fh.create_group("obs")
        obs.create_dataset("_index", data=["c%d" % i for i in range(dense.shape[0])], dtype=strings)
        var = fh.create_group("var")
        var.create_dataset("_index", data=["g%d" % i for i in range(dense.shape[1])], dtype=strings)
        for key, values in (var_columns or {}).items():
            var.create_dataset(key, data=values, dtype=strings)
        emb = fh.create_group("obsm")
        for name, arr in obsm.items():
            emb.create_dataset(name, data=arr)


SCRIPT = """
import { readH5ad } from '%s/web/src/core/h5ad.js';
import fs from 'fs';
const buf = fs.readFileSync('%s');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const h5ad = await readH5ad(ab);
const out = {
  nCells: h5ad.nCells,
  nGenes: h5ad.nGenes,
  genes: h5ad.genes.length,
  obsm: {},
};
for (const [k, v] of Object.entries(h5ad.obsm)) {
  out.obsm[k] = { values: v.values.length, shape: v.shape };
}
if (h5ad.X && !h5ad.X.dense) {
  out.X = { data: h5ad.X.data.length, indices: h5ad.X.indices.length, indptr: h5ad.X.indptr.length };
}
console.log(JSON.stringify(out));
"""


def test_readh5ad_keeps_the_full_2d_obsm_arrays(tmp_path):
    n_cells, n_genes = 30, 8
    rng = np.random.default_rng(5)
    dense = rng.integers(0, 4, size=(n_cells, n_genes)).astype(np.float32)
    dense[dense < 3] = 0
    spatial = (rng.random((n_cells, 2)) * 1000).astype(np.float64)
    umap = (rng.random((n_cells, 2)) * 30).astype(np.float64)
    pca = (rng.random((n_cells, 7))).astype(np.float64)
    path = tmp_path / "tiny.h5ad"
    write_h5ad(path, dense, {"spatial": spatial, "X_umap": umap, "X_pca": pca})

    script = SCRIPT % (ROOT, path)
    out = subprocess.run([NODE, "--input-type=module", "-e", script], capture_output=True, text=True)
    if out.returncode != 0:
        raise AssertionError(f"the node script failed: {out.stderr[-800:]}")
    import json

    result = json.loads(out.stdout.strip().splitlines()[-1])
    assert result["nCells"] == n_cells
    assert result["genes"] == n_genes
    # the obsm arrays must be complete - not cut down to shape[0] elements
    assert result["obsm"]["spatial"]["values"] == n_cells * 2
    assert result["obsm"]["X_umap"]["values"] == n_cells * 2
    assert result["obsm"]["X_pca"]["values"] == n_cells * 7
    assert result["X"]["data"] == int((dense != 0).sum())


def test_readh5ad_prefers_gene_symbols_over_the_index(tmp_path):
    """The browser build queried genes by their Ensembl id.

    The bug: the reader took ``var/_index`` first, but cellxgene style files
    keep the gene ids there and the symbols in ``feature_name`` - the python
    build searched by symbol, the browser build only by Ensembl id.
    """
    n_cells, n_genes = 10, 4
    dense = np.zeros((n_cells, n_genes), dtype=np.float32)
    dense[0, 0] = 1.0
    path = tmp_path / "symbols.h5ad"
    write_h5ad(
        path,
        dense,
        {},
        var_columns={
            "gene_ids": ["ENSG0000011", "ENSG0000012", "ENSG0000013", "ENSG0000014"],
            "feature_name": ["ACTB", "MYH6", "TNNT2", "GATA4"],
        },
    )

    script = SCRIPT % (ROOT, path)
    out = subprocess.run([NODE, "--input-type=module", "-e", script], capture_output=True, text=True)
    if out.returncode != 0:
        raise AssertionError(f"the node script failed: {out.stderr[-800:]}")
    import json

    result = json.loads(out.stdout.strip().splitlines()[-1])
    assert result["nGenes"] == n_genes
    # the reader reports the genes as plain strings - check them via a symbol
    script2 = (
        SCRIPT % (ROOT, path)
        + "\nconsole.log(JSON.stringify(h5ad.genes));"
    )
    out2 = subprocess.run([NODE, "--input-type=module", "-e", script2], capture_output=True, text=True)
    genes = json.loads(out2.stdout.strip().splitlines()[-1])
    assert genes == ["ACTB", "MYH6", "TNNT2", "GATA4"]
