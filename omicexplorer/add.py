"""Add datasets at runtime - through the web UI, not by editing project.yaml.

The pipeline is the same as the offline ``build``:

  1. *discover* an h5ad: cells, features and the metadata groupings /
     embeddings that the file actually contains;
  2. *add*: build a :class:`~omicexplorer.config.DatasetSpec`, append it to
     ``datasets.auto.yaml`` next to the project manifest, convert it into the
     static bundle and register it in ``project.json`` / ``genes.json``.

Everything runs in a small background job so the browser can follow the
progress; the UI reloads the project when the job is done.

A restart is lossless: the manifest merge in :mod:`omicexplorer.config`
picks ``datasets.auto.yaml`` up again (the bundle on disk is reused).
"""

from __future__ import annotations

import json
import shutil

import re
import threading
import time
import traceback
import uuid
from datetime import date
from pathlib import Path
from typing import Any, Callable

import yaml

from .config import DatasetSpec, EmbeddingSpec, GroupSpec, guess_embedding_kind, guess_group_label
from .converter import _json_dump, build_dataset
from .h5ad_io import feature_names, list_obsm, read_index_column, read_obsm, read_obs

__all__ = ["discover", "add_dataset", "start_add", "job_status"]

_JOBS: dict[str, dict[str, Any]] = {}
_JOBS_LOCK = threading.Lock()

_GROUP_PREFIXES = (
    "_", "orig.", "n_counts", "percent", "version", "total",
    "ncount", "nfeature", "n_gene", "ngene", "numi", "doublet", "mt_",
)
_CARDINALITY_LIMIT = 4096


# --------------------------------------------------------------------------
# 1) discover
# --------------------------------------------------------------------------


def _clean_group_column(name: str) -> bool:
    low = name.lower()
    return not any(low.startswith(p) for p in _GROUP_PREFIXES)


ALLOWED_SUFFIXES = (".h5ad", ".hdf", ".h5", ".rds", ".rdata", ".rda")


def discover(path: str | Path) -> dict[str, Any]:
    """What does this dataset contain?  Seurat/R files are converted first."""
    src = Path(path).expanduser()
    if not src.exists():
        raise FileNotFoundError(f"{src} does not exist")
    if src.suffix.lower() not in ALLOWED_SUFFIXES:
        raise ValueError(f"{src.name}: expected an .h5ad or .rds/.RData file")

    import sys

    from .rds_io import ensure_h5ad, is_rds

    if is_rds(src):
        print(f"[add] converting {src} first (Seurat/R -> h5ad) ...", file=sys.stderr)
        h5 = ensure_h5ad(src, log=lambda line: print(f"[rds] {line}", file=sys.stderr))
        info = _discover_h5ad(h5)
        # keep the original file identity for the UI (the cache h5ad is an implementation detail)
        info["path"] = str(h5)
        info["filename"] = src.name
        info["suggested_id"] = unique_dataset_id(_id_from_stem(src.stem), existing=[])
        info["source_path"] = str(src)
        info["format"] = "rds"
        return info
    info = _discover_h5ad(src)
    info["format"] = "h5ad"
    return info


def _discover_h5ad(src: Path) -> dict[str, Any]:
    obs = read_obs(src)
    cells = read_index_column(src, "obs")
    n_cells = len(cells)
    if not n_cells:
        for col in obs.values():
            n_cells = len(col)
            break
    if not n_cells:
        raise ValueError(f"{src.name}: the file contains no cells")

    features = feature_names(src)
    n_features = len(features)

    groups: list[dict[str, Any]] = []
    others: list[dict[str, Any]] = []
    for name, col in obs.items():
        if name.startswith("_"):
            continue
        values = _value_strings(col)
        n_unique = len(set(values.tolist()))
        numeric = _is_numeric(col)
        if numeric:
            # quantitative metadata - a metric (and a grouping if it is coarse)
            others.append({"column": name, "kind": "numeric", "note": "quantitative (usable as a metric)"})
            if n_unique < 2 or n_unique > _CARDINALITY_LIMIT:
                continue
            if not _clean_group_column(name) or n_unique > max(64, n_cells // 2):
                continue
            groups.append(
                {
                    "column": name,
                    "name": name,
                    "label": guess_group_label(name),
                    "n_categories": int(n_unique),
                    "notes": "numeric",
                }
            )
            continue
        if not _clean_group_column(name):
            others.append({"column": name, "kind": "ignored", "note": "quality control column"})
            continue
        if n_unique < 2:
            others.append({"column": name, "kind": "ignored", "note": "constant"})
            continue
        if n_unique > _CARDINALITY_LIMIT:
            others.append({"column": name, "kind": "ignored", "note": f"{n_unique} distinct values"})
            continue
        groups.append(
            {
                "column": name,
                "name": name,
                "label": guess_group_label(name),
                "n_categories": int(n_unique),
                "notes": "categorical" if n_unique <= max(64, n_cells // 2) else "high cardinality",
            }
        )

    embeddings: list[dict[str, Any]] = []
    for key in list_obsm(src):
        arr = read_obsm(src, key)
        if arr is None or arr.ndim != 2 or arr.shape[1] < 2:
            continue
        if arr.shape[0] != n_cells:
            continue
        embeddings.append(
            {
                "obsm": key,
                "name": key,
                "label": guess_group_label(key),
                "kind": guess_embedding_kind(key),
            }
        )

    return {
        "path": str(src),
        "filename": src.name,
        "n_cells": int(n_cells),
        "n_features": int(n_features),
        "size_mb": round(src.stat().st_size / 1e6, 1),
        "groups": groups,
        "other_columns": others,
        "embeddings": embeddings,
        "suggested_id": unique_dataset_id(_id_from_stem(src.stem), existing=[]),
    }


def _is_numeric(col) -> bool:
    """True when the obs column holds numbers (a metric, not a grouping)."""
    import numpy as np

    arr = np.asarray(col)
    return arr.dtype.kind in "fiu"


def _value_strings(col) -> Any:  # numpy array
    import numpy as np

    arr = np.asarray(col)
    return arr.astype(str)


# --------------------------------------------------------------------------
# 2) add
# --------------------------------------------------------------------------


def _id_from_stem(stem: str) -> str:
    ident = re.sub(r"[^a-z0-9]+", "_", stem.lower()).strip("_")
    return ident[:48] or "dataset"


def unique_dataset_id(base: str, existing: list[str]) -> str:
    taken = set(existing)
    if base not in taken:
        return base
    i = 2
    while f"{base}_{i}" in taken:
        i += 1
    return f"{base}_{i}"


def read_auto_manifest(project) -> list[dict[str, Any]]:
    auto = Path(project.root) / "datasets.auto.yaml"
    if not auto.exists():
        return []
    try:
        with auto.open("r", encoding="utf-8") as fh:
            raw = yaml.safe_load(fh) or {}
    except yaml.YAMLError as exc:
        raise RuntimeError(f"{auto} is not valid YAML: {exc}") from exc
    entries = raw.get("datasets") if isinstance(raw, dict) else raw
    if not isinstance(entries, list):
        return []
    return [e for e in entries if isinstance(e, dict)]


def save_auto_manifest(project, entries: list[dict[str, Any]], removed: list[str] | None = None) -> Path:
    auto = Path(project.root) / "datasets.auto.yaml"
    with auto.open("w", encoding="utf-8") as fh:
        fh.write(
            "# Datasets added through the OmicsExplorer web UI.\n"
            "# They are merged into the project on every serve/build.\n"
            "# Datasets in 'removed' are hidden (deleted from the web UI).\n"
        )
        payload: dict[str, Any] = {"datasets": entries}
        if removed:
            payload["removed"] = sorted(set(removed))
        yaml.safe_dump(payload, fh, sort_keys=False, allow_unicode=True)
    return auto


def read_removed(project) -> list[str]:
    """The dataset ids that were deleted through the web UI."""
    auto = Path(project.root) / "datasets.auto.yaml"
    if not auto.exists():
        return []
    try:
        with auto.open("r", encoding="utf-8") as fh:
            raw = yaml.safe_load(fh) or {}
    except yaml.YAMError:
        return []
    if not isinstance(raw, dict):
        return []
    return [str(x) for x in (raw.get("removed") or [])]


def remove_dataset(project, ds_id: str, data_dir: Path | None = None) -> dict[str, Any]:
    """Hide one dataset and drop its built data.

    The entry is remembered in ``datasets.auto.yaml`` so the dataset does not
    come back on the next build - remove it from that list to restore it.
    """
    ds_id = str(ds_id or "").strip()
    if not ds_id:
        raise ValueError("missing 'id'")
    entries = [e for e in read_auto_manifest(project) if e.get("id") != ds_id]
    removed = read_removed(project)
    if ds_id not in removed:
        removed.append(ds_id)
    save_auto_manifest(project, entries, removed)

    # drop the built bundle of that dataset
    if data_dir is not None:
        target = Path(data_dir) / ds_id
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)

    # keep the live project.json / genes.json in sync
    pj = Path(data_dir) / "project.json" if data_dir else None
    if pj and pj.exists():
        try:
            payload = json.loads(pj.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            payload = {}
        payload["panels"] = [p for p in (payload.get("panels") or []) if p.get("id") != ds_id]
        pj.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        gj = pj.parent / "genes.json"
        if gj.exists():
            try:
                genes = json.loads(gj.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                genes = {}
            for entry in (genes.get("genes") or {}).values():
                if isinstance(entry, dict) and entry.get("panels"):
                    entry["panels"] = [p for p in entry["panels"] if p != ds_id]
            gj.write_text(json.dumps(genes, separators=(",", ":")), encoding="utf-8")
    return {"id": ds_id, "removed": removed}


def make_spec(project, params: dict[str, Any], log: Callable[[str], None]) -> DatasetSpec:
    src = Path(str(params.get("path", ""))).expanduser()
    if not src.exists():
        raise FileNotFoundError(f"{src} does not exist")

    import sys

    from .rds_io import ensure_h5ad, is_rds

    path = src
    if is_rds(src):
        log("Seurat/R object - converting first (cached for later runs)")
        path = ensure_h5ad(src, log)
        log(f"working from {path.name}")

    info = params.get("info") or discover(src)
    project_ids = list(project.ids) + [e.get("id", "") for e in read_auto_manifest(project)]
    ds_id = unique_dataset_id(_id_from_stem(str(params["id"]) if params.get("id") else src.stem), project_ids)

    group_columns = [str(g) for g in (params.get("groups") or [])]
    embedding_names = [str(e) for e in (params.get("embeddings") or [])]
    if not group_columns:
        group_columns = [g["column"] for g in info.get("groups", [])]
    if not embedding_names:
        embedding_names = [e["name"] for e in info.get("embeddings", [])]
    if not embedding_names:
        raise ValueError(f"{path.name}: no usable embedding found in obsm")

    groups = [
        GroupSpec(name=col, column=col, label=guess_group_label(col))
        for col in group_columns
    ]
    embeddings = [
        EmbeddingSpec(name=name, label=guess_group_label(name), kind=guess_embedding_kind(name), obsm=name, dims=(0, 1))
        for name in embedding_names
    ]
    kind = "spatial" if any(e.kind == "spatial" for e in embeddings) else "umap"
    log(f"dataset id: {ds_id} ({kind})")

    spec = DatasetSpec(
        id=ds_id,
        path=path,
        name=str(params.get("name") or src.stem),
        species=str(params.get("species") or ""),
        kind=kind,
        description=str(params.get("description") or f"Added via web UI on {date.today().isoformat()}"),
        groups=groups,
        embeddings=embeddings,
        units="um" if kind == "spatial" else None,
        default_group=groups[0].name if groups else None,
        default_embedding=embeddings[0].name if embeddings else None,
    )
    return spec


def spec_to_entry(spec: DatasetSpec) -> dict[str, Any]:
    return {
        "id": spec.id,
        "path": str(spec.path),
        "name": spec.name,
        "kind": spec.kind,
        "description": spec.description,
        "species": spec.species,
        "units": spec.units,
        "groups": {
            g.name: {"column": g.column, "label": g.label} for g in spec.groups
        },
        "embeddings": {
            e.name: {"obsm": e.obsm, "kind": e.kind, "label": e.label} for e in spec.embeddings
        },
    }


def append_auto_entry(spec: DatasetSpec, project) -> Path:
    entries = read_auto_manifest(project)
    entries = [e for e in entries if e.get("id") != spec.id]
    entries.append(spec_to_entry(spec))
    return save_auto_manifest(project, entries)


def register_built(project, data_dir: Path, payload: dict[str, Any]) -> None:
    """Append one built dataset to ``project.json`` / ``genes.json``."""
    import json

    project_payload: dict[str, Any] = {}
    pj = Path(data_dir) / "project.json"
    if pj.exists():
        with pj.open("r", encoding="utf-8") as fh:
            project_payload = json.load(fh)
    panels: list[dict[str, Any]] = list(project_payload.get("panels") or [])
    panel = {
        "id": payload["id"],
        "name": payload["name"],
        "species": payload["species"],
        "kind": payload["kind"],
        "description": payload["description"],
        "dir": f"data/{payload['id']}",
        "n_cells": payload["count"],
        "n_features": payload["features_count"],
        "groups": payload["obs"],
        "default_group": payload["default_group"],
        "embeddings": payload["embeddings"],
        "images": payload["images"],
        "samples": payload["samples"],
        "units": payload["units"],
        "bin_size": payload["bin_size"],
    }
    panels = [p for p in panels if p.get("id") != payload["id"]]
    panels.append(panel)
    project_payload["panels"] = panels
    _json_dump(pj, project_payload)

    gj = Path(data_dir) / "genes.json"
    genes: dict[str, dict[str, Any]] = {}
    if gj.exists():
        try:
            with gj.open("r", encoding="utf-8") as fh:
                genes = json.load(fh).get("genes", {})
        except Exception:
            genes = {}
    for feature in payload["features"]:
        entry = genes.setdefault(feature, {"panels": []})
        if payload["id"] not in entry["panels"]:
            entry["panels"].append(payload["id"])
    _json_dump(gj, {"genes": genes})


def add_dataset(project, data_dir: Path, params: dict[str, Any], log: Callable[[str], None] = print) -> dict[str, Any]:
    """The full pipeline: spec -> ``datasets.auto.yaml`` -> bundle -> project.json."""
    data_dir = Path(data_dir)
    spec = make_spec(project, params, log)
    entry_count = len(read_auto_manifest(project)) + 1
    log(f"saving to datasets.auto.yaml (entry {entry_count})")
    append_auto_entry(spec, project)

    log(f"converting {spec.path.name} ...")
    payload = build_dataset(spec, data_dir, log=log)
    log("registering in project.json / genes.json")
    register_built(project, data_dir, payload)
    log(f"done: dataset '{spec.id}' with {payload['count']:,} cells")
    return {
        "id": spec.id,
        "name": payload["name"],
        "n_cells": payload["count"],
        "n_features": payload["features_count"],
    }


# --------------------------------------------------------------------------
# 3) background jobs
# --------------------------------------------------------------------------


def start_add(project, data_dir: Path, params: dict[str, Any]) -> str:
    if not project:
        raise RuntimeError("the server was started without a project manifest")
    job_id = uuid.uuid4().hex[:12]
    job: dict[str, Any] = {
        "id": job_id,
        "status": "running",
        "log": [],
        "error": None,
        "dataset": None,
        "started": time.time(),
    }
    with _JOBS_LOCK:
        _JOBS[job_id] = job

    def run() -> None:
        def log(message: str) -> None:
            for line in str(message).splitlines():
                job["log"].append(line)

        try:
            job["dataset"] = add_dataset(project, Path(data_dir), params, log=log)
            job["status"] = "done"
        except Exception as exc:  # noqa: BLE001 - jobs report everything
            job["status"] = "error"
            job["error"] = f"{type(exc).__name__}: {exc}"
            traceback.print_exc()
        job["log"].append(f"[exit] {job['status']}")

    threading.Thread(target=run, daemon=True, name=f"oe-add-{job_id}").start()
    return job_id


def job_status(job_id: str) -> dict[str, Any] | None:
    job = _JOBS.get(job_id)
    if job is None:
        return None
    return {
        "id": job["id"],
        "status": job["status"],
        "log": list(job["log"]),
        "error": job["error"],
        "dataset": job["dataset"],
        "elapsed": round(time.time() - job["started"], 1),
    }
