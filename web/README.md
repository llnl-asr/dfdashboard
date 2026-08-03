# DFDashboard frontend

A Perfetto-style trace timeline in SolidJS + Canvas, bundled by Vite into a
single `dist/index.html` (all JS/CSS inlined) that the FastAPI server serves as
the dashboard shell. Events cross the wire as Arrow IPC; the rest of the viz API
is JSON.

## Develop

```bash
npm install
npm run dev        # vite dev server on :5173, proxies /api to the backend on :5006
```

Run the backend in another terminal:

```bash
dfdashboard-serve --trace <trace-dir> --port 5006
```

## Build

```bash
npm run build      # writes dist/index.html (single file)
```

Serve it from the backend with `dfdashboard-serve --trace <dir> --web-dist web/dist`.

## Backend endpoints used

- `GET /api/info` - global time bounds, file count.
- `GET /api/viz/events.arrow?begin&end&query` - windowed events as Arrow IPC.
- `GET /api/viz/density|counters|stats|proctree|breaks|layers` - LOD blocks,
  I/O counters, aggregates, process tree, run gaps, I/O layers.
