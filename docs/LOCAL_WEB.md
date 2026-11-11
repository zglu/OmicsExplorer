# The browser only mode

The app can run as a plain static website: the user picks a file in the
browser, the file is parsed and converted **on the user's machine** and the
result is kept in the browser (IndexedDB).  No server, no upload, the data
never leaves the computer.

```bash
# any static server works - the app only needs the files
python3 -m http.server 8080 --directory web
# -> http://127.0.0.1:8080
```

For a deployment, copy `web/` to any static host (GitHub Pages, Netlify, a
university web space, ...).  The app detects that there is no API and
switches to the local mode by itself.

## What happens when a file is added

1. the browser reads the `.h5ad` with [h5wasm](https://github.com/h5wasm/h5wasm)
   (HDF5 compiled to WebAssembly, ~4 MB, loaded only when it is needed),
2. `web/src/core/builder.js` turns it into the same files the python
   builder produces:
   * `data/<id>/index.json` - features, categories, embeddings, metrics
   * `data/<id>/X.bin` + `X.index.json` - the expression blob (16 bit values,
     varint cell deltas, gzip blocks - byte compatible with the server)
   * `data/<id>/obs/<name>.bin` - the groupings (JSON) and the quantitative
     metadata (Float64)
   * `data/<id>/obsm/<name>.bin` - the embeddings (Float32)
   * `data/genes.json` - the gene index
3. everything is written into IndexedDB; a small fetch interceptor answers the
   requests of the app from there (including the HTTP range requests the
   expression blob needs).

The dataset then behaves exactly like a server side one: cards, drag & drop
ordering, gene queries, the in-card dotplot, the compare table, the delete
button.  Reloading the page keeps the data (it lives in the browser).

## Limits of the local mode

| | server mode | browser mode |
| --- | --- | --- |
| `.h5ad` | ✅ | ✅ |
| Seurat `.rds` | ✅ (R in the container) | ❌ (would need WebR) |
| marker genes | ✅ | ❌ (not computed) |
| gene descriptions | ✅ (table file) | ❌ |
| very large datasets | ✅ (server memory) | limited by the browser memory |
| sharing between users | ✅ | ❌ (every browser has its own project) |

For the missing pieces the server mode (or the container) is the way to go;
both modes share the same frontend.

## Files

| file | purpose |
| --- | --- |
| `web/src/core/localfs.js` | the IndexedDB store |
| `web/src/core/localfetch.js` | the fetch interceptor + the mode detection |
| `web/src/core/h5ad.js` | reads an `.h5ad` with h5wasm |
| `web/src/core/blobwriter.js` | writes the expression blob (port of `blob.py`) |
| `web/src/core/builder.js` | builds the bundle and registers the dataset |
| `web/vendor/h5wasm/` | the vendored HDF5/WASM build |
| `tests/e2e_local.mjs` | the end to end test of this mode |
