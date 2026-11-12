"""Seurat .rds support for the runtime add flow (needs Rscript + Seurat)."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from omicsexplorer import add  # noqa: E402
from omicsexplorer.config import load_project  # noqa: E402
from omicsexplorer.rds_io import ensure_h5ad, is_rds  # noqa: E402

RSCRIPT = shutil.which("Rscript")


def _has_seurat() -> bool:
    if not RSCRIPT:
        return False
    try:
        probe = subprocess.run(
            [RSCRIPT, "-e", 'cat(requireNamespace("SeuratObject", quietly=TRUE), "\\n")'],
            capture_output=True,
            text=True,
            timeout=300,
        )
        return probe.stdout.strip().splitlines()[-1].strip() == "TRUE"
    except Exception:
        return False


requires_r = pytest.mark.skipif(not _has_seurat(), reason="no Rscript/Seurat on this machine")


def write_seurat_rds(path: Path, n_cells: int = 80, n_genes: int = 60) -> Path:
    """Build a small Seurat object (counts + meta.data + umap embedding)."""
    script = f"""
suppressPackageStartupMessages(library(Seurat))
set.seed(11)
ng <- {n_genes}; nc <- {n_cells}
m <- Matrix::rsparsematrix(ng, nc, 0.25, rand.x=function(n) as.integer(rpois(n, 2)))
m <- as(m, "dgCMatrix")
m@Dimnames <- list(paste0("gene", 1:ng), paste0("cell", 1:nc))
meta <- data.frame(group = rep(c("alpha","beta","gamma"), length.out = nc),
                   batch = rep(c("b1","b2"), length.out = nc))
obj <- suppressWarnings(CreateSeuratObject(counts = m, meta.data = meta))
emb <- matrix(rnorm(nc * 2), nc, 2); rownames(emb) <- colnames(m)
obj@reductions <- list(umap = CreateDimReducObject(emb, assay = "RNA", key = "UMAP_"))
saveRDS(obj, '{path}')
cat("saved\\n")
"""
    probe = subprocess.run([RSCRIPT, "-e", script], capture_output=True, text=True, timeout=600)
    assert probe.returncode == 0, probe.stderr[-2000:]
    return path


def write_sce_rds(path: Path, n_cells: int = 50, n_genes: int = 30) -> Path:
    script = f"""
suppressPackageStartupMessages(library(SingleCellExperiment))
suppressPackageStartupMessages(library(Matrix))
set.seed(3)
ng <- {n_genes}; nc <- {n_cells}
m <- Matrix::rsparsematrix(ng, nc, 0.3)
m <- as(m, "dgCMatrix")
rownames(m) <- paste0("gene", 1:ng); colnames(m) <- paste0("cell", 1:nc)
cds <- S4Vectors::DataFrame(sample = sample(c("s1", "s2"), nc, TRUE),
                            cluster = sample(c("a", "b", "c"), nc, TRUE))
rownames(cds) <- colnames(m)
emb <- matrix(rnorm(nc * 2), nc, 2); rownames(emb) <- colnames(m)
sce <- SingleCellExperiment(assays = list(counts = m), colData = cds,
                            reducedDims = list(UMAP = emb, PCA = emb))
saveRDS(sce, '{path}')
cat("saved\\n")
"""
    probe = subprocess.run([RSCRIPT, "-e", script], capture_output=True, text=True, timeout=600)
    assert probe.returncode == 0, probe.stderr[-2000:]
    return path


@requires_r
def test_is_rds(tmp_path):
    assert is_rds(tmp_path / "a.rds")
    assert is_rds(tmp_path / "B.RData")
    assert not is_rds(tmp_path / "a.h5ad")


@requires_r
def test_discover_and_convert(tmp_path):
    src = write_seurat_rds(tmp_path / "mini.rds")
    info = add.discover(src)
    assert info["format"] == "rds"
    assert info["n_cells"] == 80
    assert info["n_features"] == 60
    names = {g["column"] for g in info["groups"]}
    assert "group" in names
    assert any(e["name"] == "umap" for e in info["embeddings"])
    # the conversion is cached: a second discover must not rerun R
    h5 = info["path"]
    assert Path(h5).exists()


@requires_r
def test_discover_sce(tmp_path):
    src = write_sce_rds(tmp_path / "mini_sce.rds")
    info = add.discover(src)
    assert info["n_cells"] == 50
    assert info["n_features"] == 30
    assert {g["column"] for g in info["groups"]} == {"sample", "cluster"}
    emb = {e["name"]: e["kind"] for e in info["embeddings"]}
    assert emb == {"umap": "umap", "pca": "pca"}
    import anndata as ad

    a = ad.read_h5ad(info["path"])
    assert a.shape == (50, 30)
    assert set(a.obsm) == {"umap", "pca"}


@requires_r
def test_ensure_h5ad_cache(tmp_path):
    src = write_seurat_rds(tmp_path / "mini.rds")
    first = ensure_h5ad(src, log=lambda m: None)
    second = ensure_h5ad(src, log=lambda m: None)
    assert first == second
    import anndata as ad

    with_annotation_cached = ad.read_h5ad(first)
    assert with_annotation_cached.shape == (80, 60)
    assert "group" in with_annotation_cached.obs.columns
    assert list(with_annotation_cached.obsm) == ["umap"]


@requires_r
def test_full_add_pipeline(tmp_path):
    src_dir = tmp_path / "project_src"
    src_dir.mkdir()
    src = write_seurat_rds(src_dir / "mini.rds")
    manifest = src_dir / "project.yaml"
    manifest.write_text(
        "name: rds probe\nsubtitles: ''\ndatasets:\n  - id: existing\n    path: missing.h5ad\n",
        encoding="utf-8",
    )
    project = load_project(manifest)
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    logs: list[str] = []
    spec = add.make_spec(project, {"path": str(src)}, log=logs.append)
    assert spec.kind == "umap"
    assert {g.name for g in spec.groups} == {"group", "batch"}
    payload = add.build_dataset(spec, data_dir, log=logs.append)
    add.register_built(project, data_dir, payload)
    add.append_auto_entry(spec, project)

    project_json = data_dir / "project.json"
    assert project_json.exists()
    import json

    panels = json.loads(project_json.read_text()).get("panels") or []
    assert any(p.get("id") == spec.id for p in panels)

    entry = [e for e in add.read_auto_manifest(project) if e.get("id") == spec.id]
    assert entry and Path(entry[0]["path"]).is_absolute()

    # run the whole background job path too
    job = add.start_add(project, data_dir, {"path": str(src), "name": "mini2"})
    import time

    for _ in range(240):
        status = add.job_status(job)
        if status["status"] != "running":
            break
        time.sleep(0.25)
    assert status["status"] == "done", status["log"]
