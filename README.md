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
- **Analysis dashboards** built on Dask and Panel, embeddable next to the
  timeline or on their own.
- **Notebook widget**: the same timeline as an embeddable
  [anywidget](https://anywidget.dev/) for Jupyter, fed over the widget comm.

## Architecture

```
browser SPA (SolidJS + canvas)  <-- HTTP -->  FastAPI (dfdashboard.server)
notebook widget (anywidget)     <-- comm -->        |
                                                    v
                                   dftracer-utils bindings (C++ index)
                                   Dask (analysis pipelines)
```

The frontend is imperative canvas for the 60fps path with Solid driving only the
UI chrome. The backend serves Arrow IPC for the timeline stream and JSON for
counters, density, and stats. Analysis runs on an in-process Dask cluster by
default, or an external scheduler in service mode.

## Install

Requires Python 3.12+.

```bash
uv venv --python 3.12
source .venv/bin/activate
uv pip install -e .
```

`dftracer-utils` (the trace index bindings) and `dftracer-analyzer` are core
dependencies and install automatically. To develop against a local checkout of
the bindings, install them editable on top:

```bash
uv pip install -e /path/to/dftracer-utils
```

Optional extras: `scale` (datashader), `builder` (panel-graphic-walker), `mcp`
(fastmcp), `export` (weasyprint + playwright).

## Building the frontend

The Python package ships the notebook widget bundle, but the browser SPA is
built separately and served via `--web-dist`:

```bash
cd web
npm ci
npm run build            # -> web/dist (the SPA)
```

To rebuild the notebook widget bundle after changing `web/src/widget`:

```bash
npx vite build --config vite.widget.config.ts   # -> dfdashboard/widgets/static/timeline.js
```

## Running

```bash
dfdashboard-serve --trace run1.pfw.gz run2.pfw.gz --web-dist web/dist
# a directory is expanded to its *.pfw.gz files
dfdashboard-serve --trace ./traces --web-dist web/dist
```

Then open http://127.0.0.1:5006. Without `--web-dist` the API and Panel
dashboards are still served; only the SPA needs the built assets.

Key flags:

| Flag | Default | Purpose |
|------|---------|---------|
| `--trace` | (none) | trace files or directories |
| `--preset` | `embedded` | `embedded` (local, no auth) or `service` (auth, no idle timeout) |
| `--host` / `--port` | `127.0.0.1` / `5006` | bind address |
| `--web-dist` | (none) | directory holding the built SPA `index.html` |
| `--scheduler` | (none) | external Dask scheduler; default spawns a local cluster |
| `--index-dir` | per-user cache | where the trace index is stored |

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
