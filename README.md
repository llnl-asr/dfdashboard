# DFDashboard

The interactive visualization layer of the DataFlowX suite. DFDashboard turns
[DFTracer](https://dftracer.readthedocs.io/) traces (`.pfw` / `.pfw.gz`) into a
fast, pannable, zoomable timeline in the browser, backed by the
[dftracer-utils](https://github.com/LLNL/dftracer-utils) C++ index so it stays
responsive on large traces.

## What you get

- **Perfetto-style timeline** rendered on canvas: smooth pan/zoom, pid/tid
  lanes, depth stacking, hover tooltips, and click-to-inspect arbitrary event
  `args`. Every viewport change re-queries the backend at the right level of
  detail, so the client never loads the whole trace.
- **Counter overlays** for `ph="C"` events (system, aggregate, and profile
  families), including per-pid and per-node splits and per-host telemetry drawn
  directly on the node tracks.
- **Flamegraph** and density overview for spotting hot call paths and dead time
  at a glance.
- **Analysis panels** built on Dask and Panel, embeddable next to the timeline
  or on their own.

## Architecture

```
browser SPA (SolidJS + canvas)  <-- HTTP -->  FastAPI (dftracer.dashboard.server)
                                                    |
                                                    v
                                   dftracer-utils bindings (C++ index)
                                   Dask (analysis pipelines)
```

The frontend is imperative canvas for the 60fps path with Solid driving only the
UI chrome. The backend serves Arrow IPC for the timeline stream and JSON for
counters, density, and stats. Analysis runs on an in-process Dask cluster by
default, or an external scheduler in service mode.

## Install

Requires Python 3.10+.

```bash
uv venv --python 3.10
source .venv/bin/activate
uv pip install -e .
```

`dftracer-utils` (the trace index bindings) is a core dependency and installs
automatically.
It follows the develop-branch prereleases, so `pyproject.toml` asks for it with a
`.dev0` version floor.
A plain install resolves the newest prerelease without turning prereleases on
for every other package.
To develop against a local checkout of the bindings, install them editable on
top:

```bash
uv pip install -e /path/to/dftracer-utils
```

Optional extras: `scale` (datashader), `builder` (panel-graphic-walker), `mcp`
(fastmcp), `export` (weasyprint + playwright).

## Building the frontend

The wheel carries the built SPA. A source checkout builds it once and serves it
with `--web-dist`:

```bash
cd web
npm ci
npm run build            # -> web/dist (the SPA)
```

Browser tests drive that built bundle against a real server, so they need both
halves in place:

```bash
cd web
npx playwright install chromium   # once
npm run e2e                        # tests/e2e, server started by the config
```

The suite writes its own run tree to `/tmp/dfdashboard-e2e` and serves it on
port 5099, so nothing else has to be running.

## Running

```bash
dfdashboard-serve --trace run1.pfw.gz run2.pfw.gz --web-dist web/dist
# a directory is expanded to its *.pfw.gz files
dfdashboard-serve --trace ./traces --web-dist web/dist
# follow a tree of runs that keeps growing
dfdashboard-serve --watch /path/to/runs --web-dist web/dist
```

Then open http://127.0.0.1:5006. Without `--web-dist` the API and Panel
dashboards are still served; only the SPA needs the built assets.

`--watch` rescans the tree while the server runs, so `/api/runs` follows a tree that keeps growing.
[Run directories](docs/runs.rst) describes the layout to write and how a finished run is recognised.
Every option is in `dfdashboard-serve --help`.

## Docker

```bash
docker build -t dfdashboard .
docker run --rm -p 5006:5006 -v /path/to/traces:/data:ro dfdashboard
```

The image builds the SPA, installs the package, and serves traces mounted at
`/data`. Point it elsewhere by overriding the trace argument:

```bash
docker run --rm -p 5006:5006 -v $PWD/traces:/data:ro dfdashboard --trace /data/run1.pfw.gz
```

## Development

```bash
pytest -q                       # backend tests
ruff check . && ty check dfdashboard
cd web && npm run test && npm run lint && npm run typecheck
```

Install the git hooks (ruff, ruff-format, and ty on staged Python) with
`pre-commit install`.

## License

DFDashboard is distributed under the terms of the MIT license.
All new contributions must be made under this license.

See [LICENSE](LICENSE) and [NOTICE](NOTICE) for details.

SPDX-License-Identifier: MIT

LLNL-CODE-2024514 — Applied Storage Research (ASR)
