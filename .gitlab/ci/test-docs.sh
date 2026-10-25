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

# dftracer-utils and dftracer-analyzer on PyPI are the stale review-mode
# releases; the current builds are workspace pre-releases. Naming a
# pre-release in the specifier below enables them for those two only --
# PIP_PRE would also pull dev releases of httpx, dask and the rest.
DIST_WHEELS="${DFTRACER_DIST_ROOT:-/usr/workspace/dldl/dftracer/distributions}/wheels"
[ -d "$DIST_WHEELS" ] || { echo "ERROR: $DIST_WHEELS not readable"; exit 1; }
PIP_ENV=(-v "$DIST_WHEELS:/wheels:ro" -e PIP_FIND_LINKS=/wheels)
SUITE='dftracer-utils>=0.0.11.dev0 dftracer-analyzer>=0.0.9.dev0' 

# --user 0:0: container root maps to the host user under rootless podman, so
# the bind-mounted checkout stays readable even for images with a non-root USER.

$PODMAN run --rm --user 0:0 -v "$PWD:/ws" -w /ws "${PIP_ENV[@]}" -e SUITE="$SUITE" docker.io/library/python:3.12 bash -ec '
  apt-get -o APT::Sandbox::User=root update -qq
  apt-get -o APT::Sandbox::User=root install -y -qq --no-install-recommends libatomic1 libgomp1
  pip install --quiet --upgrade pip
  pip install --quiet $SUITE
  pip install --quiet -e . pytest pytest-asyncio httpx
  python -c "import dftracer.dashboard, dftracer.dashboard.cli, dftracer.dashboard.config, dftracer.dashboard.server; print(\"dftracer.dashboard import smoke check OK\")"
  dfdashboard-serve --help
  pytest -v tests/
'

$PODMAN run --rm --user 0:0 -v "$PWD:/ws" -w /ws "${PIP_ENV[@]}" docker.io/library/python:3.12 bash -ec '
  pip install --quiet --upgrade pip
  pip install --quiet -r docs/requirements.txt
  # -W fails on a warning, -n also fails on an unresolved reference.
  sphinx-build -b html -E -W --keep-going -n docs public
'
