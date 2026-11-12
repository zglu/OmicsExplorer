#!/bin/sh
# Entrypoint of the OmicsExplorer container.
#
#   omicsexplorer-entrypoint serve -p /project/project.yaml
#   omicsexplorer-entrypoint build -p /project/project.yaml
#
# The project directory (default /project) holds project.yaml, the built
# bundle in data/, the uploaded files in uploads/ and their conversion cache.
set -eu

# the old name still works (backwards compatibility)
PROJECT_DIR="${OMICSEXPLORER_HOME:-${OMICEXPLORER_HOME:-/project}}"
MANIFEST="${PROJECT_DIR}/project.yaml"

# when the container runs as an arbitrary user (docker compose) R and the
# caches need a writable home
if [ ! -w "${HOME:-/nonexistent}" ]; then
    HOME=/tmp
    export HOME
fi
mkdir -p "${HOME}" 2>/dev/null || true

# create a starter project when the mounted directory is empty
if [ ! -f "$MANIFEST" ]; then
    echo "[omicsexplorer] no project.yaml in ${PROJECT_DIR} - creating an empty one"
    mkdir -p "$PROJECT_DIR"
    cat > "$MANIFEST" <<'YAML'
# OmicsExplorer project - add datasets here or through the web UI (+ Data).
name: My project
subtitle: single-cell & spatial atlas
datasets: []
YAML
fi

if [ "${1:-}" = "serve" ]; then
    shift
    # the bundle directory must exist (the server mounts it as a static route)
    mkdir -p "${PROJECT_DIR}/data"
    exec omicsexplorer serve "$@"
fi

exec omicsexplorer "$@"
