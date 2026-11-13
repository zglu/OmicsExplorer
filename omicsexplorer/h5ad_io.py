"""Low level readers for AnnData ``.h5ad`` files.

``anndata``'s backed mode is convenient but it cannot slice a CSC encoded
matrix reliably, and we need direct control over the sparse layout so that the
expression matrix can be written out **gene major** (which is what the
``X.bin`` blob format expects).

This module therefore uses ``h5py`` for the matrix and ``anndata`` for the
metadata, which is where anndata's categorical / encoding handling really
earns its keep.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import h5py
import numpy as np

__all__ = [
    "SparseMatrix",
    "read_matrix",
    "read_obs",
    "read_var",
    "read_obsm",
    "read_uns",
    "read_index_column",
    "feature_names",
]


@dataclass
class SparseMatrix:
    """A gene-major sparse matrix (columns = genes, rows = cells)."""

    indptr: np.ndarray  # int64, length n_genes + 1
    indices: np.ndarray  # int32, cell index of every entry
    data: np.ndarray  # float32, value of every entry
    n_genes: int
    n_cells: int

    @property
    def nnz(self) -> int:
        return int(self.indices.size)

    def gene_slice(self, g: int) -> tuple[np.ndarray, np.ndarray]:
        a, b = int(self.indptr[g]), int(self.indptr[g + 1])
        return self.indices[a:b], self.data[a:b]


def _decode_categorical(group: h5py.Group) -> np.ndarray:
    """Resolve an h5ad categorical column (``categories`` + ``codes``)."""
    cats = group["categories"]
    codes = group["codes"]
    values = np.asarray(cats[:]).astype(str)
    idx = np.asarray(codes[:]).astype(np.int64)
    out = np.full(idx.shape, "", dtype=object)
    known = idx >= 0
    out[known] = values[idx[known]]
    return out.astype(str)


def _read_column(node: Any) -> np.ndarray:
    """Read one ``obs``/``var`` column into a 1-D numpy array."""
    if isinstance(node, h5py.Group):
        if "categories" in node and "codes" in node:
            return _decode_categorical(node)
        for key in ("array", "values", "X"):
            if key in node:
                return np.asarray(node[key][:]).ravel()
        # a group with a single dataset inside (anndata >= 0.13 encodings)
        datasets = [k for k in node.keys() if isinstance(node[k], h5py.Dataset)]
        if len(datasets) == 1:
            return np.asarray(node[datasets[0]][:]).ravel()
        raise ValueError(f"unsupported column group with keys {list(node.keys())}")
    data = node[:]
    arr = np.asarray(data)
    if arr.dtype.kind in ("S", "O", "U"):
        return arr.astype(str)
    return arr


def read_obs(path: str | Path) -> dict[str, np.ndarray]:
    """All ``obs`` columns as plain numpy arrays."""
    return _read_columns(path, "obs")


def read_var(path: str | Path) -> dict[str, np.ndarray]:
    """All ``var`` columns as plain numpy arrays."""
    return _read_columns(path, "var")


def _read_columns(path: str | Path, axis: str) -> dict[str, np.ndarray]:
    out: dict[str, np.ndarray] = {}
    with h5py.File(path, "r") as fh:
        if axis not in fh:
            return out
        grp = fh[axis]
        if not isinstance(grp, h5py.Group):
            return out
        for key in grp.keys():
            if key.startswith("_"):
                continue
            try:
                out[key] = _read_column(grp[key])
            except (ValueError, OSError, KeyError):
                continue
    return out


def read_index_column(path: str | Path, axis: str = "obs") -> np.ndarray:
    """The cell / gene identifiers stored in ``obs`` / ``var``."""
    with h5py.File(path, "r") as fh:
        grp = fh.get(axis)
        if isinstance(grp, h5py.Group) and "_index" in grp:
            node = grp["_index"]
            if isinstance(node, h5py.Group):
                # anndata >= 0.13 stores the index as a group (values + mask);
                # the mask marks the *missing* entries, not the valid ones
                values = node.get("values")
                if values is None:
                    values = node.get("array")
                if values is None:
                    return np.asarray([], dtype=str)
                out = np.asarray(values[:]).astype(str)
                mask = node.get("mask")
                if mask is not None:
                    missing = np.asarray(mask[:]).astype(bool)
                    if missing.size == out.size and missing.any():
                        out = out[~missing]
                return out
            return np.asarray(node[:]).astype(str)
    return np.asarray([], dtype=str)


def feature_names(path: str | Path, var: dict[str, np.ndarray] | None = None) -> list[str]:
    """Gene identifiers, preferring a ``real_gene_name`` style column."""
    if var is None:
        var = read_var(path)
    for key in ("real_gene_name", "gene_name", "gene_symbol", "symbol", "feature_name"):
        col = var.get(key)
        if col is None:
            continue
        names = np.asarray(col).astype(str)
        if names.size and all(n and n != "nan" for n in names):
            return [str(n) for n in names]
    idx = read_index_column(path, "var")
    if idx.size:
        return [str(n) for n in idx]
    raise ValueError(f"{path}: cannot determine gene names")


def read_obsm(path: str | Path, key: str) -> np.ndarray | None:
    """Read one ``obsm`` entry as a 2-D array (or ``None`` when missing)."""
    with h5py.File(path, "r") as fh:
        if "obsm" not in fh:
            return None
        grp = fh["obsm"]
        if key not in grp:
            return None
        node = grp[key]
        if isinstance(node, h5py.Group):
            for name in ("array", "X", "values"):
                if name in node:
                    node = node[name]
                    break
            else:
                return None
        arr = np.asarray(node[:])
        if arr.ndim == 1:
            arr = arr.reshape(-1, 1)
        return arr


def list_obsm(path: str | Path) -> list[str]:
    with h5py.File(path, "r") as fh:
        if "obsm" not in fh:
            return []
        return [k for k in fh["obsm"].keys() if not k.startswith("_")]


def read_uns(path: str | Path, key: str, default: Any = None) -> Any:
    """Read a simple value out of ``uns`` (scalars and small arrays only)."""
    with h5py.File(path, "r") as fh:
        if "uns" not in fh or key not in fh["uns"]:
            return default
        node = fh["uns"][key]
        if isinstance(node, h5py.Group):
            return default
        try:
            value = node[()]
        except (OSError, ValueError):
            return default
        if isinstance(value, bytes):
            return value.decode("utf-8", "replace")
        if isinstance(value, np.generic):
            value = value.item()
        if isinstance(value, np.ndarray) and value.size == 1:
            return value.ravel()[0]
        return value


def read_matrix(path: str | Path, layer: str | None = None) -> SparseMatrix:
    """Read the expression matrix and return it in **gene major** order.

    * ``csc_matrix`` encoding (shape ``n_obs x n_vars``) is already gene major.
    * ``csr_matrix`` encoding is transposed with a counting sort.
    * dense arrays are converted to CSC on the fly.
    """
    with h5py.File(path, "r") as fh:
        if layer:
            if "layers" not in fh or layer not in fh["layers"]:
                raise KeyError(f"{path}: no layer '{layer}'")
            node = fh["layers"][layer]
        else:
            if "X" not in fh:
                raise KeyError(f"{path}: no X matrix")
            node = fh["X"]

        encoding = node.attrs.get("encoding-type", "")
        if isinstance(encoding, bytes):
            encoding = encoding.decode("utf-8", "replace")
        encoding = str(encoding)
        shape = node.attrs.get("shape")
        if isinstance(node, h5py.Group):
            if encoding == "csc_matrix":
                return _csc_to_gene_major(node, shape)
            if encoding == "csr_matrix":
                return _csr_to_gene_major(node, shape)
            raise ValueError(f"{path}: unsupported sparse encoding '{encoding}'")
        arr = np.asarray(node[:])
        return _dense_to_gene_major(arr)


def _csc_to_gene_major(node: h5py.Dataset, shape: Any) -> SparseMatrix:
    """CSC with shape (n_cells, n_genes): column *g* is gene *g*."""
    n_cells, n_genes = (int(shape[0]), int(shape[1]))
    indptr = np.asarray(node["indptr"][:], dtype=np.int64)
    indices = np.asarray(node["indices"][:], dtype=np.int32)
    data = np.asarray(node["data"][:], dtype=np.float32)
    return SparseMatrix(indptr=indptr, indices=indices, data=data, n_genes=n_genes, n_cells=n_cells)


def _csr_to_gene_major(node: h5py.Dataset, shape: Any) -> SparseMatrix:
    """CSR with shape (n_cells, n_genes): transpose into gene major order."""
    n_cells, n_genes = (int(shape[0]), int(shape[1]))
    indptr = np.asarray(node["indptr"][:], dtype=np.int64)
    indices = np.asarray(node["indices"][:], dtype=np.int32)
    data = np.asarray(node["data"][:], dtype=np.float32)

    # the row (cell) index of every entry - the CSR indices are the *gene*
    # columns, so the transpose has to compute the rows itself
    rows = np.repeat(
        np.arange(n_cells, dtype=np.int32),
        np.diff(indptr).astype(np.int64),
    )
    if rows.size != indices.size:  # a corrupt indptr cannot be transposed
        raise ValueError(f"{node.name}: indptr does not match the entry count")

    # counting sort: group the entries by gene (column) index
    counts = np.bincount(indices.astype(np.int64), minlength=n_genes)
    out_indptr = np.zeros(n_genes + 1, dtype=np.int64)
    np.cumsum(counts, out=out_indptr[1:])
    order = np.argsort(indices, kind="stable")
    return SparseMatrix(
        indptr=out_indptr,
        indices=rows[order].astype(np.int32),
        data=data[order],
        n_genes=n_genes,
        n_cells=n_cells,
    )


def _dense_to_gene_major(arr: np.ndarray) -> SparseMatrix:
    n_cells, n_genes = arr.shape
    csc = arr.T.tocsc()  # genes x cells
    return SparseMatrix(
        indptr=csc.indptr.astype(np.int64),
        indices=csc.indices.astype(np.int32),
        data=csc.data.astype(np.float32),
        n_genes=n_genes,
        n_cells=n_cells,
    )
