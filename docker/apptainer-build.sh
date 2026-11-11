#!/bin/sh
# Build an Apptainer / Singularity image from the Dockerfile.
#
#   ./docker/apptainer-build.sh [output.sif]
#
# Step 1 needs a Docker daemon, step 2 needs apptainer (or singularity).
# Afterwards the image runs like the Docker one:
#
#   apptainer run --bind "$PWD/my_project:/project" omicexplorer.sif
set -eu

OUT="${1:-omicexplorer.sif}"
IMAGE="omicexplorer:latest"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> building the Docker image (${IMAGE})"
docker build -t "$IMAGE" "$HERE"

APPTAINER="$(command -v apptainer || command -v singularity || true)"
if [ -z "$APPTAINER" ]; then
    echo "error: neither apptainer nor singularity found" >&2
    exit 1
fi

echo "==> converting to ${OUT} with ${APPTAINER}"
"$APPTAINER" build "$OUT" "docker-daemon://${IMAGE}"

echo
echo "done: ${OUT}"
echo "run it with:"
echo "  ${APPTAINER} run --bind \"\$PWD/my_project:/project\" ${OUT}"
