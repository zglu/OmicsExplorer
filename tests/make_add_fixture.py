"""Create a tiny two-dataset project used by tests/e2e_add.mjs.

    python3 tests/make_add_fixture.py /tmp/opencode/oe_addprobe

Writes ``seed.h5ad``, ``patch.h5ad`` and a ``project.yaml`` with the seed
dataset only, then builds the bundle (the web UI add flow converts the patch
at runtime).
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import scipy.sparse as sp

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_add import write_test_h5ad  # noqa: E402


def build_h5ad(path: Path, n_cells: int, label: str) -> None:
    rng = np.random.default_rng(3)
    n_genes = 40
    dense = rng.integers(0, 5, size=n_cells * n_genes).reshape(n_cells, n_genes).astype(np.float32)
    dense[dense < 4] = 0
    matrix = sp.csc_matrix(dense)
    sample = rng.integers(0, 2, n_cells)
    cell_type = rng.integers(0, 6, n_cells)
    write_test_h5ad(
        path,
        X=matrix,
        obs={
            "sample": np.array([f"sample.{i}" for i in sample]),
            "cell_type": np.array([f"type{i}" for i in cell_type]),
        },
        obsm={
            "spatial": (rng.random((n_cells, 2)) * 1000).astype(np.float32),
            "X_umap": (rng.random((n_cells, 2)) * 20).astype(np.float32),
        },
        index=np.array([f"{label}_{i:04d}" for i in range(n_cells)]),
        var_index=np.array([f"GENE_{i:03d}" for i in range(n_genes)]),
    )


def main(out_dir: str) -> int:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    build_h5ad(out / "seed.h5ad", 300, "SEED")
    build_h5ad(out / "patch.h5ad", 200, "PATCH")
    manifest = out / "project.yaml"
    manifest.write_text(
        "name: add probe\n"
        "subtitle: runtime add test\n"
        "datasets:\n"
        "  - id: seed\n"
        "    name: Seed dataset\n"
        "    kind: spatial\n"
        "    path: seed.h5ad\n"
        "    groups:\n"
        "      sample:\n"
        "        column: sample\n"
        "      cell_type:\n"
        "        column: cell_type\n"
        "    embeddings:\n"
        "      spatial: {kind: spatial, obsm: spatial}\n"
        "      umap: {kind: umap, obsm: X_umap}\n",
        encoding="utf-8",
    )
    import subprocess

    cli = str(ROOT / ".venv" / "bin" / "omicexplorer")
    subprocess.run([cli, "build", "-p", str(manifest)], check=True, cwd=str(ROOT))
    # marker gene index (the app fetches data/markers.json on startup)
    subprocess.run([cli, "markers", "-p", str(manifest)], check=True, cwd=str(ROOT))
    # a gene_details.json placeholder so the frontend has no 404
    (out / "data" / "gene_details.json").write_text("{}", encoding="utf-8")
    print(f"fixture ready: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/opencode/oe_addprobe"))
