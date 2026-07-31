#!/bin/bash
# Runs ON the allocated compute node (via
#   flux proxy <jobid> flux run -N 1 bash .gitlab/ci/test-docs.sh)
# inside podman containers mirroring the GitHub Actions python environment.
# NOTE: python:3.12 (not 3.11) — pyproject requires-python is ">=3.12".
# NOTE: the old CC=gcc/CXX=g++ workaround for zindex_py is unnecessary here —
# the container already builds with gcc, not the Cray wrappers.
set -ex

PODMAN_STORE=/var/tmp/$USER/podman-root
PODMAN_RUNROOT=/var/tmp/$USER/podman-run
mkdir -p "$PODMAN_STORE" "$PODMAN_RUNROOT"
PODMAN="podman --root $PODMAN_STORE --runroot $PODMAN_RUNROOT"

# --user 0:0: container root maps to the host user under rootless podman, so
# the bind-mounted checkout stays readable even for images with a non-root USER.

$PODMAN run --rm --user 0:0 -v "$PWD:/ws" -w /ws docker.io/library/python:3.12 bash -ec '
  pip install --quiet --upgrade pip
  pip install --quiet -e .
  # jsonargparse/pyarrow are imported by cli_args.py/analyzer.py but are not
  # declared in pyproject.toml (upstream packaging gap).
  pip install --quiet jsonargparse pyarrow
  python -c "import dfdashboard, dfdashboard.app, dfdashboard.cli_args, dfdashboard.analyzer; print(\"dfdashboard import smoke check OK\")"
  dfdashboard-serve --help
'

$PODMAN run --rm --user 0:0 -v "$PWD:/ws" -w /ws docker.io/library/python:3.12 bash -ec '
  pip install --quiet --upgrade pip
  pip install --quiet -r docs/requirements.txt
  sphinx-build -b html docs public
'
