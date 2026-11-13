"""Convert AnnData files into the static *bundle* format used by the web app.

A bundle looks like this::

    data/
      project.json          datasets, species, ontology
      genes.json            gene search index
      <dataset>/
        index.json          metadata: features, embeddings, groups, images
        X.bin               gene major expression blob
        X.index.json        byte offsets of every gene inside X.bin
        obs/<group>.parquet one string column "value" per cell
        obs/index.parquet   cell identifiers
        obsm/<emb>.parquet  two float32 columns "<emb>_1" / "<emb>_2"

The format is deliberately identical to the ``nematode-atlas`` layout (plus a
few extra fields), so existing tooling keeps working.
"""

from __future__ import annotations

import json
import math
import re
import shutil
from dataclasses import asdict
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from . import blob
from .config import (
    DatasetSpec,
    EmbeddingSpec,
    GroupSpec,
    Project,
    guess_embedding_kind,
    guess_group_label,
    load_project,
)
from .spatial import analyse_spatial, image_transform, read_spatial_uns
from .h5ad_io import (
    feature_names,
    list_obsm,
    read_index_column,
    read_matrix,
    read_obs,
    read_obsm,
    read_uns,
    read_var,
)

__all__ = ["build_dataset", "build_project", "natural_key", "BundleError"]


class BundleError(RuntimeError):
    pass


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------


def natural_key(text: str) -> list:
    """Sort key that orders ``cluster 2`` before ``cluster 10``."""
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", str(text))]


def _write_parquet(path: Path, columns: dict[str, np.ndarray]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    table = pa.table({name: pa.array(col) for name, col in columns.items()})
    pq.write_table(table, path, compression="snappy")


def _json_dump(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    gz = path.with_suffix(path.suffix + ".gz")
    with gzip_open_text(gz) as fh:
        json.dump(payload, fh, separators=(",", ":"))


def gzip_open_text(path: Path):
    import gzip

    return gzip.open(path, "wt", encoding="utf-8")


def _as_str_array(values: np.ndarray) -> np.ndarray:
    """Normalise an obs column into clean strings."""
    arr = np.asarray(values)
    if arr.dtype.kind in ("S", "O", "U"):
        out = arr.astype(str)
    else:
        out = arr.astype(str)
    out = np.where(out == "nan", "", out)
    return out


def _numeric_array(values: np.ndarray) -> np.ndarray:
    arr = np.asarray(values)
    if arr.dtype.kind in ("S", "O", "U"):
        return arr.astype(str).astype(np.float64)
    return arr.astype(np.float64)


# --------------------------------------------------------------------------
# auto-detection
# --------------------------------------------------------------------------


def _numeric_metrics(
    obs: dict[str, np.ndarray],
    used: set[str],
    cells: int,
    limit: int = 64,
) -> list[tuple[str, np.ndarray, float, float]]:
    """The quantitative obs columns (nCount_RNA, signature scores, ...).

    They are not groupings - they are continuous values that can be used to
    colour the cells.
    """
    out: list[tuple[str, np.ndarray, float, float]] = []
    for name, col in obs.items():
        if name.startswith("_") or name in used:
            continue
        arr = np.asarray(col)
        if arr.dtype.kind not in "fiu" or arr.size != cells:
            continue
        vals = arr.astype("float64", copy=False)
        finite = vals[np.isfinite(vals)]
        if finite.size == 0:
            continue
        lo = float(finite.min())
        hi = float(finite.max())
        if hi - lo < 1e-12:
            continue  # constant - nothing to show
        out.append((name, vals, lo, hi))
        if len(out) >= limit:
            break
    return out


def _auto_groups(obs: dict[str, np.ndarray], cells: int) -> list[GroupSpec]:
    """Pick low-cardinality obs columns that make sense as groupings."""
    groups: list[GroupSpec] = []
    for name, col in obs.items():
        if name.startswith("_"):
            continue
        values = _as_str_array(col)
        n_unique = len(np.unique(values))
        if n_unique < 2:
            continue
        if n_unique > max(64, cells // 2):
            continue
        groups.append(GroupSpec(name=name, column=name, label=guess_group_label(name)))
    return groups


def _auto_embeddings(path: Path, obs: dict[str, np.ndarray]) -> list[EmbeddingSpec]:
    """Find 2-D embeddings in ``obsm``."""
    keys = list_obsm(path)
    out: list[EmbeddingSpec] = []
    for key in keys:
        arr = read_obsm(path, key)
        if arr is None or arr.ndim != 2 or arr.shape[1] < 2:
            continue
        kind = guess_embedding_kind(key)
        out.append(
            EmbeddingSpec(
                name=key,
                label=guess_group_label(key),
                kind=kind,
                obsm=key,
                dims=(0, 1),
            )
        )
    return out


# --------------------------------------------------------------------------
# dataset build
# --------------------------------------------------------------------------


def _resolve_embedding(
    path: Path,
    spec: EmbeddingSpec,
    obs: dict[str, np.ndarray],
    n_cells: int,
) -> np.ndarray | None:
    """Return an ``(n, 2)`` float32 array for one embedding."""
    if spec.obs:
        cols = []
        for name in spec.obs:
            if name not in obs:
                return None
            cols.append(_numeric_array(obs[name]))
        x, y = cols
        return np.column_stack([x, y]).astype(np.float32)

    key = spec.obsm or spec.name
    arr = read_obsm(path, key)
    if arr is None:
        return None
    arr = np.asarray(arr, dtype=np.float32)
    if arr.ndim != 2:
        return None
    d0, d1 = spec.dims
    if d1 >= arr.shape[1]:
        return None
    if arr.shape[0] != n_cells:
        # some files store the transpose
        if arr.shape[1] == n_cells:
            arr = arr.T
        else:
            return None
    return np.column_stack([arr[:, d0], arr[:, d1]]).astype(np.float32)


def _grid_info(xy: np.ndarray) -> dict[str, Any]:
    """Describe the geometry of a coordinate array.

    A *bin* dataset (Stereo-seq bin50, Visium spots) has exactly one cell per
    grid position, so its cells can be drawn as tiles that cover the tissue
    seamlessly.  A *cell* dataset (cellbin, Xenium) puts several cells on the
    same position, and those have to be drawn as small dots.
    """
    n = int(xy.shape[0])
    if n == 0:
        return {"is_grid": False, "pitch": 0.0, "max_per_position": 0}
    xs = np.unique(xy[:, 0])
    ys = np.unique(xy[:, 1])
    _, counts = np.unique(xy, axis=0, return_counts=True)
    max_per_position = int(counts.max())

    def _pitch(values: np.ndarray) -> float:
        if values.size < 2:
            return 0.0
        diffs = np.diff(values)
        diffs = diffs[diffs > 0]
        return float(np.median(diffs)) if diffs.size else 0.0

    px, py = _pitch(xs), _pitch(ys)
    pitch = min(px, py) if px and py else max(px, py)
    # A lattice dataset has far fewer distinct x (and y) values than cells -
    # that is what distinguishes a 50 um bin grid from individual cells.
    coarse = xs.size <= max(2, n / 4) and ys.size <= max(2, n / 4)
    is_grid = bool(coarse and pitch > 0)
    return {
        "is_grid": is_grid,
        "pitch": float(pitch),
        "max_per_position": max_per_position,
        "unique_x": int(xs.size),
        "unique_y": int(ys.size),
    }


def _pick_group(requested: str | None, groups: list[GroupSpec]) -> str | None:
    """The default grouping, falling back to the first available one.

    ``default_group`` in the manifest may name either a grouping or the obs
    column behind it, so both are accepted.
    """
    if not groups:
        return None
    names = {g.name for g in groups}
    columns = {g.column for g in groups}
    if requested and requested in names:
        return requested
    if requested and requested in columns:
        for g in groups:
            if g.column == requested:
                return g.name
    return groups[0].name


def _pick_embedding(requested: str | None, embeddings: list[EmbeddingSpec]) -> str | None:
    if not embeddings:
        return None
    names = {e.name for e in embeddings}
    if requested and requested in names:
        return requested
    return embeddings[0].name


def build_dataset(
    ds: DatasetSpec,
    out_dir: Path,
    *,
    max_features: int | None = None,
    max_cells: int | None = None,
    marker_groups: Iterable[str] | None = None,
    log=print,
) -> dict:
    """Build one dataset directory and return its ``index.json`` payload."""
    if not ds.path.exists():
        raise BundleError(f"dataset '{ds.id}': file not found: {ds.path}")

    log(f"[{ds.id}] reading {ds.path}")
    obs = read_obs(ds.path)
    var = read_var(ds.path)
    cells = read_index_column(ds.path, "obs")
    features = feature_names(ds.path, var)

    n_cells = len(cells)
    if n_cells == 0:
        for col in obs.values():
            n_cells = len(col)
            break
    n_genes = len(features)

    # ---- groups ---------------------------------------------------------
    groups = list(ds.groups)
    if not groups:
        groups = _auto_groups(obs, n_cells)
    resolved_groups: list[GroupSpec] = []
    categories: dict[str, list[str]] = {}
    for g in groups:
        if g.column not in obs:
            log(f"[{ds.id}]  ! group '{g.name}' (column '{g.column}') not in obs - skipped")
            continue
        values = _as_str_array(obs[g.column])
        if len(values) != n_cells:
            log(f"[{ds.id}]  ! group '{g.name}' length mismatch - skipped")
            continue
        cats = sorted(set(values.tolist()), key=natural_key)
        categories[g.name] = cats
        resolved_groups.append(g)
    groups = resolved_groups

    # ---- embeddings -----------------------------------------------------
    embeddings = list(ds.embeddings)
    if not embeddings:
        embeddings = _auto_embeddings(ds.path, obs)
    resolved_embeddings: list[EmbeddingSpec] = []
    emb_arrays: dict[str, np.ndarray] = {}
    for e in embeddings:
        arr = _resolve_embedding(ds.path, e, obs, n_cells)
        if arr is None:
            log(f"[{ds.id}]  ! embedding '{e.name}' not found - skipped")
            continue
        emb_arrays[e.name] = arr
        resolved_embeddings.append(e)
    embeddings = resolved_embeddings
    if not embeddings:
        raise BundleError(f"dataset '{ds.id}': no usable embedding found")

    # ---- matrix ---------------------------------------------------------
    matrix = read_matrix(ds.path, ds.layer)
    n_cells = matrix.n_cells
    n_genes = matrix.n_genes
    if len(features) != n_genes:
        # features list came from var_names; align it with the matrix
        if len(features) < n_genes:
            features = list(features) + [f"feature_{i}" for i in range(len(features), n_genes)]
        else:
            features = features[:n_genes]

    ds_dir = out_dir / ds.id
    ds_dir.mkdir(parents=True, exist_ok=True)

    log(f"[{ds.id}] writing expression blob ({matrix.nnz:,} entries)")
    index = blob.write_x_blob(
        ds_dir / "X.bin",
        features,
        matrix.indices,
        matrix.data,
        matrix.indptr,
        n_cells=n_cells,
    )

    # ---- quantitative obs (nCount_RNA, signature scores, ...) -------------
    metrics = _numeric_metrics(obs, {g.column for g in groups}, n_cells)
    for name, values, _lo, _hi in metrics:
        _write_parquet(ds_dir / "obs" / f"{name}.parquet", {"value": values.astype(np.float64)})

    # ---- obs parquet ----------------------------------------------------
    for g in groups:
        values = _as_str_array(obs[g.column])
        _write_parquet(ds_dir / "obs" / f"{g.name}.parquet", {"value": values})
    _write_parquet(ds_dir / "obs" / "index.parquet", {"value": cells.astype(str) if len(cells) else np.array([], dtype=str)})

    # ---- obsm parquet ---------------------------------------------------
    for name, arr in emb_arrays.items():
        _write_parquet(
            ds_dir / "obsm" / f"{name}.parquet",
            {f"{name}_1": arr[:, 0].astype(np.float32), f"{name}_2": arr[:, 1].astype(np.float32)},
        )

    # ---- images ---------------------------------------------------------
    images = []
    for img in ds.images:
        src = Path(img.path)
        if not src.exists():
            log(f"[{ds.id}]  ! image not found: {src}")
            continue
        rel = Path("img") / f"{ds.id}__{src.name}"
        (out_dir / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, out_dir / rel)
        images.append(
            {
                "path": str(rel).replace("\\", "/"),
                "label": img.display,
                "transform": img.transform or {},
            }
        )

    # a spatial h5ad (Visium) carries the tissue image inside the file
    spatial_info: dict[str, Any] = {}
    if not images:
        try:
            spatial_info = read_spatial_uns(ds.path)
        except (OSError, ValueError, KeyError):
            spatial_info = {}
        if spatial_info.get("image") is not None:
            from .spatial import _png_bytes

            rel = Path("img") / f"{ds.id}__tissue_hires.png"
            (out_dir / rel).parent.mkdir(parents=True, exist_ok=True)
            (out_dir / rel).write_bytes(_png_bytes(spatial_info["image"]))
            images.append(
                {
                    "path": str(rel).replace("\\", "/"),
                    "label": "Tissue image",
                    "transform": {},
                }
            )
            log(f"[{ds.id}] extracted the tissue image from the h5ad")

    # ---- the geometry of every embedding --------------------------------
    grids: dict[str, dict[str, Any]] = {
        e.name: _grid_info(emb_arrays[e.name]) for e in embeddings
    }

    # ---- spatial extras (spot size + the image transform) ---------------
    if spatial_info.get("scalefactors") and images:
        for e in embeddings:
            if e.kind != "spatial":
                continue
            xy = emb_arrays.get(e.name)
            if xy is None or xy.size == 0:
                continue
            info = analyse_spatial(
                xy,
                spatial_info["scalefactors"],
                image_shape=spatial_info.get("image_shape") or (0, 0),
                fullres_shape=spatial_info.get("fullres_shape") or (0, 0),
            )
            um_per_data = info["um_per_data"]
            if um_per_data and abs(um_per_data - 1.0) > 1e-6:
                # the coordinates are in pixels - use microns everywhere so that
                # the scale bar and the image alignment are correct
                emb_arrays[e.name] = xy * um_per_data
                grids[e.name] = _grid_info(emb_arrays[e.name])
                # the median difference of the sorted coordinates is useless for
                # the hexagonal Visium layout - use the distance to the nearest
                # neighbour instead (the real grid pitch)
                grids[e.name]["pitch"] = float(info["pitch"] * um_per_data)
            size = info["size"]
            if size > 0:
                grids[e.name]["size"] = float(size)
                grids[e.name]["space"] = info["space"]
                # spots with a gap (Visium) are round, contiguous bins are square
                pitch = float(grids[e.name].get("pitch") or 0)
                grids[e.name]["shape"] = (
                    "circle" if (pitch > 0 and size < pitch * 0.95) else "square"
                )
            tr = image_transform(info)
            if tr:
                images[-1]["transform"] = tr
                grids[e.name]["image_transform"] = tr
                log(
                    f"[{ds.id}] spatial grid: pitch {info['pitch']:.1f} um, spot {size:.1f} um "
                    f"({info['space']}), image transform {tr}"
                )

    # ---- index.json -----------------------------------------------------
    samples: list[dict[str, Any]] = []
    sample_group = next((g for g in groups if g.name == "sample"), None)
    if sample_group:
        counts = np.zeros(len(categories[sample_group.name]), dtype=np.int64)
        values = _as_str_array(obs[sample_group.column])
        lookup = {c: i for i, c in enumerate(categories[sample_group.name])}
        for v in values:
            counts[lookup.get(v, -1)] += 1 if v in lookup else 0
        samples = [
            {"id": cat, "label": cat, "n": int(n)}
            for cat, n in zip(categories[sample_group.name], counts)
            if n
        ]

    bin_size = ds.bin_size
    if bin_size is None:
        for key in ("bin_size", "bin_size_um", "bin"):
            value = read_uns(ds.path, key)
            if isinstance(value, (int, float)) and value > 0:
                bin_size = float(value)
                break
        if bin_size is None:
            bt = read_uns(ds.path, "bin_type")
            if isinstance(bt, str):
                m = re.search(r"(\d+)", bt)
                if m:
                    bin_size = float(m.group(1))

    payload = {
        "id": ds.id,
        "name": ds.display,
        "species": ds.species,
        "kind": ds.kind,
        "description": ds.description,
        "count": int(n_cells),
        "features": features,
        "features_count": int(n_genes),
        "embeddings": [
            {
                "name": e.name,
                "label": e.display,
                "kind": e.kind,
                "columns": [f"{e.name}_1", f"{e.name}_2"],
                "grid": grids.get(e.name, {}),
            }
            for e in embeddings
        ],
        "obs": [g.name for g in groups],
        "categories": categories,
        "metrics": [
            {
                "name": name,
                "min": lo,
                "max": hi,
                "mean": float(np.nanmean(values)),
            }
            for name, values, lo, hi in metrics
        ],
        "samples": samples,
        "images": images,
        "units": ds.units or ("um" if any(e.kind == "spatial" for e in embeddings) else None),
        "bin_size": bin_size,
        "default_group": _pick_group(ds.default_group, groups),
        "default_embedding": _pick_embedding(ds.default_embedding, embeddings),
        "scale": index["scale"],
        "codec": "gz-uint16",
    }
    _json_dump(ds_dir / "index.json", payload)
    log(
        f"[{ds.id}] done: {n_cells:,} cells x {n_genes:,} genes, "
        f"{len(groups)} groups, {len(embeddings)} embeddings, "
        f"{len(metrics)} metrics"
    )
    return payload


# --------------------------------------------------------------------------
# project build
# --------------------------------------------------------------------------


_SOURCE_RE = re.compile(r"\s*\[Source:.*$")


def _read_gene_details(path: Path) -> dict[str, str]:
    """Read a ``gene id <tab> product`` table (or a two column CSV/TSV).

    The header line of a BioMart export ("Gene stable ID<TAB>Gene
    description") is skipped, and the trailing ``[Source:...]`` annotation is
    removed from the product.
    """
    out: dict[str, str] = {}
    if not path.exists():
        return out
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        for lineno, line in enumerate(fh):
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 2:
                parts = [p.strip('"') for p in line.split(",")]
            if len(parts) < 2:
                continue
            gene = parts[0].strip().strip('"')
            product = parts[1].strip().strip('"')
            if lineno == 0 and (" " in gene or "description" in line.lower()):
                continue  # header line
            if gene and product:
                out[gene] = _SOURCE_RE.sub("", product).strip()
    return out


def _panel_from_bundle(ds: DatasetSpec, out_dir: Path) -> dict[str, Any] | None:
    """The panel of a previously built dataset (kept when the source is gone)."""
    path = out_dir / ds.id / "index.json"
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except (OSError, ValueError):
        return None
    return {
        "id": payload["id"],
        "name": payload["name"],
        "species": payload["species"],
        "kind": payload["kind"],
        "description": payload["description"],
        "dir": f"data/{ds.id}",
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


def build_project(
    project: Project,
    out_dir: Path,
    *,
    only: Iterable[str] | None = None,
    log=print,
) -> dict:
    """Build every dataset of a project plus the project level indexes."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    only_set = set(only) if only else None
    datasets = []
    gene_index: dict[str, dict[str, Any]] = {}
    for ds in project.datasets:
        if only_set and ds.id not in only_set:
            # not selected: keep its previously built bundle in the indexes
            panel = _panel_from_bundle(ds, out_dir)
            if panel is None:
                log(f"[{ds.id}] - not selected, no built data (skipped)")
                continue
            datasets.append(panel)
            with (out_dir / ds.id / "index.json").open("r", encoding="utf-8") as fh:
                features = (json.load(fh).get("features") or [])
            for feature in features:
                entry = gene_index.setdefault(feature, {"panels": []})
                if ds.id not in entry["panels"]:
                    entry["panels"].append(ds.id)
            continue
        if not ds.path.exists():
            # the source file is gone (deleted by hand, unmounted volume, ...):
            # keep the previously built bundle instead of failing the build
            panel = _panel_from_bundle(ds, out_dir)
            if panel is None:
                log(f"[{ds.id}] ! source file not found and no built data - skipped: {ds.path}")
                continue
            log(f"[{ds.id}] ! source file not found ({ds.path}) - keeping the built data")
            datasets.append(panel)
            with (out_dir / ds.id / "index.json").open("r", encoding="utf-8") as fh:
                features = (json.load(fh).get("features") or [])
            for feature in features:
                entry = gene_index.setdefault(feature, {"panels": []})
                if ds.id not in entry["panels"]:
                    entry["panels"].append(ds.id)
            continue
        payload = build_dataset(ds, out_dir, log=log)
        datasets.append(
            {
                "id": payload["id"],
                "name": payload["name"],
                "species": payload["species"],
                "kind": payload["kind"],
                "description": payload["description"],
                "dir": f"data/{ds.id}",
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
        )
        for feature in payload["features"]:
            entry = gene_index.setdefault(feature, {"panels": []})
            if ds.id not in entry["panels"]:
                entry["panels"].append(ds.id)

    project_payload = {
        "name": project.name,
        "subtitle": project.subtitle,
        "data_dir": "data",
        "species": project.species,
        "ontology": {"cell_types": project.ontology},
        "panels": datasets,
    }
    _json_dump(out_dir / "project.json", project_payload)
    _json_dump(out_dir / "genes.json", {"genes": gene_index})

    # gene descriptions (optional) - they make the search box much more useful
    details: dict[str, str] = {}
    for ds in project.datasets:
        if ds.gene_details:
            details.update(_read_gene_details(ds.gene_details))
    if details:
        _json_dump(out_dir / "gene_details.json", {g: {"product": p} for g, p in details.items()})
        log(f"gene descriptions: {len(details)} entries")
    log(f"project '{project.name}': {len(datasets)} dataset(s) -> {out_dir}")
    return project_payload
