"""Project manifest (project.yaml) parsing and validation.

A project manifest describes one *project*: a set of datasets (usually one
AnnData file each), the species they belong to, the metadata groupings that
should be selectable, and the embeddings (UMAP / PCA / spatial ...) that can be
shown.

The manifest is deliberately small and declarative so that adding a new dataset
never requires touching code::

    name: Cs/Of Atlas
    species:
      cs: {name: Clonorchis sinensis, color: "#3b82f6"}
    datasets:
      - id: cs_bin50
        path: ../data/Y01087A814.bin50_leiden.rds.h5ad
        kind: spatial
        groups:
          cell_type: {column: cell_type_manual, label: Cell type}
        embeddings:
          spatial: {kind: spatial, obsm: spatial}
          umap:    {kind: umap,    obsm: umap}

Anything that is not given explicitly is auto-detected from the AnnData file
(embeddings from ``obsm``, groups from low-cardinality ``obs`` columns).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import yaml

__all__ = [
    "Project",
    "DatasetSpec",
    "GroupSpec",
    "EmbeddingSpec",
    "ImageSpec",
    "ConfigError",
    "load_project",
]


class ConfigError(ValueError):
    """Raised when a project manifest is malformed."""


# --------------------------------------------------------------------------
# spec dataclasses
# --------------------------------------------------------------------------


@dataclass
class GroupSpec:
    """A selectable metadata grouping (``obs`` column)."""

    name: str
    column: str
    label: str = ""

    @property
    def display(self) -> str:
        return self.label or self.name


@dataclass
class EmbeddingSpec:
    """A 2-D embedding that can be displayed."""

    name: str
    label: str = ""
    kind: str = "umap"  # umap | spatial | pca | tsne | other
    obsm: str | None = None
    obs: tuple[str, str] | None = None
    dims: tuple[int, int] = (0, 1)

    @property
    def display(self) -> str:
        return self.label or self.name

    @property
    def is_spatial(self) -> bool:
        return self.kind == "spatial"


@dataclass
class ImageSpec:
    """A background image for a spatial embedding (histology, H&E, ...)."""

    path: str
    label: str = ""
    transform: dict[str, Any] = field(default_factory=dict)

    @property
    def display(self) -> str:
        return self.label or Path(self.path).name


@dataclass
class DatasetSpec:
    """One dataset: an AnnData file plus how to present it."""

    id: str
    path: Path
    name: str = ""
    species: str = ""
    kind: str = "umap"  # umap | spatial
    description: str = ""
    layer: str | None = None
    groups: list[GroupSpec] = field(default_factory=list)
    embeddings: list[EmbeddingSpec] = field(default_factory=list)
    images: list[ImageSpec] = field(default_factory=list)
    default_group: str | None = None
    default_embedding: str | None = None
    units: str | None = None
    bin_size: float | None = None
    max_features: int | None = None
    max_cells: int | None = None
    markers: dict[str, Any] = field(default_factory=dict)
    gene_details: Path | None = None

    @property
    def display(self) -> str:
        return self.name or self.id

    def group(self, name: str) -> GroupSpec | None:
        for g in self.groups:
            if g.name == name:
                return g
        return None

    def embedding(self, name: str) -> EmbeddingSpec | None:
        for e in self.embeddings:
            if e.name == name:
                return e
        return None


@dataclass
class Project:
    """A whole project: metadata + datasets."""

    root: Path
    name: str = "OmicsExplorer"
    subtitle: str = ""
    species: dict[str, dict[str, Any]] = field(default_factory=dict)
    ontology: dict[str, list[str]] = field(default_factory=dict)
    datasets: list[DatasetSpec] = field(default_factory=list)
    source: Path | None = None
    data_root: Path | None = None

    def dataset(self, ds_id: str) -> DatasetSpec | None:
        for d in self.datasets:
            if d.id == ds_id:
                return d
        return None

    @property
    def ids(self) -> list[str]:
        return [d.id for d in self.datasets]


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def _as_dict(value: Any, what: str) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ConfigError(f"{what} must be a mapping, got {type(value).__name__}")
    return value


def _resolve_path(raw: str, root: Path) -> Path:
    p = Path(os.path.expandvars(os.path.expanduser(str(raw))))
    if not p.is_absolute():
        p = (root / p).resolve()
    return p


def _parse_groups(raw: Any, ds_id: str) -> list[GroupSpec]:
    """Accept both a list of column names and a mapping of name -> spec."""
    if raw is None:
        return []
    groups: list[GroupSpec] = []
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, str):
                groups.append(GroupSpec(name=item, column=item))
            elif isinstance(item, dict):
                name = item.get("name") or item.get("id")
                column = item.get("column", name)
                if not name:
                    raise ConfigError(f"dataset '{ds_id}': group entry needs a name")
                groups.append(GroupSpec(name=name, column=column, label=item.get("label", "")))
            else:
                raise ConfigError(f"dataset '{ds_id}': cannot read group entry {item!r}")
    elif isinstance(raw, dict):
        for name, spec in raw.items():
            if isinstance(spec, str):
                groups.append(GroupSpec(name=name, column=spec))
            elif spec is None:
                groups.append(GroupSpec(name=name, column=name))
            elif isinstance(spec, dict):
                groups.append(
                    GroupSpec(
                        name=name,
                        column=spec.get("column", name),
                        label=spec.get("label", "") or spec.get("title", ""),
                    )
                )
            else:
                raise ConfigError(f"dataset '{ds_id}': cannot read group '{name}'")
    else:
        raise ConfigError(f"dataset '{ds_id}': 'groups' must be a list or a mapping")
    seen: set[str] = set()
    for g in groups:
        if g.name in seen:
            raise ConfigError(f"dataset '{ds_id}': duplicate group '{g.name}'")
        seen.add(g.name)
    return groups


_EMBEDDING_KINDS = {"umap", "spatial", "pca", "tsne", "mds", "other"}


def _parse_embeddings(raw: Any, ds_id: str) -> list[EmbeddingSpec]:
    if raw is None:
        return []
    embeddings: list[EmbeddingSpec] = []
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, str):
                embeddings.append(EmbeddingSpec(name=item, label=item, obsm=item))
            elif isinstance(item, dict):
                name = item.get("name") or item.get("id")
                if not name:
                    raise ConfigError(f"dataset '{ds_id}': embedding entry needs a name")
                embeddings.append(_embedding_from_dict(name, item, ds_id))
            else:
                raise ConfigError(f"dataset '{ds_id}': cannot read embedding {item!r}")
    elif isinstance(raw, dict):
        for name, spec in raw.items():
            if isinstance(spec, str):
                spec = {"obsm": spec}
            spec = dict(_as_dict(spec, f"dataset '{ds_id}' embedding '{name}'"))
            spec.setdefault("name", name)
            embeddings.append(_embedding_from_dict(name, spec, ds_id))
    else:
        raise ConfigError(f"dataset '{ds_id}': 'embeddings' must be a list or a mapping")
    return embeddings


def _embedding_from_dict(name: str, spec: dict[str, Any], ds_id: str) -> EmbeddingSpec:
    kind = str(spec.get("kind", "umap")).lower()
    if kind not in _EMBEDDING_KINDS:
        kind = "other"
    dims = spec.get("dims", (0, 1))
    if isinstance(dims, int):
        dims = (0, dims)
    dims = (int(dims[0]), int(dims[1]))
    obs = spec.get("obs")
    if obs is not None:
        if isinstance(obs, str):
            obs = [obs]
        obs = tuple(str(o) for o in obs)
        if len(obs) != 2:
            raise ConfigError(f"dataset '{ds_id}': embedding '{name}' needs exactly two obs columns")
    return EmbeddingSpec(
        name=name,
        label=spec.get("label", "") or spec.get("title", ""),
        kind=kind,
        obsm=spec.get("obsm"),
        obs=obs,
        dims=dims,
    )


def _parse_images(raw: Any, ds_id: str, root: Path, data_root: Path | None = None) -> list[ImageSpec]:
    if raw is None:
        return []
    if isinstance(raw, str):
        raw = [{"path": raw}]
    if isinstance(raw, dict):
        raw = [dict(v or {}, path=k) for k, v in raw.items()]
    images: list[ImageSpec] = []
    for item in raw:
        if isinstance(item, str):
            item = {"path": item}
        path = item.get("path") or item.get("file")
        if not path:
            raise ConfigError(f"dataset '{ds_id}': image entry needs a path")
        base = data_root if (data_root is not None and not Path(path).is_absolute()) else root
        images.append(
            ImageSpec(
                path=str(_resolve_path(path, base)),
                label=item.get("label", "") or item.get("title", ""),
                transform=dict(item.get("transform") or {}),
            )
        )
    return images


# --------------------------------------------------------------------------
# loading
# --------------------------------------------------------------------------


def _merge_raw(base: dict, override: dict) -> dict:
    """Merge an override mapping into the manifest (lists are replaced)."""
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge_raw(out[key], value)
        else:
            out[key] = value
    return out


def load_project(path: str | Path) -> Project:
    """Load and validate a ``project.yaml``.

    A project may also have a ``datasets.auto.yaml`` next to the manifest, in
    which datasets added at runtime through the web UI live.  Those are
    appended after the ones declared in the manifest (manifest ids win).
    """
    src = Path(path).expanduser()
    if src.is_dir():
        src = src / "project.yaml"
    if not src.exists():
        raise ConfigError(f"project manifest not found: {src}")
    with src.open("r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh) or {}
    if not isinstance(raw, dict):
        raise ConfigError(f"{src}: top level must be a mapping")

    root = src.parent.resolve()

    # a local.yaml next to the manifest overrides it - the place for the
    # machine specific bits (where the data lives) that stay out of the repo
    local = root / "local.yaml"
    if local.exists():
        with local.open("r", encoding="utf-8") as fh:
            override = yaml.safe_load(fh) or {}
        if not isinstance(override, dict):
            raise ConfigError(f"{local}: top level must be a mapping")
        raw = _merge_raw(raw, override)
    data_root_raw = raw.get("data_root")
    data_root = _resolve_path(data_root_raw, root) if data_root_raw else None
    project = Project(
        root=root,
        name=str(raw.get("name") or "OmicsExplorer"),
        subtitle=str(raw.get("subtitle") or ""),
        species=_as_dict(raw.get("species"), "species"),
        ontology=dict(_as_dict(_as_dict(raw.get("ontology"), "ontology").get("cell_types"), "ontology.cell_types")),
        source=src,
        data_root=data_root,
    )

    datasets_raw = raw.get("datasets")
    if datasets_raw is None:
        # an empty project is valid: every dataset can be added via the web UI
        datasets_raw = []
    if not isinstance(datasets_raw, list):
        raise ConfigError(f"{src}: 'datasets' must be a list")

    seen: set[str] = set()
    for item in datasets_raw:
        item = _as_dict(item, "dataset entry")
        ds_id = str(item.get("id") or "").strip()
        if not ds_id:
            raise ConfigError(f"{src}: every dataset needs an 'id'")
        if ds_id in seen:
            raise ConfigError(f"{src}: duplicate dataset id '{ds_id}'")
        seen.add(ds_id)

        raw_path = item.get("path") or item.get("h5ad") or item.get("file")
        if not raw_path:
            raise ConfigError(f"dataset '{ds_id}': 'path' is required")
        ds_path = _resolve_path(raw_path, root)
        if data_root is not None and not Path(raw_path).is_absolute():
            ds_path = _resolve_path(str(Path(raw_path)), data_root)

        ds = DatasetSpec(
            id=ds_id,
            path=ds_path,
            name=str(item.get("name") or ds_id),
            species=str(item.get("species") or ""),
            kind=str(item.get("kind") or "umap").lower(),
            description=str(item.get("description") or ""),
            layer=item.get("layer"),
            groups=_parse_groups(item.get("groups"), ds_id),
            embeddings=_parse_embeddings(item.get("embeddings"), ds_id),
            images=_parse_images(item.get("images"), ds_id, root, data_root),
            default_group=item.get("default_group"),
            default_embedding=item.get("default_embedding"),
            units=item.get("units"),
            bin_size=item.get("bin_size"),
            max_features=item.get("max_features"),
            max_cells=item.get("max_cells"),
            markers=dict(item.get("markers") or {}),
            gene_details=(
                _resolve_path(item["gene_details"], data_root or root)
                if item.get("gene_details")
                else None
            ),
        )
        if ds.kind not in ("umap", "spatial", "other"):
            raise ConfigError(f"dataset '{ds_id}': unknown kind '{ds.kind}'")
        project.datasets.append(ds)

    # ---- datasets added at runtime (web UI) ------------------------------
    _merge_auto_manifest(project, root, data_root, seen)

    # ---- datasets deleted through the web UI ----------------------------
    removed = _read_removed(root)
    if removed:
        project.datasets = [d for d in project.datasets if d.id not in removed]

    return project


_AUTO_MANIFEST = "datasets.auto.yaml"


def _auto_manifest(root: Path) -> Path:
    return Path(root) / _AUTO_MANIFEST


def _read_removed(root: Path) -> set[str]:
    """Ids of the datasets that were deleted through the web UI."""
    auto = _auto_manifest(root)
    if not auto.exists():
        return set()
    try:
        with auto.open("r", encoding="utf-8") as fh:
            raw = yaml.safe_load(fh) or {}
    except yaml.YAMError:
        return set()
    if not isinstance(raw, dict):
        return set()
    return {str(x) for x in (raw.get("removed") or [])}


def _merge_auto_manifest(project: Project, root: Path, data_root: Path | None, seen: set[str]) -> None:
    """Append datasets from ``datasets.auto.yaml`` (added via the web UI)."""
    auto = _auto_manifest(root)
    if not auto.exists():
        return
    try:
        with auto.open("r", encoding="utf-8") as fh:
            raw = yaml.safe_load(fh) or {}
    except yaml.YAMLError:
        return
    entries = raw.get("datasets") if isinstance(raw, dict) else raw
    if not isinstance(entries, list):
        return
    for item in entries:
        if not isinstance(item, dict):
            continue
        ds_id = str(item.get("id") or "").strip()
        if not ds_id or ds_id in seen:
            continue
        raw_path = item.get("path") or item.get("h5ad") or item.get("file")
        if not raw_path:
            continue
        ds_path = _resolve_path(raw_path, root)
        if data_root is not None and not Path(raw_path).is_absolute():
            ds_path = _resolve_path(str(Path(raw_path)), data_root)
        seen.add(ds_id)
        project.datasets.append(
            DatasetSpec(
                id=ds_id,
                path=ds_path,
                name=str(item.get("name") or ds_id),
                species=str(item.get("species") or ""),
                kind=str(item.get("kind") or "umap").lower(),
                description=str(item.get("description") or ""),
                layer=item.get("layer"),
                groups=_parse_groups(item.get("groups"), ds_id),
                embeddings=_parse_embeddings(item.get("embeddings"), ds_id),
                images=[],
                default_group=item.get("default_group"),
                default_embedding=item.get("default_embedding"),
                units=item.get("units"),
                bin_size=item.get("bin_size"),
            )
        )


# --------------------------------------------------------------------------
# auto-detection (used when the manifest stays silent)
# --------------------------------------------------------------------------

_SPATIAL_HINTS = ("spatial", "slide", "visium", "xenium", "stereo", "tissue", "coord")
_UMAP_HINTS = ("umap", "tsne", "mds")
_PCA_HINTS = ("pca", "rpca", "harmony", "integrated", "ipca", "draw_graph")


def guess_embedding_kind(name: str) -> str:
    low = name.lower()
    if any(h in low for h in _SPATIAL_HINTS):
        return "spatial"
    if any(h in low for h in _UMAP_HINTS):
        return "umap"
    if any(h in low for h in _PCA_HINTS):
        return "pca"
    return "other"


def guess_group_label(column: str) -> str:
    pretty = column.replace("_", " ").strip()
    return pretty[:1].upper() + pretty[1:] if pretty else column


def unique_name(base: str, taken: Iterable[str]) -> str:
    taken = set(taken)
    if base not in taken:
        return base
    i = 2
    while f"{base}_{i}" in taken:
        i += 1
    return f"{base}_{i}"
