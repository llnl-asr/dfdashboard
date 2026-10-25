API Reference
=============

This page documents the main public modules of the ``dftracer-dashboard`` package. The
package exposes a single console entry point, ``dfdashboard-serve``, which maps
to ``dftracer.dashboard.cli.main``.

dftracer.dashboard.cli
----------------------

Command-line entry point.

- ``parse_args(argv=None)`` - parse arguments into a ``Settings`` instance.
- ``main(argv=None)`` - the ``dfdashboard-serve`` entry point; builds the app
  and runs it under uvicorn.

dftracer.dashboard.config
-------------------------

Runtime configuration, built on ``pydantic-settings`` (environment prefix
``DFDASHBOARD_``).

- ``Settings`` - the configuration model: ``trace_paths``, ``preset``,
  ``scheduler_address``, ``host``, ``port``, ``web_dist``, ``index_dir``, and
  service knobs (``auth``, ``idle_timeout_s``).
- ``Preset`` - ``embedded`` (local, no auth) and ``service`` (auth, no idle
  timeout) presets over the same knobs.
- ``Settings.for_preset(preset, **overrides)`` - build settings for a preset.

dftracer.dashboard.server
-------------------------

The FastAPI application.

- ``create_app(settings)`` - build the ASGI app: mounts the viz/analysis
  routers and response compression, opens the trace index, starts the Dask
  cluster and task backend, and (with ``web_dist``) serves the SPA.

dftracer.dashboard.api
----------------------

The HTTP routers included by the app: ``viz_router`` (timeline stream, density,
counters, stats), ``tasks_router``, ``dashboard_router``, ``logs_router``, and
``runtime_router``.

dftracer.dashboard.data
-----------------------

The trace data layer over the dftracer-utils bindings.

- ``TraceData`` - opens and indexes the trace files and answers the viz queries
  (timeline stream, density, counters, proctree, breaks, stats).

dftracer.dashboard.compute
--------------------------

Dask cluster and worker glue.

- ``ClusterManager`` - owns a local ``LocalCluster`` or connects to an external
  scheduler and hands out clients.

dftracer.dashboard.runtime
--------------------------

The task and logging runtime.

- ``EventBus`` / ``InProcessTaskBackend`` - run analysis pipelines and publish
  progress events.
- ``logs.get_hub()`` - the log hub that captures Python logging and native
  dftracer-utils output for the log console.

dftracer.dashboard.analysis
---------------------------

Dask analysis pipelines, the built-in cards, and the Panel embedding
(``mount_panel``) used to serve analysis panels next to the timeline.

