Architecture
============

This page describes the parts of the dashboard and the reason for each one.

The browser and the server
--------------------------

The server is a FastAPI application. The browser is a SolidJS single-page app.
The server reads traces through the dftracer-utils index and sends data to the app as Arrow IPC or as JSON.
The app draws the timeline on canvas and uses Solid components for the rail, the run bar and the forms.

Time windows
------------

The app holds one time window. A pan or a zoom sends the new window to the server.
The server adds the user's filter to the window and asks the index for those events only, so a request reads the bytes that hold them and nothing else.
The cost of a request follows the size of the window, not the size of the trace.

Where the queries run
---------------------

Grouping, joins and windows are written as an engine plan and run inside the engine.
Python builds the plan and shapes the result. It does not read rows one by one.
The call tree shows the difference on a trace of 1.4 million rows. A Python kernel took about 800 ms and the engine fold takes about 50 ms.

Questions and payloads
----------------------

One view asks one question over one window.
A question holds the columns it reads, the plan it builds and the function that turns the resulting frame into a payload.
Plans are values, so two questions that need the same columns share one scan.

The payload of a question is a typed dictionary in ``trace/questions/types.py``.
The API serves that dictionary as it is, and the browser reads the same fields, so a payload change starts in that file.

Rendering
---------

The timeline is drawn on canvas. Pan, zoom, hover and the counter overlays change pixels without a virtual DOM in the path.
Solid updates the chrome around the canvas.

The overview cards
------------------

The cards are Bokeh objects that Panel renders in the server process.
The page holds one session over a websocket and replaces the card elements when the window changes.
The window filter sends the new bounds and the server repaints the cards.
The browser bundle carries the app shell and none of the panel code.

Runs on disk
------------

A directory is the unit the server follows, not a list of files on a command line.
The watcher scans a root and makes one run from each directory that holds trace files.
A compact set wins over the raw files of the same run.
:doc:`runs` is the reference for the layout and for the completion rules.

Module map
----------

``dftracer.dashboard.cli``
   The ``dfdashboard-serve`` entry point and its argument parser.

``dftracer.dashboard.config``
   Settings built on pydantic-settings with the ``DFDASHBOARD_`` environment prefix, and the two presets.

``dftracer.dashboard.server``
   ``create_app`` builds the ASGI app, mounts the routers, opens the trace index and serves the SPA.

``dftracer.dashboard.api``
   The routers. Each one adapts an HTTP request to a call in the layer below.

``dftracer.dashboard.trace``
   The trace layer. ``TraceData`` opens a file set, the ``questions`` package holds one descriptor per question, and ``counters``, ``slices`` and ``tree`` build their payloads.

``dftracer.dashboard.data``
   The files on disk. The watcher over a run tree, provenance extraction, and the payload types those two produce.

``dftracer.dashboard.compute``
   The Dask cluster and the worker glue.

``dftracer.dashboard.runtime``
   The task backend, the event bus, the thread pools and the log hub.

``dftracer.dashboard.cards``
   The twelve overview cards, as Panel viewers over the trace questions.

``dftracer.dashboard.analysis``
   The analysis pipelines and the Panel mount that embeds them.
