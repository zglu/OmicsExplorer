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
    assert info_hires["scale"] == pytest.approx(1.0, rel=0.2)


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
