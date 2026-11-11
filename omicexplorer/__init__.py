"""OmicsExplorer - a local single-cell / spatial-omics visualisation platform."""

from __future__ import annotations

__version__ = "0.1.0"

from .config import Project, load_project  # noqa: F401

__all__ = ["Project", "load_project", "__version__"]
