#!/bin/bash
# Browser tests for the SPA. Runs ON the allocated compute node:
#   flux proxy <jobid> flux run -N 1 bash .gitlab/ci/test-e2e.sh
# The image ships chromium and node; python and the wheel set are installed into
# a venv because the server under test is the real dfdashboard-serve.
set -ex

PODMAN_STORE=/var/tmp/$USER/podman-root
PODMAN_RUNROOT=/var/tmp/$USER/podman-run
mkdir -p "$PODMAN_STORE" "$PODMAN_RUNROOT"
PODMAN="podman --root $PODMAN_STORE --runroot $PODMAN_RUNROOT"

DIST_WHEELS="${DFTRACER_DIST_ROOT:-/usr/workspace/dldl/dftracer/distributions}/wheels"
[ -d "$DIST_WHEELS" ] || { echo "ERROR: $DIST_WHEELS not readable"; exit 1; }
SUITE='dftracer-utils>=0.0.11.dev0'

# The SPA must be built: the server serves web/dist, so an editable install
# without a bundle has nothing to serve.
$PODMAN run --rm --user 0:0 -v "$PWD:/ws" -w /ws \
  -v "$DIST_WHEELS:/wheels:ro" -e PIP_FIND_LINKS=/wheels -e SUITE="$SUITE" \
  mcr.microsoft.com/playwright:v1.64.0-jammy bash -ec '
  export DEBIAN_FRONTEND=noninteractive
  apt-get -o APT::Sandbox::User=root update -qq
  apt-get -o APT::Sandbox::User=root install -y -qq --no-install-recommends python3.12 python3.12-venv libatomic1 libgomp1
  python3.12 -m venv /venv
  . /venv/bin/activate
  pip install --quiet --upgrade pip
  pip install --quiet $SUITE
  pip install --quiet -e .
  ( cd web && npm ci --silent && npm run build >/dev/null )
  ( cd web && npx playwright test -c tests/e2e/playwright.config.ts )
'
