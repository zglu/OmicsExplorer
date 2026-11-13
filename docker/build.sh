#!/bin/sh
# Build the OmicsExplorer image and clean up the previous build.
#
#   ./docker/build.sh                                  # the full image (R + Seurat)
#   ./docker/build.sh omicsexplorer:slim --build-arg WITH_R=0 \
#       --build-arg BASE_IMAGE=python:3.12-slim-bookworm
#   ./docker/build.sh omicsexplorer:dev --target dev   # any docker build args
#
# Rebuilding with the same tag takes the tag away from the old image - it is
# left behind as a <none> repository.  This script removes exactly that old
# image afterwards (and nothing else).
set -eu

IMAGE="omicsexplorer:latest"
if [ "$#" -gt 0 ]; then
    case "$1" in
        -*) ;;  # a docker build flag - keep the default tag
        *) IMAGE="$1"; shift ;;
    esac
fi
HERE="$(cd "$(dirname "$0")/.." && pwd)"

OLD="$(docker images "$IMAGE" -q | head -1 || true)"

echo "==> building ${IMAGE}"
docker build -t "$IMAGE" "$@" "$HERE"

# the previous image lost its tag -> <none>:<none> - drop just that one
if [ -n "${OLD:-}" ]; then
    docker rmi "$OLD" 2>/dev/null || true
fi

echo "==> done: ${IMAGE}"
