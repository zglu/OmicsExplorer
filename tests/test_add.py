"""Tests for the runtime "add dataset" pipeline (web UI -> bundle)."""

from __future__ import annotations

import sys
from pathlib import Path

import h5py
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from omicexplorer import add  # noqa: E402
from omicexplorer.config import load_project  # noqa: E402


def write_test_h5ad(path, X, obs, obsm, index, var_index):
    """A minimal valid h5ad (the layout the converter reads with h5py)."""
    strings = h5py.string_dtype(encoding="utf-8")
    with h5py.File(path, "w") as fh:
        x = fh.create_group("X")
        x.attrs["encoding-type"] = "csc_matrix"
        x.attrs["encoding-version"] = "0.1.0"
        x.attrs["shape"] = [X.shape[0], X.shape[1]]
        x.create_dataset("indptr", data=np.asarray(X.indptr, dtype=np.int64))
        x.create_dataset("indices", data=np.asarray(X.indices, dtype=np.int32))
        x.create_dataset("data", data=np.asarray(X.data, dtype=np.float32))

        obs_grp = fh.create_group("obs")
        obs_grp.create_dataset("_index", data=[str(v) for v in index], dtype=strings)
        for name, values in obs.items():
            obs_grp.create_dataset(name, data=[str(v) for v in values], dtype=strings)

        var_grp = fh.create_group("var")
        var_grp.create_dataset("_index", data=[str(v) for v in var_index], dtype=strings)

        emb_grp = fh.create_group("obsm")
        for name, arr in obsm.items():
            emb_grp.create_dataset(name, data=arr)


def h5ad_path(tmp_path: Path) -> Path:
    n_cells, n_genes = 120, 30
    rng = np.random.default_rng(7)
    dense = rng.integers(0, 5, size=n_cells * n_genes).reshape(n_cells, n_genes).astype(np.float32)
    dense[dense < 4] = 0
    import scipy.sparse as sp

    csc = sp.csc_matrix(dense)
    sample = rng.integers(0, 3, n_cells)
    cluster = rng.integers(0, 5, n_cells)
    path = tmp_path / "tiny_sample.h5ad"
    write_test_h5ad(
        path,
        X=csc,
        obs={
            "sample": np.array([f"s{i}" for i in sample]),
            "cell_type": np.array([f"c{i}" for i in cluster]),
        },
        obsm={
            "spatial": (rng.random((n_cells, 2)) * 100).astype(np.float32),
            "X_umap": (rng.random((n_cells, 2)) * 20).astype(np.float32),
        },
        index=np.array(["cell_%04d" % i for i in range(n_cells)]),
        var_index=np.array(["gene_%03d" % i for i in range(n_genes)]),
    )
    return path


# --------------------------------------------------------------------------
# config merge
# --------------------------------------------------------------------------


def _manifest(tmp_path: Path) -> Path:
    manifest = tmp_path / "project.yaml"
    manifest.write_text(
        "name: test\nsubtitles: ''\ndatasets:\n  - id: existing\n    path: missing.h5ad\n",
        encoding="utf-8",
    )
    return manifest


def test_auto_manifest_is_merged(tmp_path):
    manifest = _manifest(tmp_path)
    auto = tmp_path / "datasets.auto.yaml"
    auto.write_text(
        "datasets:\n  - id: extra\n    path: other.h5ad\n    kind: spatial\n",
        encoding="utf-8",
    )
    project = load_project(manifest)
    assert [d.id for d in project.datasets] == ["existing", "extra"]
    assert project.datasets[1].kind == "spatial"


def test_main_manifest_wins_over_auto(tmp_path):
    manifest = _manifest(tmp_path)
    auto = tmp_path / "datasets.auto.yaml"
    auto.write_text("datasets:\n  - id: existing\n    path: other.h5ad\n", encoding="utf-8")
    project = load_project(manifest)
    assert [d.id for d in project.datasets] == ["existing"]
    assert project.datasets[0].path.name != "other.h5ad"


# --------------------------------------------------------------------------
# discover / add
# --------------------------------------------------------------------------


def test_discover(tmp_path):
    src = h5ad_path(tmp_path)
    info = add.discover(src)
    assert info["n_cells"] == 120
    assert info["n_features"] == 30
    assert {e["obsm"] for e in info["embeddings"]} == {"spatial", "X_umap"}
    assert {g["column"] for g in info["groups"]} == {"sample", "cell_type"}
    assert "sample" in info["suggested_id"] or info["suggested_id"].startswith("tiny")


def test_add_dataset_full_pipeline(tmp_path):
    src = h5ad_path(tmp_path)
    manifest = _manifest(tmp_path)
    manifest.write_text(
        "name: test\ndatasets:\n  - id: seed\n    path: %s\n" % (Path("seed.h5ad"),),
        encoding="utf-8",
    )
    project = load_project(manifest)
    out = tmp_path / "data"

    result = add.add_dataset(project, out, {"path": str(src)})
    ds_id = result["id"]
    assert (out / ds_id / "index.json").exists()
    assert (out / "project.json").exists()

    # registered in the auto manifest
    entries = add.read_auto_manifest(project)
    assert [e["id"] for e in entries] == [ds_id]

    # a rebuild of the project knows the dataset
    project2 = load_project(manifest)
    assert ds_id in project2.ids

    # project.json / genes.json include it
    import json

    payload = json.loads((out / "project.json").read_text())
    assert {p["id"] for p in payload["panels"]} >= {ds_id}
    genes = json.loads((out / "genes.json").read_text())["genes"]
    assert any(ds_id in entry.get("panels", []) for entry in genes.values())


def test_add_replaces_an_entry_with_the_same_id(tmp_path):
    src = h5ad_path(tmp_path)
    manifest = _manifest(tmp_path)
    project = load_project(manifest)
    add.add_dataset(project, tmp_path / "data1", {"path": str(src)})
    entries = add.read_auto_manifest(project)
    assert len(entries) == 1
    # appending the same spec twice replaces its entry instead of duplicating
    entries[0]["name"] = "renamed"
    entries[0]["description"] = "changed"
    add.save_auto_manifest(project, entries)
    spec = add.make_spec(project, {"path": str(src)}, print)
    spec.id = entries[0]["id"]
    add.append_auto_entry(spec, project)
    out = add.read_auto_manifest(project)
    assert len(out) == 1
    assert out[0]["name"] == spec.name
