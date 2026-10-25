#!/bin/bash
# Runs ON the allocated compute node. Builds the image and checks it starts:
# the three stages fail independently (npm ci, uv resolve, runtime libs), and
# only running the entrypoint proves the venv and the SPA landed where the
# ENTRYPOINT expects them.
set -ex

PODMAN_STORE=/var/tmp/$USER/podman-root
PODMAN_RUNROOT=/var/tmp/$USER/podman-run
mkdir -p "$PODMAN_STORE" "$PODMAN_RUNROOT"
PODMAN="podman --root $PODMAN_STORE --runroot $PODMAN_RUNROOT"

TAG="localhost/dfdashboard:ci-${CI_PIPELINE_ID:-local}"

cleanup() { $PODMAN rmi -f "$TAG" || true; }
trap cleanup EXIT

$PODMAN build -t "$TAG" .

# Appended to the ENTRYPOINT, replacing the CMD.
$PODMAN run --rm "$TAG" --help

$PODMAN run --rm --entrypoint /bin/sh "$TAG" -c '
  pkg=$(/opt/venv/bin/python -c "import dftracer.dashboard, os; print(os.path.dirname(dftracer.dashboard.__file__))")
  test -s "$pkg/web_dist/index.html"
  /opt/venv/bin/python -c "import dftracer.dashboard.server"
'
