# Running OmicsExplorer in a container

The container bundles the app, the web UI and R + Seurat.  Nothing has to be
installed on the host - the data never leaves the machine.

## Docker

```bash
git clone <this repo> OmicsExplorer && cd OmicsExplorer
docker build -t omicsexplorer .

# an empty project directory is enough - everything else is created for you
mkdir -p ~/omics && docker run --rm -p 8080:8080 -v ~/omics:/project omicsexplorer
# -> http://127.0.0.1:8080
```

**Tip:** every rebuild with the same tag takes the tag away from the previous
image, which is left behind as a `<none>` entry (several GB).  The helper
script builds and removes exactly that old image again:

```bash
./docker/build.sh                     # == docker build -t omicsexplorer .
./docker/build.sh omicsexplorer:slim --build-arg WITH_R=0 \
    --build-arg BASE_IMAGE=python:3.12-slim-bookworm
```

Already have dangling images?  `docker image prune -f` removes all of them
(only images without a tag and not used by any container).

Open the URL, press **+ Data**, and drop in an `.h5ad` or a Seurat `.rds`
file.  The upload, the conversion and the cache all happen inside the
container, in the mounted directory:

```
~/omics/
├── project.yaml            # created on the first start
├── data/                   # the built web bundle
├── uploads/                # the files you uploaded
└── .oe_rds_cache_*/        # their conversion cache (reused on the next start)
```

Add your own datasets by editing `project.yaml` and restarting the container:

```yaml
name: My project
datasets:
  - id: sample_a
    name: Sample A
    kind: umap
    path: /project/data/sample_a.h5ad
    groups:
      cell_type: {column: cell_type}
    embeddings:
      umap: {kind: umap, obsm: X_umap}
```

### As your own user

The container writes into the mounted directory.  Run it with your uid/gid so
the files stay yours:

```bash
docker run --rm -p 8080:8080 \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v ~/omics:/project omicsexplorer
```

`docker compose` does that for you:

```bash
OE_PROJECT=~/omics docker compose up --build
```

### Without R (smaller image)

```bash
docker build --build-arg WITH_R=0 \
  --build-arg BASE_IMAGE=python:3.12-slim-bookworm \
  --build-arg PY_PKGS= -t omicsexplorer:slim .
```

1.1 GB instead of 2.8 GB - but Seurat `.rds` files are then not supported.

## Apptainer / Singularity (HPC)

```bash
./docker/apptainer-build.sh omicsexplorer.sif      # docker build + apptainer build
apptainer run --bind "$PWD/omics:/project" omicsexplorer.sif
```

The container only writes inside the bound directory, so it also works on a
read-only cluster filesystem.

## Useful commands inside the container

```bash
# rebuild the bundle after editing project.yaml
docker exec -it omicsexplorer omicsexplorer-entrypoint build -p /project/project.yaml

# compute the marker genes (the "Marker genes" panel)
docker exec -it omicsexplorer omicsexplorer-entrypoint markers -p /project/project.yaml

# export a static site (no server needed, range requests required)
docker exec -it omicsexplorer omicsexplorer-entrypoint export -p /project/project.yaml -o /project/site
```

## Troubleshooting

| symptom | cause |
| --- | --- |
| `Rscript not found` / `.rds` upload fails | you built the image without R (`WITH_R=0`) |
| the container exits right away | the mounted directory is not writable - use `--user` |
| `upload failed` in the UI | check `docker logs <container>` for the R error |
| slow first start | the first run builds the bundle; later runs reuse `data/` and the cache |
