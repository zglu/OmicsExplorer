"""Marker genes with Seurat style ROC statistics.

For every dataset and every grouping the module produces

* ``markers.json``            the top marker genes of every category with the
  statistics of Seurat's ``FindMarkers(test.use = "roc")``:

  ``myAUC``    area under the ROC curve (rank based, Seurat's formula)
  ``power``    ``myAUC - 0.5``
  ``log2fc``   ``log2`` of the mean ``expm1`` ratio (category vs the rest)
  ``pct1``     fraction of expressing cells in the category
  ``pct2``     fraction of expressing cells in the rest

* ``<dataset>/marker_stats.json``  the expression of every marker gene in
  *every* category of its grouping (``pct`` and ``mean``).  The dot plot needs
  this to show how specific a marker really is - a "tegument marker" can still
  be strongly expressed in parenchyma - and it avoids one range request per
  gene.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

import numpy as np

from .config import DatasetSpec, Project
from .h5ad_io import read_matrix, read_obs

__all__ = ["compute_markers", "markers_for_dataset", "MIN_AUC", "MAX_PCT2", "TOP_N"]

MIN_AUC = 0.7
MAX_PCT2 = 0.5
TOP_N = 50


def avg_ranks(values: np.ndarray) -> np.ndarray:
    """Average ranks (1-based) - the same tie handling as Seurat."""
    order = np.argsort(values, kind="stable")
    sv = values[order]
    n = sv.size
    ranks = np.empty(n, dtype=np.float64)
    i = 0
    while i < n:
        j = i
        while j + 1 < n and sv[j + 1] == sv[i]:
            j += 1
        ranks[i : j + 1] = (i + j) / 2.0 + 1.0
        i = j + 1
    out = np.empty(n, dtype=np.float64)
    out[order] = ranks
    return out


def _group_codes(cats: list[str], values: np.ndarray) -> np.ndarray:
    lookup = {c: i for i, c in enumerate(cats)}
    out = np.full(len(values), -1, dtype=np.int32)
    for i, v in enumerate(values):
        j = lookup.get(v)
        if j is not None:
            out[i] = j
    return out


def markers_for_dataset(
    ds: DatasetSpec,
    groups: Iterable[str],
    *,
    min_auc: float = MIN_AUC,
    max_pct2: float = MAX_PCT2,
    top_n: int = TOP_N,
    log=print,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return ``(markers_by_group, stats_by_group)`` for one dataset."""
    groups = [g for g in groups if g]
    if not groups:
        return {}, {}

    log(f"[{ds.id}] reading expression")
    matrix = read_matrix(ds.path, ds.layer)
    obs = read_obs(ds.path)
    n_cells = matrix.n_cells
    features = list(matrix_features(ds.path))

    codes_by_group: dict[str, np.ndarray] = {}
    cats_by_group: dict[str, list[str]] = {}
    for group in groups:
        column = ds.group(group).column if ds.group(group) else group
        if column not in obs:
            log(f"[{ds.id}]  ! group '{group}' not in obs - skipped")
            continue
        values = obs[column].astype(str)
        cats = sorted(set(values.tolist()), key=_natural)
        cats_by_group[group] = cats
        codes_by_group[group] = _group_codes(cats, values)

    if not codes_by_group:
        return {}, {}

    size = {
        g: np.bincount(
            codes_by_group[g][codes_by_group[g] >= 0], minlength=len(cats_by_group[g])
        ).astype(np.float64)
        for g in codes_by_group
    }

    n_genes = matrix.n_genes
    pct_all = {g: np.zeros((n_genes, len(cats_by_group[g])), dtype=np.float32) for g in codes_by_group}
    mean_all = {g: np.zeros((n_genes, len(cats_by_group[g])), dtype=np.float32) for g in codes_by_group}
    per_group: dict[str, dict[str, list[dict]]] = {
        g: {c: [] for c in cats_by_group[g]} for g in codes_by_group
    }

    for gi in range(n_genes):
        cells, vals = matrix.gene_slice(gi)
        n = cells.size
        if n == 0:
            continue
        cells = cells.astype(np.int64)
        vals = vals.astype(np.float64)
        z = n_cells - n
        r_nz = avg_ranks(vals)
        g_rank = z + r_nz
        expm1 = np.expm1(vals)

        for group, codes in codes_by_group.items():
            ncats = len(cats_by_group[group])
            c = codes[cells]
            valid = c >= 0
            if not valid.any():
                continue
            cc = c[valid]
            v = vals[valid]
            e = expm1[valid]
            gr = g_rank[valid]
            tot1 = size[group]
            tot_valid = float(tot1.sum())
            det1 = np.bincount(cc, minlength=ncats).astype(np.float64)
            det_total = float(det1.sum())
            nzero = tot1 - det1
            sum_rank = np.bincount(cc, weights=gr, minlength=ncats) + nzero * ((z + 1) / 2.0)
            sum_val = np.bincount(cc, weights=v, minlength=ncats)
            sum_expm1 = np.bincount(cc, weights=e, minlength=ncats)
            tot2 = tot_valid - tot1
            with np.errstate(divide="ignore", invalid="ignore"):
                auc = (sum_rank - tot1 * (tot1 + 1) / 2.0) / np.maximum(tot1 * tot2, 1)
                mean_expm1 = sum_expm1 / np.maximum(tot1, 1)
                rest_expm1 = (sum_expm1.sum() - sum_expm1) / np.maximum(tot2, 1)
                log2fc = np.log2(np.maximum(mean_expm1, 1e-12) / np.maximum(rest_expm1, 1e-12))
            pct1 = det1 / np.maximum(tot1, 1)
            pct2 = (det_total - det1) / np.maximum(tot2, 1)
            mean = sum_val / np.maximum(tot1, 1)
            pct_all[group][gi] = pct1
            mean_all[group][gi] = mean

            for ci in range(ncats):
                if det1[ci] < 3 or tot1[ci] < 3:
                    continue
                rec = {
                    "gene": features[gi],
                    "myAUC": float(auc[ci]),
                    "power": float(auc[ci] - 0.5),
                    "log2fc": float(log2fc[ci]),
                    "pct1": float(pct1[ci]),
                    "pct2": float(pct2[ci]),
                    "mean": float(mean[ci]),
                }
                if rec["myAUC"] >= min_auc and rec["pct2"] < max_pct2:
                    per_group[group][cats_by_group[group][ci]].append(rec)

    markers: dict[str, Any] = {}
    for group in codes_by_group:
        markers[group] = {}
        for cat, recs in per_group[group].items():
            recs.sort(key=lambda r: (-r["myAUC"], -r["log2fc"]))
            markers[group][cat] = recs[:top_n]

    stats: dict[str, Any] = {}
    for group in codes_by_group:
        cats = cats_by_group[group]
        union: list[str] = []
        seen: set[str] = set()
        for cat in cats:
            for rec in markers[group].get(cat, [])[:top_n]:
                if rec["gene"] not in seen:
                    seen.add(rec["gene"])
                    union.append(rec["gene"])
        row_of = {f: i for i, f in enumerate(features)}
        rows = [row_of[g] for g in union if g in row_of]
        pct = pct_all[group][rows] if rows else np.zeros((0, len(cats)), dtype=np.float32)
        mean = mean_all[group][rows] if rows else np.zeros((0, len(cats)), dtype=np.float32)
        stats[group] = {
            "cats": list(cats),
            "genes": [g for g in union if g in row_of],
            "pct": [[round(float(v), 4) for v in row] for row in pct],
            "mean": [[round(float(v), 4) for v in row] for row in mean],
        }
    return markers, stats


def matrix_features(path: Path) -> list[str]:
    from .h5ad_io import feature_names

    return feature_names(path)


def _natural(text: str) -> list:
    import re

    return [int(p) if p.isdigit() else p.lower() for p in re.split(r"(\d+)", str(text))]


def compute_markers(
    project: Project,
    out_dir: Path,
    *,
    only: Iterable[str] | None = None,
    groups: Iterable[str] | None = None,
    log=print,
) -> dict[str, Any]:
    """Compute the markers of every dataset of a project."""
    out_dir = Path(out_dir)
    only_set = set(only) if only else None
    all_markers: dict[str, Any] = {}
    for ds in project.datasets:
        if only_set and ds.id not in only_set:
            continue
        wanted = list(groups) if groups else [g.name for g in ds.groups]
        markers, stats = markers_for_dataset(ds, wanted, log=log)
        if not markers:
            continue
        all_markers[ds.id] = markers
        path = out_dir / ds.id / "marker_stats.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(stats, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        ncat = sum(len(v) for grp in markers.values() for v in grp.values())
        log(f"[{ds.id}] {ncat} categories with markers ({path.stat().st_size // 1024} KB stats)")

    path = out_dir / "markers.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"panels": all_markers}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    log(f"wrote {path} ({path.stat().st_size // 1024} KB)")
    return all_markers
