"""The spatial geometry of Visium style files.

The coordinates of a Visium h5ad are in the pixels of the full resolution
image, in the pixels of the hires image or in microns.  The converter has to
figure that out, convert the coordinates to microns and compute the transform
that aligns the tissue image with the spots.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from omicsexplorer import spatial  # noqa: E402


def _hex_array(rows: int = 78, cols: int = 64, pitch: float = 29.0, offset: float = 298.0):
    """A hexagonal Visium like layout: every row is offset by half a pitch."""
    points = []
    for row in range(rows):
        for col in range(cols):
            x = offset + col * pitch + (pitch / 2 if row % 2 else 0)
            y = offset + row * pitch * 0.87
            points.append((x, y))
    return np.asarray(points, dtype=np.float64)


def test_pitch_of_a_hexagonal_layout():
    """The median difference of the sorted coordinates is useless here."""
    xy = _hex_array()
    pitch = spatial.estimate_pitch(xy)
    assert pitch == pytest.approx(29.0, rel=0.05)


def test_fullres_pixels_are_detected_and_converted():
    xy = _hex_array()
    scalefactors = {"spot_diameter_fullres": 19.289, "tissue_hires_scalef": 0.6667}
    info = spatial.analyse_spatial(
        xy,
        scalefactors,
        image_shape=(1600, 2000),        # the hires image
        fullres_shape=(2400, 3000),      # the full resolution image
    )
    assert info["space"] == "fullres_px"
    # the Visium grid has a pitch of 100 um
    assert info["um_per_data"] == pytest.approx(100.0 / 29.0, rel=0.02)
    # the spot diameter comes from the file, but never more than 60% of the
    # grid pitch - so the spots cannot touch
    assert info["size"] == pytest.approx(min(19.289 * 100.0 / 29.0, 0.6 * 100.0), rel=0.02)
    # the image: hires pixels per micron
    assert info["scale"] == pytest.approx(29.0 / 100.0 * 0.6667, rel=0.02)


def test_hires_pixels_are_detected():
    xy = _hex_array()
    scalefactors = {"spot_diameter_fullres": 19.289, "tissue_hires_scalef": 0.6667}
    info = spatial.analyse_spatial(
        xy,
        scalefactors,
        image_shape=(1600, 2000),
        fullres_shape=(2400, 3000),
    )
    # the coordinates fit into the hires image as well -> they are hires pixels
    info_hires = spatial.analyse_spatial(
        xy * 0.6667,
        scalefactors,
        image_shape=(1600, 2000),
        fullres_shape=(2400, 3000),
    )
    assert info_hires["space"] == "hires_px"
    # the image transform is hires pixels per micron (the coordinates are
    # converted to microns): 1 um = pitch/100 hires px
    assert info_hires["scale"] == pytest.approx(19.3343 / 100.0, rel=0.05)


def test_microns_are_kept():
    xy = _hex_array(pitch=100.0, offset=0.0)
    scalefactors = {"spot_diameter_fullres": 19.289, "tissue_hires_scalef": 0.6667}
    info = spatial.analyse_spatial(
        xy,
        scalefactors,
        image_shape=(1600, 2000),
        fullres_shape=(2400, 3000),
    )
    assert info["space"] == "um"
    assert info["um_per_data"] == pytest.approx(1.0)


def test_image_transform():
    tr = spatial.image_transform({"scale": 0.1933})
    assert tr["scale"] == [0.1933, 0.1933]
    assert tr["translate"] == [0.0, 0.0]
    assert spatial.image_transform({"scale": 0}) == {}


def test_png_encoder():
    """A tiny RGB image becomes a valid PNG."""
    rgb = np.zeros((3, 4, 3), dtype=np.uint8)
    rgb[1, 2] = (255, 0, 0)
    png = spatial._png_bytes(rgb)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert b"IHDR" in png and b"IDAT" in png and b"IEND" in png


# --------------------------------------------------------------------------
# the built bundle: the coordinates and the image transform must agree
# --------------------------------------------------------------------------


def _write_visium_h5ad(path, xy):
    """A small Visium style file: uns/spatial with an image + scalefactors."""
    import h5py
    import scipy.sparse as sp

    strings = h5py.string_dtype(encoding="utf-8")
    n_cells, n_genes = xy.shape[0], 5
    dense = np.zeros((n_cells, n_genes), dtype=np.float32)
    dense[0, 0] = 1.0
    dense[1, 1] = 2.0
    csc = sp.csc_matrix(dense)
    image = np.zeros((1600, 2000, 3), dtype=np.uint8)
    with h5py.File(path, "w") as fh:
        x = fh.create_group("X")
        x.attrs["encoding-type"] = "csc_matrix"
        x.attrs["shape"] = [n_cells, n_genes]
        x.create_dataset("indptr", data=np.asarray(csc.indptr, dtype=np.int64))
        x.create_dataset("indices", data=np.asarray(csc.indices, dtype=np.int32))
        x.create_dataset("data", data=np.asarray(csc.data, dtype=np.float32))
        obs = fh.create_group("obs")
        obs.create_dataset("_index", data=["c%d" % i for i in range(n_cells)], dtype=strings)
        obs.create_dataset("cell_type", data=["a"] * n_cells, dtype=strings)
        var = fh.create_group("var")
        var.create_dataset("_index", data=["g%d" % i for i in range(n_genes)], dtype=strings)
        fh.create_dataset("obsm/spatial", data=xy)
        s = fh.create_group("uns/spatial/demo")
        s.create_dataset("images/hires", data=image, compression="gzip")
        s.create_dataset("images/fullres", data=np.zeros((2400, 3000, 3), dtype=np.uint8), compression="gzip")
        s.create_dataset("scalefactors/spot_diameter_fullres", data=19.289)
        s.create_dataset("scalefactors/tissue_hires_scalef", data=0.6667)


def test_built_bundle_coordinates_match_the_image_transform(tmp_path):
    """The stored spatial coordinates and the image transform must agree.

    The bug: the obsm parquet was written *before* the coordinates were
    converted to microns, so the image (aligned with the microns) was drawn
    at the wrong scale - the tissue image did not sit under the spots.
    """
    from omicsexplorer.config import DatasetSpec, EmbeddingSpec, GroupSpec
    from omicsexplorer.converter import build_dataset
    import json

    raw = _hex_array(rows=20, cols=16, offset=1700.0)  # fits only the fullres image
    path = tmp_path / "visium.h5ad"
    _write_visium_h5ad(path, raw)
    spec = DatasetSpec(
        id="test_sp",
        path=path,
        name="Test",
        kind="spatial",
        groups=[GroupSpec(name="cell_type", column="cell_type")],
        embeddings=[EmbeddingSpec(name="spatial", kind="spatial", obsm="spatial")],
    )
    out = tmp_path / "out"
    out.mkdir()
    build_dataset(spec, out, log=lambda msg: None)

    payload = json.loads((out / "test_sp" / "index.json").read_text(encoding="utf-8"))
    grid = payload["embeddings"][0]["grid"]
    scale = grid["image_transform"]["scale"][0]
    translate = grid["image_transform"]["translate"]

    import pandas as pd

    stored = pd.read_parquet(out / "test_sp" / "obsm" / "spatial.parquet").to_numpy().astype(float)
    # the coordinates are microns now
    assert stored[:, 0] == pytest.approx(raw[:, 0] * 100.0 / 29.0, rel=1e-4)
    # the image transform maps them back to the hires image pixels
    hires_px = raw * 0.6667
    assert translate == [0.0, 0.0]
    assert (stored * scale)[:, 0] == pytest.approx(hires_px[:, 0], rel=1e-3)
    assert (stored * scale)[:, 1] == pytest.approx(hires_px[:, 1], rel=1e-3)
    # the grid pitch is in microns as well
    assert grid["pitch"] == pytest.approx(100.0, rel=0.05)


def test_built_bundle_hires_pixel_coordinates_also_align(tmp_path):
    """The same for a file whose spatial coordinates are hires pixels."""
    from omicsexplorer.config import DatasetSpec, EmbeddingSpec, GroupSpec
    from omicsexplorer.converter import build_dataset
    import json

    raw = _hex_array(rows=20, cols=16) * 0.6667  # coords in hires pixels
    path = tmp_path / "visium.h5ad"
    _write_visium_h5ad(path, raw)
    spec = DatasetSpec(
        id="test_sp",
        path=path,
        name="Test",
        kind="spatial",
        groups=[GroupSpec(name="cell_type", column="cell_type")],
        embeddings=[EmbeddingSpec(name="spatial", kind="spatial", obsm="spatial")],
    )
    out = tmp_path / "out"
    out.mkdir()
    build_dataset(spec, out, log=lambda msg: None)

    payload = json.loads((out / "test_sp" / "index.json").read_text(encoding="utf-8"))
    grid = payload["embeddings"][0]["grid"]
    scale = grid["image_transform"]["scale"][0]

    import pandas as pd

    stored = pd.read_parquet(out / "test_sp" / "obsm" / "spatial.parquet").to_numpy().astype(float)
    # whatever the source unit was - the transform maps the microns back to
    # the hires image pixels
    hires_px = raw
    assert (stored * scale)[:, 0] == pytest.approx(hires_px[:, 0], rel=1e-3)
    assert (stored * scale)[:, 1] == pytest.approx(hires_px[:, 1], rel=1e-3)
