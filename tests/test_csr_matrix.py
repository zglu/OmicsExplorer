"""Regression tests for the CSR transpose bug.

The bug: ``_csr_to_gene_major`` sorted the entries by gene (column) index but
kept the column indices as "cell indices", so every CSR h5ad ended up as a
bundle in which every gene points at one out-of-range cell - the web app then
shows the expression of *every* gene as zero.  CSC files were not affected,
which is why only some datasets broke.
"""

from __future__ import annotations

import sys
from pathlib import Path

import h5py
import numpy as np
import pytest
import scipy.sparse as sp

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from omicsexplorer import blob  # noqa: E402
from omicsexplorer.h5ad_io import read_matrix  # noqa: E402


def write_csr_h5ad(path: Path, dense: np.ndarray) -> None:
    csr = sp.csr_matrix(dense)
    strings = h5py.string_dtype(encoding="utf-8")
    with h5py.File(path, "w") as fh:
        x = fh.create_group("X")
        x.attrs["encoding-type"] = "csr_matrix"
        x.attrs["encoding-version"] = "0.1.0"
        x.attrs["shape"] = [dense.shape[0], dense.shape[1]]
        x.create_dataset("indptr", data=np.asarray(csr.indptr, dtype=np.int64))
        x.create_dataset("indices", data=np.asarray(csr.indices, dtype=np.int64))
        x.create_dataset("data", data=np.asarray(csr.data, dtype=np.float32))

        obs = fh.create_group("obs")
        obs.create_dataset("_index", data=["c%d" % i for i in range(dense.shape[0])], dtype=strings)
        var = fh.create_group("var")
        var.create_dataset("_index", data=["g%d" % i for i in range(dense.shape[1])], dtype=strings)


def test_csr_matrix_transposes_to_gene_major(tmp_path):
    rng = np.random.default_rng(3)
    dense = rng.integers(0, 5, size=(17, 9)).astype(np.float32)
    path = tmp_path / "csr.h5ad"
    write_csr_h5ad(path, dense)

    matrix = read_matrix(path)
    assert matrix.n_cells == 17 and matrix.n_genes == 9
    reference = sp.csc_matrix(dense)  # gene major
    for g in range(9):
        cells, values = matrix.gene_slice(g)
        expected_rows = reference.indices[reference.indptr[g]:reference.indptr[g + 1]]
        expected_vals = reference.data[reference.indptr[g]:reference.indptr[g + 1]]
        assert np.array_equal(cells, expected_rows), f"gene {g}: wrong cell indices"
        assert np.allclose(values, expected_vals)


def test_csr_bundle_decodes_to_the_original_values(tmp_path):
    """The full server pipeline: csr h5ad -> gene major -> blob -> decode."""
    rng = np.random.default_rng(11)
    n_cells, n_genes = 40, 12
    dense = rng.integers(0, 9, size=(n_cells, n_genes)).astype(np.float32)
    path = tmp_path / "csr.h5ad"
    write_csr_h5ad(path, dense)

    matrix = read_matrix(path)
    features = ["g%d" % i for i in range(n_genes)]
    index = blob.write_x_blob(
        tmp_path / "X.bin",
        features,
        matrix.indices,
        matrix.data,
        matrix.indptr,
        n_cells=n_cells,
    )
    for g, feature in enumerate(features):
        expected = dense[:, g]
        got = np.zeros(n_cells, dtype=np.float32)
        cells, values = blob.read_gene_block(tmp_path / "X.bin", index, feature)
        got[cells] = values
        # 16 bit quantisation: the values are exact within half a step
        assert np.allclose(got, expected, atol=index["scale"] / 2), f"gene {feature} does not decode to the original"


def test_csr_bundle_roundtrip_on_the_real_broken_file():
    """The Human_12W_heart Visium file (csr, int64 indices) must round-trip."""
    src = ROOT / "examples/cs_of/uploads/20261112_200835_Human_12W_heart_B1_Visium.h5ad"
    if not src.exists():
        pytest.skip("the example upload is not part of the repository")
    matrix = read_matrix(src)
    assert matrix.n_cells == 4992
    assert int(matrix.indices.max()) < matrix.n_cells, "cell indices must stay in range"
    assert int(matrix.indices.min()) >= 0


def test_write_x_blob_rejects_out_of_range_cell_indices(tmp_path):
    """A mixed-up matrix (gene indices instead of cell indices) must fail loudly."""
    features = ["a", "b"]
    cell_indices = np.array([50, 51, 52], dtype=np.int32)
    values = np.array([1.0, 2.0, 3.0], dtype=np.float32)
    indptr = np.array([0, 2, 3], dtype=np.int64)
    with pytest.raises(ValueError):
        blob.write_x_blob(tmp_path / "X.bin", features, cell_indices, values, indptr, n_cells=10)
