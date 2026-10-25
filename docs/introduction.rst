Introduction
============

DFDashboard is the interactive visualization layer of the DataFlowX suite.
It turns DFTracer traces (``.pfw`` / ``.pfw.gz``) into a fast, pannable,
zoomable timeline in the browser. A FastAPI backend queries the
dftracer-utils C++ index on demand and streams the result to a SolidJS
single-page app that renders the timeline on canvas, so the client never
loads the whole trace.

Features
--------

- Perfetto-style timeline on canvas: smooth pan/zoom, pid/tid lanes, depth
  stacking, hover tooltips, and click-to-inspect arbitrary event ``args``.
  Each viewport change re-queries the backend at the right level of detail.
- Counter overlays for ``ph="C"`` events (system, aggregate, and profile
  families), with per-pid and per-node splits and per-host telemetry drawn on
  the node tracks.
- Flamegraph and density overview for hot call paths and dead time.
- Analysis panels built on Dask and Panel, embeddable next to the timeline
  or on their own.

Architecture
------------

The frontend is imperative canvas for the 60fps path, with SolidJS driving only
the UI chrome. The backend serves Arrow IPC for the timeline stream and JSON for
counters, density, and stats. Analysis runs on an in-process Dask cluster by
default, or an external scheduler in service mode.

Installation
------------

DFDashboard requires Python 3.10 or newer. ``dftracer-utils`` (the trace index
bindings) is a core dependency and installs automatically.
It follows the develop-branch prereleases, so ``pyproject.toml`` asks for it with
a ``.dev0`` version floor.
A plain install resolves the newest prerelease without turning prereleases on
for every other package.

.. code-block:: bash

   pip install -e .

To develop against a local checkout of the bindings, install them editable on
top:

.. code-block:: bash

   pip install -e /path/to/dftracer-utils

Building the frontend
---------------------

The wheel carries the built SPA, so an installed package needs no flag. A
source checkout builds it once and serves it with ``--web-dist``:

.. code-block:: bash

   cd web
   npm ci
   npm run build            # -> web/dist

Quick start
-----------

Launch the dashboard with one or more trace files (a directory is expanded to
its ``*.pfw.gz`` files):

.. code-block:: bash

   dfdashboard-serve --trace run1.pfw.gz run2.pfw.gz --web-dist web/dist
   dfdashboard-serve --trace ./traces --web-dist web/dist

To follow a directory tree that gains new runs while the server runs, pass
``--watch`` with the root of that tree instead of ``--trace``. The server
rescans the tree, prefers a compact set from ``dftracer_split`` over the raw
files of the same run, and reports every change on ``/api/stream``. The layout
to write is in :doc:`runs`.

Then open ``http://127.0.0.1:5006``. Without ``--web-dist`` the API and Panel
dashboards are still served; only the SPA needs the built assets.

Useful options: ``--preset`` (``embedded`` for a local no-auth session, or
``service`` for auth with no idle timeout), ``--host`` / ``--port`` for the bind
address, ``--scheduler`` to attach an external Dask scheduler instead of a local
cluster, and ``--index-dir`` to override where the trace index is stored.

Docker
------

.. code-block:: bash

   docker build -t dfdashboard .
   docker run --rm -p 5006:5006 -v /path/to/traces:/data:ro dfdashboard

The image builds the SPA, installs the package, and serves traces mounted at
``/data``.
