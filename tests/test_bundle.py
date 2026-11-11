"""Tests for the bundle format and the manifest handling."""

from __future__ import annotations

import os
import gzip
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from omicexplorer import blob  # noqa: E402
from omicexplorer.config import ConfigError, load_project  # noqa: E402
from omicexplorer.converter import natural_key  # noqa: E402
from omicexplorer.h5ad_io import SparseMatrix  # noqa: E402


# --------------------------------------------------------------------------
# the X.bin codec
# --------------------------------------------------------------------------


def _write_blob(tmp_path: Path, cells, values, n_cells=10, features=None):
    features = features or ["G0"]
    index = blob.write_x_blob(
        tmp_path / "X.bin",
        features,
        np.asarray(cells, dtype=np.int32),
        np.asarray(values, dtype=np.float32),
        np.array([0, len(cells)], dtype=np.int64),
        n_cells=n_cells,
    )
    return index


def test_blob_roundtrip(tmp_path):
    cells = np.array([0, 3, 4, 9], dtype=np.int32)
    values = np.array([1.0, 2.5, 0.25, 7.0], dtype=np.float32)
    index = _write_blob(tmp_path, cells, values)

    assert index["n"] == 10
    assert index["scale"] == pytest.approx(7.0 / 65535)

    got_cells, got_values = blob.read_gene_block(tmp_path / "X.bin", index, "G0")
    assert got_cells.tolist() == cells.tolist()
    # the values are quantised, so they are close but not exact
    assert np.allclose(got_values, values, atol=index["scale"])


def test_blob_index_and_gzip_are_written(tmp_path):
    index = _write_blob(tmp_path, [1], [1.0])
    assert (tmp_path / "X.index.json").exists()
    assert (tmp_path / "X.index.json.gz").exists()
    with gzip.open(tmp_path / "X.index.json.gz", "rt") as fh:
        assert json.load(fh) == index


def test_blob_handles_unsorted_cell_indices(tmp_path):
    """The delta encoding needs ascending indices - the writer sorts them."""
    cells = np.array([7, 2, 5], dtype=np.int32)
    values = np.array([1.0, 2.0, 3.0], dtype=np.float32)
    index = _write_blob(tmp_path, cells, values)
    got_cells, got_values = blob.read_gene_block(tmp_path / "X.bin", index, "G0")
    assert got_cells.tolist() == [2, 5, 7]
    # the values follow their cells
    assert np.allclose(got_values, [2.0, 3.0, 1.0], atol=index["scale"])


def test_blob_empty_gene(tmp_path):
    index = _write_blob(tmp_path, [], [], features=["EMPTY"])
    got_cells, got_values = blob.read_gene_block(tmp_path / "X.bin", index, "EMPTY")
    assert got_cells.size == 0
    assert got_values.size == 0


def test_blob_is_byte_compatible_with_the_reference_implementation():
    """Decode a blob written by the nematode-atlas project.

    That project uses the same format, so a blob must be readable by both
    sides.  The test is skipped when the reference data is not present.
    """
    reference = Path(
        os.environ.get(
            "OE_REFERENCE_BLOB",
            "/home/ubuntu/zglu_Data/WebProjects/NematodeAtlas_Data-Dev/nematode-atlas/data/hc_snseq",
        )
    )
    if not (reference / "X.bin").exists():
        pytest.skip("the reference blob is not available")
    index = blob.read_index(reference / "X.index.json")
    cells, values = blob.read_gene_block(reference / "X.bin", index, "HCON_00013360")
    assert index["n"] == 166130
    assert cells.size == 77533
    assert cells.min() >= 0 and cells.max() < index["n"]
    assert values.max() == pytest.approx(6.2716, abs=1e-3)
    # 46.67 % of the nuclei express the gene
    assert 100 * cells.size / index["n"] == pytest.approx(46.67, abs=0.01)


def test_blob_matches_the_reference_encoder():
    """Our encoder must produce the same bytes as the reference one."""
    reference = Path(
        os.environ.get(
            "OE_REFERENCE_ENCODER",
            "/home/ubuntu/zglu_Data/WebProjects/NematodeAtlas_Data-Dev/pipeline/python/common.py",
        )
    )
    if not reference.exists():
        pytest.skip("the reference encoder is not available")
    namespace: dict = {}
    source = reference.read_text()
    # only the two helper functions are needed
    start = source.index("def _gzip_block")
    end = source.index("def write_x_blob")
    exec("import gzip, io\nimport numpy as np\n" + source[start:end], namespace)

    cells = np.array([0, 2, 5, 9], dtype=np.int32)
    values = np.array([1.0, 2.0, 3.0, 4.0], dtype=np.float32)
    scale = 4.0 / 65535
    ours = blob.encode_gene_block(cells, values, scale)
    theirs = namespace["encode_gene_block"](cells, values, scale)
    assert ours == theirs


# --------------------------------------------------------------------------
# the manifest
# --------------------------------------------------------------------------


def test_load_example_project():
    project = load_project(ROOT / "examples" / "cs_of" / "project.yaml")
    assert project.name
    # exact-content assertions on the four static datasets; datasets added via
    # the web UI (datasets.auto.yaml) are merged in and must not break this
    static = ["cs_bin50", "of_cellbin", "cs_scrna", "of_scrna"]
    assert all(project.dataset(i) is not None for i in static)
    assert len(project.datasets) >= len(static)
    assert project.dataset("cs_bin50") is not None
    ds = project.dataset("cs_bin50")
    assert [g.name for g in ds.groups] == ["cell_type", "cluster", "leiden", "sample"]
    assert ds.embeddings[0].name == "spatial"
    assert ds.embeddings[0].kind == "spatial"
    assert ds.images and ds.images[0].path.endswith(".png")
    # the data files themselves are not part of the repository
    if not ds.path.exists():
        pytest.skip("the example data is not available on this machine")


def test_manifest_errors(tmp_path):
    # a manifest without any dataset is legal now (add everything via the UI)
    empty = tmp_path / "empty_project.yaml"
    empty.write_text("name: x\n")
    project = load_project(empty)
    assert len(project.datasets) == 0

    bad = tmp_path / "project.yaml"
    bad.write_text("name: x\ndatasets: oops\n")
    with pytest.raises(ConfigError):
        load_project(bad)

    bad.write_text("name: x\ndatasets:\n  - id: a\n")
    with pytest.raises(ConfigError):
        load_project(bad)

    bad.write_text("name: x\ndatasets:\n  - id: a\n    path: /nope.h5ad\n")
    project = load_project(bad)
    assert project.datasets[0].id == "a"


def test_natural_key():
    names = ["cluster 10", "cluster 2", "cluster 1"]
    assert sorted(names, key=natural_key) == ["cluster 1", "cluster 2", "cluster 10"]


# --------------------------------------------------------------------------
# the converter
# --------------------------------------------------------------------------


def test_grid_info_distinguishes_bins_from_cells():
    from omicexplorer.converter import _grid_info

    # a 50 um bin grid: one cell per position
    xs, ys = np.meshgrid(np.arange(10) * 50, np.arange(8) * 50)
    grid = _grid_info(np.column_stack([xs.ravel(), ys.ravel()]).astype(np.float32))
    assert grid["is_grid"] is True
    assert grid["pitch"] == pytest.approx(50)

    # individual cells: continuous coordinates
    rng = np.random.default_rng(0)
    xy = rng.random((500, 2)).astype(np.float32) * 1000
    grid = _grid_info(xy)
    assert grid["is_grid"] is False


def test_cli_help():
    out = subprocess.run(
        [sys.executable, "-m", "omicexplorer.cli", "--help"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    assert out.returncode == 0
    for command in ("init", "build", "serve", "export", "markers"):
        assert command in out.stdout
