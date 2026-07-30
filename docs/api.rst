API Reference
=============

This page documents the main public modules of the ``dfdashboard``
package. The package exposes a single console entry point,
``dfdashboard-serve``, which maps to ``dfdashboard.app.main``.

dfdashboard.app
---------------

Application entry point. Parses arguments, configures logging, sets up
the Dask cluster and the ``DFAnalyzer``, registers the Bokeh
applications, and starts the Tornado HTTP server.

- ``main()`` — the ``dfdashboard-serve`` entry point.

dfdashboard.cli_args
--------------------

Command-line and config-file argument handling built on ``jsonargparse``.

- ``DFDashboardArgs`` — dashboard options: ``trace`` (required),
  ``address`` (default ``0.0.0.0``), ``port`` (default ``5006``),
  ``dask_scheduler``, ``log_level``, ``log_file``.
- ``DFAnalyzerArgs`` — analyzer options (``dfanalyzer.*`` prefix):
  ``workers``, ``time_granularity``, ``rebuild_index``, ``verbose``,
  ``trace_ext``, ``batch_size``, ``reset``, ``debug``,
  ``dask_scheduler``, ``index_dir``.
- ``get_args()`` — build the parser and return parsed arguments.

dfdashboard.analyzer
--------------------

Trace loading and analysis on Dask.

- ``DFAnalyzer`` — loads DFTracer traces, builds indexes with
  ``zindex_py``, and produces Dask dataframes for the dashboard.
- ``DFTConfiguration`` — analyzer configuration (batch size, workers,
  index directory, host pattern, ...).
- ``setup_dask_cluster()`` / ``update_dft_configuration()`` — helpers
  used by the application to configure Dask and the analyzer.

dfdashboard.base
----------------

The small framework the dashboard is composed from.

- ``component.DFDashboardComponent`` — base class for dashboard
  components; subclasses implement ``build(runtime)`` and return a Bokeh
  ``LayoutDOM``.
- ``page`` — page templating helpers for Bokeh documents.
- ``runtime`` — shared runtime state passed to components.

dfdashboard.components
----------------------

Built-in dashboard components: ``timeline``, ``bw_timeline`` (bandwidth
timeline), ``table``, ``polling`` and async utilities.

dfdashboard.http
----------------

Tornado/Bokeh serving layer.

- ``server.HTTPServer`` — the Tornado HTTP server wrapper.
- ``bokeh.setup_bokeh_apps()`` — registers Bokeh applications with the
  server.
- ``routing`` — URL routing helpers.

dfdashboard.logging
-------------------

Logging setup: ``LogLevel`` enum and ``configure_logging()``.
