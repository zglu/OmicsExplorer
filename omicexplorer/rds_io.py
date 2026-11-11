"""Seurat / R objects (.rds, .RData) for the runtime "add dataset" flow.

The heavy lifting happens in R (Rscript + the Seurat / SingleCellExperiment
packages): :file:`convert_rds.r` extracts the counts matrix, the cell metadata
and the embeddings into a small "parts" folder, and
:func:`build_h5ad_from_parts` assembles them into a regular .h5ad, which the
rest of the pipeline (discovery -> spec -> bundle) consumes unchanged.

The converted h5ad is cached next to the source (or under a temp dir if that
is not writable), so a conversion only runs once per file version.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

import numpy as np

from .h5ad_io import read_obs, read_var, read_index_column, feature_names

__all__ = ["is_rds", "ensure_h5ad", "RDS_SUFFIXES"]

RDS_SUFFIXES = (".rds", ".rdata", ".rda")
SCRIPT = Path(__file__).resolve().parent / "convert_rds.r"


def is_rds(path: str | Path) -> bool:
    return Path(path).suffix.lower() in RDS_SUFFIXES


def _r_script() -> str:
    if not SCRIPT.exists():
        raise RuntimeError(f"missing R script: {SCRIPT}")
    return str(SCRIPT)


def _rscript_binary() -> str:
    import shutil as _sh

    rscript = _sh.which("Rscript") or _sh.which("R")
    if rscript is None:
        raise RuntimeError(
            "R is not available on the server - converting .rds needs Rscript "
            "(and the Seurat / SingleCellExperiment packages)"
        )
    return rscript


def cache_dir_for(src: Path) -> Path:
    """A folder next to the source (or a temp dir) that stores the conversion."""
    src = src.expanduser().resolve()
    digest = hashlib.sha1(f"{src}|{src.stat().st_size}|{int(src.stat().st_mtime)}".encode()).hexdigest()[:10]
    stem = "".join(c if c.isascii() and (c.isalnum() or c in "-_") else "_" for c in src.stem)[:40] or "data"
    candidate = (src.parent / f".oe_rds_cache_{stem}_{digest}").resolve()
    try:
        candidate.mkdir(parents=True, exist_ok=True)
        probe = candidate / ".write"
        probe.write_text("ok")
        probe.unlink()
        return candidate
    except OSError:
        return Path(tempfile.mkdtemp(prefix=f"oe_rds_{stem}_"))


def extract_parts(src: Path, parts: Path, log: Callable[[str], None]) -> dict[str, Any]:
    """Run the R extraction; returns the parsed ``info.txt`` summary."""
    src = Path(src).expanduser().resolve()
    parts = Path(parts)
    if parts.exists():
        shutil.rmtree(parts)
    cmd = [_rscript_binary(), _r_script(), str(src), str(parts)]
    log(f"$ {' '.join(Path(c).name if c.endswith('.r') else c for c in cmd)}")
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=7200)
    for line in proc.stdout.splitlines():
        if line.strip():
            log(line.rstrip())
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()[-6:]
        tail = [line.rstrip("\033[0m") for line in tail]
        raise RuntimeError("R conversion failed:\n" + "\n".join(tail))
    info: dict[str, Any] = {}
    info_path = parts / "info.txt"
    if info_path.exists():
        for line in info_path.read_text().splitlines():
            if "=" in line:
                key, _, value = line.partition("=")
                info[key.strip()] = value.strip()
    return info


def build_h5ad_from_parts(parts: Path, dst: Path, log: Callable[[str], None]) -> Path:
    """Assemble the R 'parts' bundle into a regular .h5ad (cells x features)."""
    import pandas as pd
    import scipy.io
    from scipy import sparse
    import anndata

    parts = Path(parts)
    dst = Path(dst)
    mfile = parts / "counts.mtx"
    if not mfile.exists():
        raise RuntimeError("the R conversion produced no counts.mtx")

    log("assembling the h5ad ...")
    mat = scipy.io.mmread(mfile)
    x = (mat.tocsr() if sparse.issparse(mat) else sparse.csr_matrix(mat)).T.astype(np.float32)
    cells = [str(c) for c in (parts / "cells.txt").read_text().splitlines() if c.strip()]
    features = [str(c) for c in (parts / "features.txt").read_text().splitlines() if c.strip()]

    if x.shape[0] != len(cells):
        raise RuntimeError(f"cells.txt has {len(cells)} names but the matrix has {x.shape[0]} cells")
    if x.shape[1] != len(features):
        raise RuntimeError(f"features.txt has {len(features)} names but the matrix has {x.shape[1]} features")
    if len(set(cells)) != len(cells):
        raise RuntimeError("the object has duplicate cell names")

    # unique feature names (AnnData needs them)
    seen: dict[str, int] = {}
    uniq = []
    for name in features:
        if not name:
            name = "gene"
        if name not in seen:
            seen[name] = 0
            uniq.append(name)
        else:
            seen[name] += 1
            uniq.append(f"{name}_{seen[name] + 1}")

    obs = pd.DataFrame(index=pd.Index(cells))
    meta_csv = parts / "meta.csv"
    if meta_csv.exists():
        meta = pd.read_csv(meta_csv, dtype="object", keep_default_na=False)
        if "cell" in meta.columns:
            meta = meta.set_index("cell")
            meta.index = meta.index.map(str)
            meta = meta.reindex(obs.index)
            # keep the numbers as numbers - they are metrics, not categories
            for col in list(meta.columns):
                values = meta[col]
                if values.dtype != object:
                    continue
                try:
                    numbers = pd.to_numeric(values, errors="raise")
                except (ValueError, TypeError):
                    continue
                if numbers.notna().all():
                    meta[col] = numbers.astype("float64")
            obs = meta.copy()
            for col in obs.columns:
                if obs[col].dtype == object:
                    obs[col] = obs[col].astype(str)

    var_df = pd.DataFrame(index=pd.Index(uniq))

    adata = anndata.AnnData(X=x, obs=obs, var=var_df)
    emb_files = sorted(parts.glob("emb_*.csv"))
    for emb_file in emb_files:
        table = pd.read_csv(emb_file)
        if table.shape[1] < 2 or table.shape[0] != len(cells):
            continue
        name = emb_file.stem[4:] or "emb"
        adata.obsm[name] = table.to_numpy(dtype=np.float32)
    log(
        f"out: {adata.shape[0]:,} cells x {adata.shape[1]:,} features, "
        f"{len(adata.obsm)} embeddings, {adata.obs.columns.size} metadata columns"
    )
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.unlink()
    adata.write_h5ad(dst, compression="lzf")
    return dst


def ensure_h5ad(src: str | Path, log: Callable[[str], None] = print, force: bool = False) -> Path:
    """Convert a Seurat/R file into an .h5ad once and reuse the cached copy."""
    src = Path(src).expanduser()
    if not src.exists():
        raise FileNotFoundError(f"{src} does not exist")
    if not is_rds(src):
        raise ValueError(f"{src.name}: expected an .rds/.RData file")

    cache = cache_dir_for(src)
    h5 = cache / "converted.h5ad"
    key = cache / "source.json"
    valid = False
    if h5.exists() and key.exists():
        try:
            meta = json.loads(key.read_text())
            stat = src.stat()
            valid = (
                meta.get("path") == str(src.resolve())
                and meta.get("size") == stat.st_size
                and int(meta.get("mtime", -1)) == int(stat.st_mtime)
                and h5.stat().st_size > 0
            )
        except (OSError, ValueError, json.JSONDecodeError):
            valid = False
    if valid and not force:
        print(f"[rds] cache hit: {h5}", file=sys.stderr)
        return h5

    print(f"[rds] converting {src} via Rscript ...", file=sys.stderr)
    parts = cache / "parts"
    _ = extract_parts(src, parts, log)  # info.txt already recorded next to the parts
    build_h5ad_from_parts(parts, h5, log)
    try:
        stat = src.stat()
        key.write_text(
            json.dumps({"path": str(src.resolve()), "size": stat.st_size, "mtime": int(stat.st_mtime)})
        )
    except OSError:
        pass
    return h5
