# The bundle format

`omicsexplorer build` turns the `.h5ad` files into a folder of static files.
The frontend only ever reads these files, so the format is the contract
between the Python side and the browser.

```
data/
├── project.json          datasets, species, ontology
├── genes.json            gene -> datasets
├── markers.json          marker genes + statistics
├── img/                  background images (histology)
└── <dataset>/
    ├── index.json        features, embeddings, groupings, images, units
    ├── X.bin             the expression blob (gene major, gzip per gene)
    ├── X.index.json      byte offset / length / entry count of every gene
    ├── marker_stats.json pct + mean of every marker gene in every category
    ├── obs/
    │   ├── index.parquet cell identifiers
    │   └── <group>.parquet   one string column "value" per cell
    └── obsm/
        └── <emb>.parquet  two float32 columns "<emb>_1" and "<emb>_2"
```

## index.json

```jsonc
{
  "id": "cs_bin50",
  "name": "Cs · Stereo-seq bin50",
  "species": "cs",
  "kind": "spatial",
  "count": 11387,                       // cells
  "features": ["CSKR_000001", "…"],     // gene ids
  "features_count": 11992,
  "embeddings": [
    {
      "name": "spatial",
      "label": "Spatial",
      "kind": "spatial",                // spatial | umap | pca | tsne | other
      "columns": ["spatial_1", "spatial_2"],
      "grid": {                         // geometry of the coordinates
        "is_grid": true,                // one cell per position -> draw tiles
        "pitch": 50.0,                  // distance between two grid positions
        "max_per_position": 1,
        "unique_x": 161,
        "unique_y": 218
      }
    }
  ],
  "obs": ["cell_type", "cluster", "leiden", "sample"],
  "categories": { "cell_type": ["tegument", "vitellocyte", "…"] },
  "samples": [{ "id": "sample_1", "label": "sample_1", "n": 11387 }],
  "images": [{ "path": "img/cs_bin50__he.png", "label": "H&E", "transform": {} }],
  "units": "um",
  "bin_size": 50,
  "default_group": "cell_type",
  "default_embedding": "spatial",
  "scale": 0.00014,                     // the quantisation step of X.bin
  "codec": "gz-uint16"
}
```

`grid.is_grid` is what tells the frontend to draw the cells as **tiles** that
cover the tissue (Stereo-seq bin50, Visium spots) instead of individual
**dots** (cellbin, Xenium cells).  It is `true` when the coordinates sit on a
coarse lattice, i.e. when there are far fewer distinct x (and y) values than
cells.

## The expression blob

`X.bin` is a concatenation of **one gzip member per gene**, in the order of
`index.json.features`.

Each member, after inflation, holds three consecutive parts:

```
1. varint stream of the cell-index deltas   (the first delta is index + 2)
2. plane A - the high byte of the quantised value   (n bytes)
3. plane B - the low  byte of the quantised value   (n bytes)
```

The value is reconstructed as

```
value = (A << 8 | B) * scale        with a single global scale = max / 65535
```

Splitting the 16 bit values into two byte planes lets gzip collapse the
(nearly constant) high bytes, which roughly halves the blob size: 253 MB
instead of 907 MB for a 60k cell x 9k gene matrix.

`X.index.json` maps every gene to its position in the blob:

```json
{ "n": 11387, "scale": 0.00014, "genes": { "CSKR_000001": [0, 606, 185] } }
```

`[byte offset, compressed length, number of entries]`.

The browser asks for `Range: bytes=<offset>-<offset+length-1>` and inflates
the answer with `DecompressionStream('gzip')` - the server never has to
decompress anything, which is why the bundle works on a plain static host.

> This format is byte-compatible with the `nematode-atlas` project; there is a
> test that decodes a blob written there and one that compares our encoder
> with theirs byte by byte.

## Parquet files

* `obs/<group>.parquet` - one string column named `value`, one row per cell,
  in the canonical cell order.  Snappy compressed.
* `obsm/<emb>.parquet` - two float32 columns named `<emb>_1` and `<emb>_2`.
* `obs/index.parquet` - one string column named `value` with the cell ids.

## marker_stats.json

```jsonc
{
  "cell_type": {
    "cats": ["tegument", "vitellocyte"],
    "genes": ["CSKR_000001", "…"],       // the union of the top-N markers
    "pct":  [[0.85, 0.02], …],           // fraction of expressing cells
    "mean": [[2.65, 0.07], …]            // mean expression
  }
}
```

The dot plot needs the expression of a marker in **every** category, not only
in the ones where it is a top marker - otherwise it would be impossible to see
that a "tegument marker" is also strongly expressed in parenchyma.

## Keeping the bundle small

| lever | effect |
|---|---|
| fewer features | the blob shrinks proportionally; use `--max-features` in `build_panel.py`-style pipelines or subset the h5ad before the build |
| `layers:` in the manifest | the expression is taken from a layer (e.g. `log1p`) instead of `X` |
| dropping a dataset | `omicsexplorer build --only <id>` |

The expression blob dominates the size of a bundle; everything else is tiny.
