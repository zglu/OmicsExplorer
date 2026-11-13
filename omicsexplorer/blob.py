"""The ``X.bin`` expression blob codec.

``X.bin`` is a *gene major* container for a sparse expression matrix.  The
browser can therefore fetch a single gene with **one HTTP range request** and
inflate it with the native ``DecompressionStream('gzip')`` - no server-side
decompression and no full-matrix download.

Layout::

    X.bin = gzip_member(gene_0) || gzip_member(gene_1) || ...

Each member, after inflation, holds three consecutive parts:

    1. varint stream of the cell-index deltas (the first delta is index + 1)
    2. plane A - the high byte of the quantised value   (n bytes)
    3. plane B - the low  byte of the quantised value   (n bytes)

The quantised value is reconstructed as ``value = (A << 8 | B) * scale`` with a
single global ``scale = max_value / 65535`` stored in ``X.index.json``.

Splitting the 16 bit values into two byte planes lets gzip collapse the (nearly
constant) high bytes, which roughly halves the blob size.

``X.index.json``::

    {"n": <cells>, "scale": <float>,
     "genes": {"<feature>": [byte_offset, compressed_len, n_entries]}}

This format is byte-compatible with the ``nematode-atlas`` project, so blobs
written here can be read by that app and vice versa.
"""

from __future__ import annotations

import gzip
import io
import json
from pathlib import Path
from typing import Sequence

import numpy as np

__all__ = [
    "GZIP_LEVEL",
    "encode_gene_block",
    "write_x_blob",
    "decode_gene_block",
    "read_index",
    "read_gene_block",
]

GZIP_LEVEL = 9


# --------------------------------------------------------------------------
# encoding
# --------------------------------------------------------------------------


def _gzip_block(payload: bytes) -> bytes:
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=GZIP_LEVEL, mtime=0) as gz:
        gz.write(payload)
    return buf.getvalue()


def _varint_encode(deltas: np.ndarray) -> bytes:
    """Base-128 varint of a non-negative int array."""
    out = bytearray()
    for d in deltas:
        v = int(d)
        while v >= 0x80:
            out.append((v & 0x7F) | 0x80)
            v >>= 7
        out.append(v)
    return bytes(out)


def _varint_decode(payload: bytes, count: int) -> tuple[np.ndarray, int]:
    """Inverse of :func:`_varint_encode`; returns the values and bytes read."""
    out = np.zeros(count, dtype=np.int64)
    pos = 0
    acc = 0
    shift = 0
    produced = 0
    end = len(payload)
    while produced < count and pos < end:
        byte = payload[pos]
        pos += 1
        acc |= (byte & 0x7F) << shift
        if byte & 0x80:
            shift += 7
            continue
        out[produced] = acc
        produced += 1
        acc = 0
        shift = 0
    if produced != count:
        raise ValueError(f"varint stream ended after {produced} of {count} values")
    return out, pos


def encode_gene_block(cells: np.ndarray, values: np.ndarray, scale: float) -> bytes:
    """Encode one gene's entries into the on-disk block format (pre-gzip)."""
    cells = np.asarray(cells)
    values = np.asarray(values)
    if cells.size != values.size:
        raise ValueError("cells and values must have the same length")
    if cells.size == 0:
        return b""
    q = np.rint(values.astype(np.float64) / scale).astype("<u2")
    deltas = np.diff(cells.astype(np.int64), prepend=np.int64(-1)) + 1
    return b"".join(
        [
            _varint_encode(deltas),
            (q >> 8).astype(np.uint8).tobytes(),
            (q & 0xFF).astype(np.uint8).tobytes(),
        ]
    )


def write_x_blob(
    out_path: Path,
    features: Sequence[str],
    cell_indices: np.ndarray,
    values: np.ndarray,
    indptr: np.ndarray,
    n_cells: int,
    scale: float | None = None,
) -> dict:
    """Write ``X.bin`` + ``X.index.json`` from a gene-major sparse matrix.

    Parameters
    ----------
    features
        Gene names, in the order of the matrix columns.
    cell_indices
        Cell index of every stored entry (concatenated over all genes).
    values
        Expression value of every stored entry (same length as ``cell_indices``).
    indptr
        Length ``len(features) + 1``; gene *g* owns
        ``cell_indices[indptr[g]:indptr[g + 1]]``.
    n_cells
        Number of cells in the dataset.
    scale
        Quantisation step. Defaults to ``max(values) / 65535``.
    """
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    cell_indices = np.asarray(cell_indices)
    values = np.asarray(values)
    indptr = np.asarray(indptr, dtype=np.int64)
    if indptr.size != len(features) + 1:
        raise ValueError("indptr length must be len(features) + 1")

    if scale is None:
        scale = float(values.max()) / 65535.0 if values.size else 1.0
    scale = float(scale)
    if scale <= 0:
        scale = 1.0
    if cell_indices.size:
        if int(cell_indices.max()) > 2**31 - 1:
            raise ValueError("cell index overflows int32")
        if int(cell_indices.max()) >= n_cells or int(cell_indices.min()) < 0:
            # a cell index outside the dataset means the caller mixed up the
            # axes (e.g. gene indices instead of cell indices) - the blob
            # would look like "every gene is zero" in the app
            raise ValueError(
                f"cell index out of range: {int(cell_indices.max())} >= {n_cells}"
            )

    genes: dict[str, list[int]] = {}
    offset = 0
    with open(out_path, "wb") as fh:
        for g, feat in enumerate(features):
            a, b = int(indptr[g]), int(indptr[g + 1])
            n = b - a
            if n == 0:
                genes[str(feat)] = [offset, 0, 0]
                continue
            cells = cell_indices[a:b]
            vals = values[a:b]
            if n > 1 and not bool(np.all(np.diff(cells) > 0)):
                # the delta encoding assumes ascending cell indices
                order = np.argsort(cells, kind="stable")
                cells = cells[order]
                vals = vals[order]
            block = _gzip_block(encode_gene_block(cells, vals, scale))
            fh.write(block)
            genes[str(feat)] = [offset, len(block), n]
            offset += len(block)

    index = {"n": int(n_cells), "scale": scale, "genes": genes}
    with open(out_path.parent / "X.index.json", "w", encoding="utf-8") as fh:
        json.dump(index, fh, separators=(",", ":"))
    with gzip.open(out_path.parent / "X.index.json.gz", "wt", encoding="utf-8") as fh:
        json.dump(index, fh, separators=(",", ":"))
    return index


# --------------------------------------------------------------------------
# decoding (used by the tests to prove Python/JS parity)
# --------------------------------------------------------------------------


def decode_gene_block(payload: bytes, n_entries: int, scale: float) -> tuple[np.ndarray, np.ndarray]:
    """Decode an inflated block into ``(cell_indices, values)``."""
    if n_entries == 0:
        return np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.float32)
    deltas, used = _varint_decode(payload, n_entries)
    # The reference decoder starts at ``prev = -1`` and adds ``v - 1`` per
    # entry, i.e. the first delta is ``cell_index + 2``.
    cells = np.cumsum(deltas - 1) - 1
    n = cells.size
    if len(payload) < used + 2 * n:
        raise ValueError("truncated gene block")
    hi = np.frombuffer(payload, dtype=np.uint8, count=n, offset=used)
    lo = np.frombuffer(payload, dtype=np.uint8, count=n, offset=used + n)
    q = (hi.astype(np.uint32) << 8) | lo.astype(np.uint32)
    values = q.astype(np.float32) * np.float32(scale)
    return cells.astype(np.int64), values


def read_index(path: Path) -> dict:
    """Read ``X.index.json`` (plain or gzipped)."""
    path = Path(path)
    if path.suffix == ".gz":
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            return json.load(fh)
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def read_gene_block(blob_path: Path, index: dict, gene: str) -> tuple[np.ndarray, np.ndarray]:
    """Read + decode a single gene out of an ``X.bin`` blob."""
    rec = index["genes"].get(gene)
    if rec is None:
        raise KeyError(gene)
    offset, length, n_entries = rec
    if length == 0:
        return np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.float32)
    with open(blob_path, "rb") as fh:
        fh.seek(offset)
        raw = fh.read(length)
    payload = gzip.decompress(raw)
    return decode_gene_block(payload, n_entries, index["scale"])
