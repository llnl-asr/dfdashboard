Introduction
============

DFDashboard is the interactive visualization layer of the DataFlowX suite.
It serves a Bokeh web application that analyzes DFTracer trace files
(``.pfw.gz``) with Dask and renders interactive timelines, bandwidth
plots, and tables in the browser.

Features
--------

- Interactive Bokeh dashboard served over Tornado (default port 5006).
- Scalable trace analysis with Dask (local cluster or an external
  scheduler via ``--dask_scheduler``).
- Reads compressed DFTracer traces (``.pfw.gz``) using ``zindex_py``
  for random access into gzip files.
- Composable components (timelines, bandwidth timeline, tables) built on
  a small component/page/runtime framework (``dfdashboard.base``).
- Configurable via command-line flags or a JSON/YAML config file
  (``-c/--config``, via ``jsonargparse``).

Installation
------------

DFDashboard requires Python 3.12 or newer.

.. code-block:: bash

   pip install git+https://github.com/LLNL/DFDashboard.git@main

or from a local checkout:

.. code-block:: bash

   git clone https://github.com/LLNL/DFDashboard.git
   cd DFDashboard
   pip install -e .

Quick start
-----------

Launch the dashboard with one or more trace files:

.. code-block:: bash

   dfdashboard-serve --trace trace1.pfw.gz trace2.pfw.gz ...
   # or a glob over a directory of traces
   dfdashboard-serve --trace <DIR>/*.pfw.gz

Then open ``http://localhost:5006`` in a browser. Useful options include
``--address`` and ``--port`` for the HTTP server, ``--log_level`` /
``--log_file`` for logging, and analyzer options under the
``--dfanalyzer.*`` prefix (e.g. ``--dfanalyzer.workers``,
``--dfanalyzer.rebuild_index``, ``--dfanalyzer.time_granularity``).
