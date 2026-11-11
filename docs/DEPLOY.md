# Deployment

## 1. Build a self contained folder

```bash
omicexplorer export -p my_project/project.yaml -o dist
```

```
dist/
├── index.html
├── styles/
├── vendor/
├── src/
└── data/
```

`dist/` is a plain static site.  Copy it to any host.

## 2. Host it

> **Range requests are required.**  The expression blob is read gene by gene
> with `Range: bytes=…`.  `python3 -m http.server` ignores the header, so the
> gene panel stays empty - use the bundled server for a quick check:
>
> ```bash
> omicexplorer serve-static -d dist 8080
> ```

### Any static server with range support

```bash
omicexplorer serve-static -d dist 8080   # range requests enabled
```

### nginx

```nginx
server {
    listen 443 ssl;
    server_name atlas.example.org;
    root /srv/omicexplorer/dist;

    # the expression blob is read gene by gene with range requests
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

nginx supports range requests out of the box; do **not** disable them.

### GitHub Pages

```bash
cd dist
git init && git add -A && git commit -m "publish"
git branch -f gh-pages
git push -f origin gh-pages
```

GitHub Pages serves range requests for files over a few hundred bytes, which
covers the parquet files and the expression blob.

### Docker

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY dist /app
EXPOSE 8080
CMD ["python3", "-m", "omicexplorer.cli", "serve-static", "-d", "/app", "--port", "8080"]
```

```bash
docker build -t omicexplorer .
docker run -p 8080:8080 omicexplorer
```

(`python3 -m http.server` also works in the container, but it does not support
range requests - the gene panel would be empty.)

For a production server put nginx in front of it and terminate TLS there.

## 3. Keep the local server for development

```bash
omicexplorer serve -p my_project/project.yaml --port 8080
```

The local server

* rebuilds the bundle before it starts (unless `--no-build`),
* serves the frontend and the bundle from the same origin,
* answers range requests (Starlette's `FileResponse` does that natively),
* exposes a small JSON API:

| route | purpose |
|---|---|
| `GET /api/project` | the same content as `data/project.json` |
| `GET /api/genes?q=` | gene search across all datasets |
| `GET /api/datasets/<id>/index` | the metadata of one dataset |

The API is optional - the frontend works without it.

## 4. Caching

The bundle is immutable between builds, so the data files can be cached
aggressively.  The frontend appends a `?v=<stamp>` query string to every
request when it is loaded with a stamp (`index.html` -> `src/main.js?v=…`);
bump it whenever the data changes.

```nginx
location /data/ {
    add_header Cache-Control "public, max-age=604800";
}
location ~* \.(html|js|css)$ {
    add_header Cache-Control "no-cache";
}
```

## 5. Size

The expression blob is the whole story:

| dataset | cells | genes | X.bin |
|---|---|---|---|
| Cs · Stereo-seq bin50 | 11,387 | 11,992 | 11 MB |
| Of · Stereo-seq cellbin | 15,127 | 10,769 | 13 MB |
| Cs · scRNA-seq | 9,633 | 10,682 | 33 MB |
| Of · scRNA-seq | 4,358 | 9,787 | 12 MB |

If the bundle gets too big, subset the features of the `.h5ad` before the
build - the blob shrinks proportionally and the gene search then only offers
the genes that are actually shown.
