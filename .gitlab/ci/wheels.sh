#!/bin/bash
# Builds the SPA into the package, then the sdist and pure-python wheel.
# Without the SPA the wheel serves an API and no interface, so the npm build
# is part of packaging here rather than only a Dockerfile stage.
set -eox pipefail
cd "$CI_PROJECT_DIR"

base=$(sed -n 's/^version = "\(.*\)"/\1/p' pyproject.toml | head -1)
[ -n "$base" ] || { echo "ERROR: no version in pyproject.toml"; exit 1; }

if described=$(git describe --tags --long --match 'v*' 2>/dev/null); then
  tag=${described%-*-g*}
  distance=${described#"$tag"-}
  distance=${distance%-g*}
  base=${tag#v}
else
  distance=$(git rev-list --count HEAD)
fi

if [ "$distance" = "0" ]; then
  VERSION="$base"
else
  VERSION="$base.post$distance.dev0"
fi
echo "building version $VERSION"

PODMAN_STORE=/var/tmp/$USER/podman-root
PODMAN_RUNROOT=/var/tmp/$USER/podman-run
mkdir -p "$PODMAN_STORE" "$PODMAN_RUNROOT"
PODMAN="podman --root $PODMAN_STORE --runroot $PODMAN_RUNROOT"

rm -rf wheelhouse python/dftracer/dashboard/web_dist
$PODMAN run --rm --user 0:0 -v "$PWD:/ws" -w /ws/web docker.io/library/node:20-slim bash -ec '
  npm ci
  npm run build
'
cp -r web/dist python/dftracer/dashboard/web_dist
test -s python/dftracer/dashboard/web_dist/index.html

# hatchling offers no version override, and the checkout is disposable.
sed -i "s/^version = \".*\"/version = \"$VERSION\"/" pyproject.toml

$PODMAN run --rm --user 0:0 -v "$PWD:/ws" -w /ws docker.io/library/python:3.12 bash -ec '
  pip install --quiet --upgrade pip build
  DFDASHBOARD_SKIP_WEB=1 python3 -m build --outdir wheelhouse .
'
git checkout -- pyproject.toml

# The wheel is only useful if the SPA actually rode along.
$PODMAN run --rm --user 0:0 -v "$PWD:/ws" -w /ws docker.io/library/python:3.12 bash -ec '
  python3 -c "
import glob, zipfile, sys
whl = glob.glob(\"wheelhouse/dftracer_dashboard-*.whl\")[0]
names = zipfile.ZipFile(whl).namelist()
assert \"dftracer/dashboard/web_dist/index.html\" in names, \"SPA missing from the wheel\"
print(f\"{whl}: SPA bundled\")
"
'
ls -1 wheelhouse
