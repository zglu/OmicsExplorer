"""Read the spatial metadata of an AnnData file.

Visium style h5ad files (cellxgene curated, Space Ranger converted) carry
the tissue image and the scale factors inside the file:

    uns/spatial/<sample>/images/hires        the tissue image as an array
    uns/spatial/<sample>/scalefactors       spot_diameter_fullres, tissue_hires_scalef

This module extracts the image, writes it as a PNG and computes the transform
that aligns the image with ``obsm['spatial']``.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path
from typing import Any

import numpy as np


def _png_bytes(rgb: np.ndarray) -> bytes:
    """Encode an (H, W, 3) uint8 array as a PNG."""
    if rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError("the image must be an (H, W, 3) array")
    rgb = np.ascontiguousarray(rgb.astype(np.uint8))
    height, width = rgb.shape[:2]

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = bytearray()
    for row in rgb:
        raw.append(0)  # filter type 0 (none)
        raw.extend(row.tobytes())
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
        + chunk(b"IEND", b"")
    )


def _read_scalar(dataset: Any) -> float:
    value = dataset[()]
    if isinstance(value, (bytes, bytearray)):
        value = value.decode()
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return float("nan")
    try:
        return float(np.asarray(value).reshape(-1)[0])
    except (ValueError, IndexError):
        return float("nan")


def read_spatial_uns(path: str | Path) -> dict[str, Any]:
    """The tissue image and the scale factors of a spatial h5ad."""
    import h5py

    out: dict[str, Any] = {"image": None, "scalefactors": {}, "sample": None}
    with h5py.File(path, "r") as fh:
        if "uns" not in fh or "spatial" not in fh["uns"]:
            return out
        spatial = fh["uns"]["spatial"]
        for sample in spatial.keys():
            if sample.startswith("_"):
                continue
            group = spatial[sample]
            if not isinstance(group, h5py.Group):
                continue
            scalefactors: dict[str, float] = {}
            if "scalefactors" in group:
                for key in group["scalefactors"].keys():
                    scalefactors[key] = _read_scalar(group["scalefactors"][key])
            image = None
            image_shape = (0, 0)
            fullres_shape = (0, 0)
            if "images" in group and "hires" in group["images"]:
                node = group["images"]["hires"]
                if isinstance(node, h5py.Dataset) and node.ndim == 3:
                    image = np.asarray(node[:])
                    image_shape = tuple(int(x) for x in image.shape[:2])
            if "images" in group and "fullres" in group["images"]:
                node = group["images"]["fullres"]
                if isinstance(node, h5py.Dataset) and node.ndim == 3:
                    fullres_shape = tuple(int(x) for x in node.shape[:2])
            out["sample"] = sample
            out["scalefactors"] = scalefactors
            out["image"] = image
            out["image_shape"] = image_shape
            out["fullres_shape"] = fullres_shape
            break
    return out


def estimate_pitch(xy: np.ndarray) -> float:
    """The distance between neighbouring positions of a grid.

    The median difference of the sorted coordinates does not work for the
    hexagonal Visium layout (every row is offset by half a pitch), so the
    distance to the nearest neighbour is used instead.
    """
    if xy is None or len(xy) < 2:
        return 0.0
    points = np.asarray(xy, dtype=np.float64)
    try:
        from scipy.spatial import cKDTree

        tree = cKDTree(points)
        dist, _ = tree.query(points, k=2)
        return float(np.median(dist[:, 1]))
    except Exception:  # pragma: no cover - scipy is a hard dependency
        xs = np.unique(points[:, 0])
        diffs = np.diff(xs)
        diffs = diffs[diffs > 0]
        return float(np.median(diffs)) if diffs.size else 0.0


def _bbox(xy: np.ndarray) -> tuple[float, float, float, float]:
    if xy is None or len(xy) == 0:
        return (0.0, 0.0, 0.0, 0.0)
    xs = xy[:, 0]
    ys = xy[:, 1]
    return (float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max()))


def _fits(x0: float, y0: float, x1: float, y1: float, shape: tuple[int, int]) -> bool:
    if not shape:
        return False
    height, width = shape[0], shape[1]
    return x0 >= -1 and y0 >= -1 and x1 <= width + 1 and y1 <= height + 1


def analyse_spatial(
    xy: np.ndarray,
    scalefactors: dict[str, float],
    image_shape: tuple[int, int] = (0, 0),
    fullres_shape: tuple[int, int] = (0, 0),
    visium_pitch_um: float = 100.0,
) -> dict[str, Any]:
    """Describe the geometry of a spatial embedding.

    The coordinates of a Visium file are either in the pixels of the full
    resolution image, in the pixels of the hires image or in microns.  The
    image sizes tell them apart: the coordinates have to fit into the image
    they are measured in.

    Everything is reported in microns: how many microns one data unit is, how
    big a spot is and how many hires pixels one micron covers (that is the
    transform for the tissue image).
    """
    x0, y0, x1, y1 = _bbox(xy)
    extent_x = max(1e-9, x1 - x0)
    extent_y = max(1e-9, y1 - y0)
    pitch = estimate_pitch(xy)
    hires_scalef = float(scalefactors.get("tissue_hires_scalef") or 0.0)
    spot_fullres = float(scalefactors.get("spot_diameter_fullres") or 0.0)

    space = "um"
    if _fits(x0, y0, x1, y1, image_shape):
        space = "hires_px"
    elif fullres_shape and _fits(x0, y0, x1, y1, fullres_shape):
        space = "fullres_px"

    if space == "um":
        # the coordinates are microns already
        um_per_data = 1.0
        tissue_um = max(extent_x, extent_y)
        # the image is fitted to the tissue
        image_scale = (image_shape[1] / tissue_um) if image_shape else 0.0
        # the spot diameter: the file gives it in full resolution pixels
        fullres_px_per_um = (image_scale / hires_scalef) if (image_scale and hires_scalef) else 0.0
        size_um = spot_fullres * fullres_px_per_um if (spot_fullres and fullres_px_per_um) else 0.0
    elif space == "hires_px":
        # the coordinates are hires pixels: the image needs no scaling
        um_per_data = (visium_pitch_um / pitch) if (pitch > 0 and visium_pitch_um > 0) else 1.0
        size_um = spot_fullres * hires_scalef * um_per_data if spot_fullres else 0.0
        image_scale = 1.0
    else:
        # full resolution pixels: the Visium grid has a pitch of 100 um
        um_per_data = (visium_pitch_um / pitch) if (pitch > 0 and visium_pitch_um > 0) else 1.0
        size_um = spot_fullres * um_per_data if spot_fullres else 0.0
        image_scale = hires_scalef / um_per_data if hires_scalef else 0.0

    return {
        "pitch": pitch,
        "space": space,
        "size": float(size_um),
        "um_per_data": float(um_per_data),
        "scale": float(image_scale),
    }


def image_transform(info: dict[str, Any]) -> dict[str, list[float]]:
    """The transform that maps the (micrometer) data coordinates to the image.

    The image is drawn as ``pixel = scale * coordinate + translate``; the row
    and the column axis of the tissue image grow downwards, just like the
    coordinates of a Visium file, so no flip is needed.
    """
    scale = float(info.get("scale") or 0.0)
    if scale <= 0:
        return {}
    return {"scale": [scale, scale], "translate": [0.0, 0.0]}


def write_tissue_image(
    path: str | Path,
    out_dir: Path,
    name: str,
) -> Path | None:
    """Write the embedded tissue image as a PNG, returns its path."""
    info = read_spatial_uns(path)
    image = info.get("image")
    if image is None:
        return None
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / name
    target.write_bytes(_png_bytes(image))
    return target
