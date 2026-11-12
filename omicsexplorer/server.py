"""HTTP layer: a tiny static server with Range support plus a few JSON APIs.

The web app is a pure static site.  ``omicsexplorer serve`` mounts the built
bundle under ``/data`` and the frontend under ``/``; because Starlette's
``FileResponse`` implements HTTP range requests, the ``X.bin`` expression blob
can be read gene by gene straight from disk - exactly the same code path a
static host (GitHub Pages, Netlify, nginx) would serve.

The optional ``/api`` endpoints add value that is awkward to precompute:
gene search across datasets and marker statistics computed on demand with
scanpy.

NOTE: the module must not use ``from __future__ import annotations`` --
FastAPI needs the real classes to resolve endpoint annotations, and they are
resolved against module globals rather than the locals of ``create_app``.
"""

import json
import time
from pathlib import Path
from typing import Any

__all__ = ["create_app", "serve"]


def _web_root() -> Path:
    """Locate the bundled frontend.

    Works in a source checkout (``<repo>/web``) and in an installed package
    (``site-packages/web``).  ``OMICSEXPLORER_WEB`` overrides both.
    """
    import os

    # the old spelling still works
    override = os.environ.get("OMICSEXPLORER_WEB") or os.environ.get("OMICEXPLORER_WEB")
    if override:
        return Path(override).expanduser().resolve()
    here = Path(__file__).resolve().parent
    for candidate in (here / "web", here.parent / "web", here.parent.parent / "web"):
        if candidate.exists():
            return candidate
    raise FileNotFoundError(
        "cannot find the web/ directory - set OMICSEXPLORER_WEB to point at it"
    )


def create_app(data_dir: Path, web_dir: Path | None = None, *, project: Any = None):
    """Build the FastAPI application.

    Parameters
    ----------
    data_dir
        Directory holding the built bundle (``project.json`` + per dataset dirs).
    web_dir
        Directory with the frontend; defaults to the bundled ``web/``.
    project
        Optional :class:`omicsexplorer.config.Project` used by the API routes.
    """
    from fastapi import Body, FastAPI, HTTPException, Query, Request
    from fastapi.responses import FileResponse, JSONResponse
    from fastapi.staticfiles import StaticFiles

    data_dir = Path(data_dir).resolve()
    web_dir = Path(web_dir).resolve() if web_dir else _web_root()

    app = FastAPI(title="OmicsExplorer", version="0.1.0")

    # ---- data ------------------------------------------------------------
    app.mount("/data", StaticFiles(directory=data_dir), name="data")

    # ---- api -------------------------------------------------------------
    @app.get("/api/health")
    def api_health() -> JSONResponse:
        """A tiny probe for container health checks."""
        path = data_dir / "project.json"
        panels = 0
        if path.exists():
            try:
                with path.open("r", encoding="utf-8") as fh:
                    panels = len(json.load(fh).get("panels") or [])
            except (OSError, ValueError):
                panels = 0
        return JSONResponse({"status": "ok", "datasets": panels})

    @app.get("/api/project")
    def api_project() -> JSONResponse:
        path = data_dir / "project.json"
        if not path.exists():
            # an empty project: the UI boots and datasets can be added via the web UI
            return JSONResponse(
                {
                    "name": project.name if project else "OmicsExplorer",
                    "subtitle": project.subtitle if project else "",
                    "data_dir": "data",
                    "species": (project.species if project else {}) or {},
                    "ontology": {"cell_types": (project.ontology if project else {}) or {}},
                    "panels": [],
                }
            )
        with path.open("r", encoding="utf-8") as fh:
            return JSONResponse(json.load(fh))

    @app.get("/api/genes")
    def api_genes(q: str = Query("", description="search string"), limit: int = 50) -> JSONResponse:
        path = data_dir / "genes.json"
        if not path.exists():
            return JSONResponse({"genes": []})
        with path.open("r", encoding="utf-8") as fh:
            genes = json.load(fh).get("genes", {})
        query = q.strip().lower()
        if not query:
            hits = list(genes.items())[:limit]
        else:
            exact = [g for g in genes if g.lower() == query]
            prefix = [g for g in genes if g.lower().startswith(query) and g.lower() != query]
            suffix = [
                g
                for g in genes
                if g.lower() != query and not g.lower().startswith(query) and query in g.lower()
            ]
            hits = (exact + prefix + suffix)[:limit]
        return JSONResponse(
            {"genes": [{"id": g, "panels": genes[g].get("panels", [])} for g in hits]}
        )

    @app.get("/api/datasets/{dataset_id}/index")
    def api_dataset_index(dataset_id: str) -> JSONResponse:
        path = data_dir / dataset_id / "index.json"
        if not path.exists():
            raise HTTPException(404, f"unknown dataset '{dataset_id}'")
        with path.open("r", encoding="utf-8") as fh:
            return JSONResponse(json.load(fh))

    # ---- adding datasets at runtime (web UI) -----------------------------

    _required_project = "this endpoint needs a project manifest (omicsexplorer serve with a project)"

    @app.post("/api/upload")
    async def api_upload(request: Request, name: str = Query("data.h5ad")) -> JSONResponse:
        body = await request.body()
        if not body:
            raise HTTPException(400, "empty upload")
        filename = Path(name.replace("\\", "/")).name or "upload.h5ad"
        if not filename.lower().endswith((".h5ad", ".h5", ".hdf", ".rds", ".rdata", ".rda")):
            filename += ".h5ad"
        store = Path(project.root / "uploads") if project else Path(data_dir) / "uploads"
        store.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d_%H%M%S")
        target = store / f"{stamp}_{filename}"
        i = 2
        while target.exists():
            target = store / f"{stamp}_{filename}.{i}"
            i += 1
        target.write_bytes(body)
        return JSONResponse({"path": str(target), "name": target.name, "size": len(body)})

    @app.post("/api/datasets/discover")
    async def api_discover(payload: dict = Body(default={})) -> JSONResponse:
        from .add import discover

        src = str(payload.get("path") or "").strip()
        if not src:
            raise HTTPException(400, "missing 'path'")
        if not Path(src).is_absolute():
            if project is None:
                raise HTTPException(500, _required_project)
            src = str(Path(project.root) / src)
        try:
            return JSONResponse(discover(src))
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(400, str(exc))

    @app.post("/api/datasets/add")
    async def api_add(payload: dict = Body(...)) -> JSONResponse:
        if project is None:
            raise HTTPException(500, _required_project)
        from . import add

        src = str(payload.get("path") or "").strip()
        if not src:
            raise HTTPException(400, "missing 'path'")
        if not Path(src).is_absolute():
            payload["path"] = str(Path(project.root) / src)
        # read the project again: datasets may have been added or removed
        # through the UI since the server started
        current = project
        try:
            from .config import load_project

            current = load_project(project.source)
        except Exception:  # noqa: BLE001 - fall back to the running project
            current = project
        try:
            job_id = add.start_add(current, data_dir, payload)
        except RuntimeError as exc:
            raise HTTPException(400, str(exc))
        return JSONResponse({"job": job_id})

    @app.post("/api/datasets/remove")
    async def api_remove(payload: dict = Body(...)) -> JSONResponse:
        if project is None:
            raise HTTPException(500, _required_project)
        from . import add

        ds_id = str(payload.get("id") or "").strip()
        if not ds_id:
            raise HTTPException(400, "missing 'id'")
        # the project may have changed since the server started (datasets that
        # were added through the UI), so read it again
        current = project
        try:
            from .config import load_project

            current = load_project(project.source)
        except Exception:  # noqa: BLE001 - fall back to the running project
            current = project
        if not any(d.id == ds_id for d in current.datasets):
            raise HTTPException(404, f"unknown dataset '{ds_id}'")
        try:
            result = add.remove_dataset(current, ds_id, data_dir)
        except (OSError, ValueError) as exc:
            raise HTTPException(400, str(exc))
        return JSONResponse(result)

    @app.get("/api/datasets/job/{job_id}")
    def api_job(job_id: str) -> JSONResponse:
        from .add import job_status

        status = job_status(job_id)
        if status is None:
            raise HTTPException(404, "unknown job id")
        return JSONResponse(status)

    # ---- frontend --------------------------------------------------------
    if web_dir.exists():
        # StaticFiles(html=True) serves index.html for directory requests and
        # uses FileResponse underneath, so it also honours range requests.
        app.mount("/", StaticFiles(directory=web_dir, html=True), name="web")

    return app


def serve(
    data_dir: Path,
    *,
    host: str = "127.0.0.1",
    port: int = 8080,
    web_dir: Path | None = None,
    project: Any = None,
    reload: bool = False,
) -> None:
    """Run the development server."""
    import uvicorn

    app = create_app(data_dir, web_dir, project=project)
    uvicorn.run(app, host=host, port=port, log_level="info")
