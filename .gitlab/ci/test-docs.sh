#!/bin/bash
# Runs ON the allocated compute node (via
#   flux proxy <jobid> flux run -N 1 bash .gitlab/ci/test-docs.sh)
# inside podman containers mirroring the GitHub Actions python environment.
# NOTE: python:3.12 (not 3.11) - pyproject requires-python is ">=3.12".
# NOTE: dftracer-utils installs as a prebuilt wheel; its C++ extension needs
# libatomic/libgomp at runtime, installed in the smoke-check container below.
set -ex

PODMAN_STORE=/var/tmp/$USER/podman-root
PODMAN_RUNROOT=/var/tmp/$USER/podman-run
mkdir -p "$PODMAN_STORE" "$PODMAN_RUNROOT"
PODMAN="podman --root $PODMAN_STORE --runroot $PODMAN_RUNROOT"

# --user 0:0: container root maps to the host user under rootless podman, so
# the bind-mounted checkout stays readable even for images with a non-root USER.

$PODMAN run --rm --user 0:0 -v "$PWD:/ws" -w /ws docker.io/library/python:3.12 bash -ec '
  apt-get update -qq && apt-get install -y --no-install-recommends libatomic1 libgomp1
  pip install --quiet --upgrade pip
  pip install --quiet -e .
  python -c "import dfdashboard, dfdashboard.cli, dfdashboard.config, dfdashboard.server; print(\"dfdashboard import smoke check OK\")"
  dfdashboard-serve --help
'

$PODMAN run --rm --user 0:0 -v "$PWD:/ws" -w /ws docker.io/library/python:3.12 bash -ec '
  pip install --quiet --upgrade pip
  pip install --quiet -r docs/requirements.txt
  sphinx-build -b html docs public
'
