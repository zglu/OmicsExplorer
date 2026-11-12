"""Command line interface.

    omicsexplorer init                 scaffold a project.yaml
    omicsexplorer build                h5ad files -> static bundle
    omicsexplorer serve                build + run the local web server
    omicsexplorer export               build a self contained folder to deploy
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from .config import ConfigError, load_project
from .converter import BundleError, build_project

__all__ = ["main"]

_TEMPLATE = """\
# OmicsExplorer project manifest
#
#   omicsexplorer build            # convert the h5ad files into web/data
#   omicsexplorer serve            # build + serve on http://127.0.0.1:8080
#   omicsexplorer export -o dist   # build a folder you can host anywhere

name: {name}
subtitle: {subtitle}

species:
  example:
    name: Example species
    color: "#4f9cf9"

# Canonical cell types, used to compare annotations across datasets.
ontology:
  cell_types:
    neuron: [Neuron, neuron, Neuronal]

datasets:
  - id: example
    name: Example dataset
    species: example
    kind: umap
    path: ../data/example.h5ad
    description: One sentence about this dataset.
    groups:
      cell_type:
        column: cell_type
        label: Cell type
      sample:
        column: orig.ident
        label: Sample
    embeddings:
      umap:
        kind: umap
        obsm: X_umap
        label: UMAP
      spatial:
        kind: spatial
        obsm: spatial
        label: Spatial
"""


def _cmd_init(args: argparse.Namespace) -> int:
    root = Path(args.path).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    manifest = root / "project.yaml"
    if manifest.exists() and not args.force:
        print(f"{manifest} already exists (use --force to overwrite)")
        return 1
    manifest.write_text(
        _TEMPLATE.format(name=root.name or "My project", subtitle="single-cell & spatial atlas"),
        encoding="utf-8",
    )
    print(f"wrote {manifest}")
    print("edit it, then run:  omicsexplorer build && omicsexplorer serve")
    print("tip: delete the 'datasets' entries (or write 'datasets: []') to open")
    print("     an empty app and add every dataset through the web (+ Data) UI")
    return 0


def _load(path: str) -> "object":
    try:
        return load_project(path)
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(2)


def _cmd_build(args: argparse.Namespace) -> int:
    project = _load(args.project)
    out = Path(args.out).expanduser() if args.out else project.root / "data"
    only = args.only or None
    try:
        build_project(project, out, only=only)
    except BundleError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(f"bundle written to {out}")
    return 0


def _cmd_serve(args: argparse.Namespace) -> int:
    project = _load(args.project)
    data_dir = Path(args.data).expanduser() if args.data else project.root / "data"
    if not args.no_build:
        try:
            build_project(project, data_dir, only=args.only or None)
        except BundleError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
    if args.markers:
        _compute_markers(project, data_dir, args.only or None)
    from .server import serve

    web_dir = Path(args.web).expanduser() if args.web else None
    if web_dir is None:
        web_dir = _default_web_dir()
    print(f"OmicsExplorer -> http://{args.host}:{args.port}")
    serve(data_dir, host=args.host, port=args.port, web_dir=web_dir, project=project)
    return 0


def _compute_markers(project, data_dir: Path, only=None) -> None:
    from .markers import compute_markers

    try:
        compute_markers(project, data_dir, only=only)
    except (BundleError, KeyError) as exc:
        print(f"warning: could not compute the markers: {exc}", file=sys.stderr)


def _default_web_dir() -> Path | None:
    from .server import _web_root

    try:
        return _web_root()
    except FileNotFoundError:
        return None


def _cmd_export(args: argparse.Namespace) -> int:
    project = _load(args.project)
    out = Path(args.out).expanduser().resolve()
    if out.exists() and any(out.iterdir()) and not args.force:
        print(f"{out} is not empty (use --force)", file=sys.stderr)
        return 1
    out.mkdir(parents=True, exist_ok=True)
    try:
        build_project(project, out / "data", only=args.only or None)
    except BundleError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if not args.no_markers:
        _compute_markers(project, out / "data", args.only or None)
    web_dir = _default_web_dir()
    if web_dir:
        shutil.copytree(
            web_dir,
            out,
            dirs_exist_ok=True,
            ignore=shutil.ignore_patterns(".DS_Store", "__pycache__"),
        )
    print(f"deployable bundle written to {out}")
    print("serve it with any static host that supports HTTP range requests:")
    print(f"  omicsexplorer serve-static -d {out} 8080")
    return 0


def _cmd_serve_static(args: argparse.Namespace) -> int:
    from .static_server import serve

    directory = Path(args.dir).expanduser().resolve()
    if not directory.exists():
        print(f"error: {directory} does not exist", file=sys.stderr)
        return 1
    serve(directory, args.host, args.port)
    return 0


def _cmd_markers(args: argparse.Namespace) -> int:
    project = _load(args.project)
    out = Path(args.out).expanduser() if args.out else project.root / "data"
    from .markers import compute_markers

    try:
        compute_markers(project, out, only=args.only or None, groups=args.groups or None)
    except (BundleError, KeyError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="omicsexplorer", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="scaffold a project.yaml")
    p_init.add_argument("path", nargs="?", default=".", help="project directory")
    p_init.add_argument("--force", action="store_true")
    p_init.set_defaults(func=_cmd_init)

    p_build = sub.add_parser("build", help="convert h5ad files into the web bundle")
    p_build.add_argument("-p", "--project", default="project.yaml", help="project manifest")
    p_build.add_argument("-o", "--out", default=None, help="output directory")
    p_build.add_argument("--only", nargs="*", default=None, help="only these dataset ids")
    p_build.set_defaults(func=_cmd_build)

    p_serve = sub.add_parser("serve", help="build and serve the app locally")
    p_serve.add_argument("-p", "--project", default="project.yaml", help="project manifest")
    p_serve.add_argument("--host", default="127.0.0.1")
    p_serve.add_argument("--port", type=int, default=8080)
    p_serve.add_argument("--data", default=None, help="bundle directory")
    p_serve.add_argument("--web", default=None, help="frontend directory")
    p_serve.add_argument("--no-build", action="store_true", help="serve the existing bundle")
    p_serve.add_argument("--markers", action="store_true", help="also compute the marker genes")
    p_serve.add_argument("--only", nargs="*", default=None, help="only these dataset ids")
    p_serve.set_defaults(func=_cmd_serve)

    p_export = sub.add_parser("export", help="build a self contained folder to deploy")
    p_export.add_argument("-p", "--project", default="project.yaml", help="project manifest")
    p_export.add_argument("-o", "--out", default="dist", help="output directory")
    p_export.add_argument("--only", nargs="*", default=None, help="only these dataset ids")
    p_export.add_argument("--force", action="store_true")
    p_export.add_argument("--no-markers", action="store_true", help="skip the marker statistics")
    p_export.set_defaults(func=_cmd_export)

    p_markers = sub.add_parser("markers", help="compute marker genes for every dataset")
    p_markers.add_argument("-p", "--project", default="project.yaml", help="project manifest")
    p_markers.add_argument("-o", "--out", default=None, help="bundle directory")
    p_markers.add_argument("--only", nargs="*", default=None, help="only these dataset ids")
    p_markers.add_argument("--groups", nargs="*", default=None, help="only these groupings")
    p_markers.set_defaults(func=_cmd_markers)

    p_static = sub.add_parser(
        "serve-static", help="serve a folder (e.g. an exported bundle) with range support"
    )
    p_static.add_argument("-d", "--dir", default="dist", help="directory to serve")
    p_static.add_argument("--host", default="127.0.0.1")
    p_static.add_argument("--port", type=int, default=8080)
    p_static.set_defaults(func=_cmd_serve_static)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
