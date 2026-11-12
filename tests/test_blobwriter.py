"""The browser side expression blob writer must produce the same bytes.

The frontend has its own implementation of the block format (web/src/core/
blobwriter.js).  If it drifts from the python one (omicexplorer/blob.py) the
expression values end up on the wrong cells - silently.  So compare them byte
by byte here.
"""

from __future__ import annotations

import gzip
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from omicsexplorer import blob  # noqa: E402

NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(not NODE, reason="node is not available")


def _js_encode(cells: list[int], values: list[float], scale: float) -> bytes:
    """Encode one gene block with the javascript writer."""
    script = """
import { buildExpressionBlob } from '%s/web/src/core/blobwriter.js';
const cells = Int32Array.from(%s);
const values = Float32Array.from(%s);
const scale = %s;
const { blob } = await buildExpressionBlob(['G'], cells, values, Int32Array.from([0, cells.length]), cells.length, scale);
process.stdout.write(Buffer.from(await blob.arrayBuffer()).toString('hex'));
""" % (
        ROOT,
        json.dumps(cells),
        json.dumps(values),
        repr(scale),
    )
    out = subprocess.run([NODE, "--input-type=module", "-e", script], capture_output=True, text=True)
    if out.returncode != 0:
        raise AssertionError(f"the node script failed: {out.stderr[-500:]}")
    return bytes.fromhex(out.stdout.strip())


@pytest.mark.parametrize(
    "cells, values",
    [
        ([0, 5, 9, 100, 101, 250], [1.5, 2.5, 3.5, 4.5, 5.5, 6.5]),
        ([0, 1, 2], [10.0, 20.0, 30.0]),
        (list(range(0, 40, 2)), [float(i) for i in range(20)]),
    ],
)
def test_js_block_matches_the_python_block(cells, values):
    scale = max(values) / 65535 if max(values) else 1.0
    py_raw = blob.encode_gene_block(np.array(cells, dtype=np.int64), np.array(values, dtype=np.float64), scale)
    js_raw = gzip.decompress(_js_encode(cells, values, scale))
    assert js_raw == py_raw, "the javascript encoder drifted from the python one"


def test_js_block_is_read_back_correctly(tmp_path):
    """The bytes the frontend writes decode to the original cells and values."""
    cells = [0, 3, 7, 8, 40, 41, 99]
    values = [0.5, 1.25, 2.0, 3.5, 10.0, 11.0, 12.0]
    scale = max(values) / 65535
    js_gz = _js_encode(cells, values, scale)
    # write it as a blob and read it back with the python reader
    path = tmp_path / "X.bin"
    path.write_bytes(js_gz)
    assert gzip.decompress(js_gz) == blob.encode_gene_block(
        np.array(cells, dtype=np.int64), np.array(values, dtype=np.float64), scale
    )
    index = {"n": max(cells) + 1, "scale": scale, "genes": {"G": [0, len(js_gz), len(cells)]}}
    read_cells, read_values = blob.read_gene_block(path, index, "G")
    assert list(read_cells) == cells
    # the values are quantised to 16 bit, so they are within one step
    assert read_values == pytest.approx(values, abs=scale)
