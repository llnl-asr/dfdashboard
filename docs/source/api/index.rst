API reference
=============

The package exposes one command, ``dfdashboard-serve``, and an HTTP API under
``/api``.
The pages below are generated from the modules and the docstrings in them.

.. toctree::
   :maxdepth: 2

   app
   trace
   data
   runtime
   http
   ui

Command
-------

``dfdashboard-serve --help`` prints every option with its default, and it is the reference for the command.
This page does not repeat the options, since the list changes with the parser.

HTTP
----

The server publishes its own specification, built from the routes.

- ``GET /api/openapi.json`` is the OpenAPI document.
- ``GET /api/docs`` is the Swagger UI over the same document.
- ``GET /api/stream`` is the server-sent event feed. Its frames have no schema of their own.

Start the server and open ``http://127.0.0.1:5006/api/docs``.

Payloads
--------

Response bodies are typed dictionaries, declared once and served as they are.
The declarations are the source of truth, and they appear in the generated
pages.

- ``trace.questions.types`` holds the payload of each trace question.
- ``trace.counters`` holds the counter series and split payloads.
- ``data.run_types`` and ``data.prov_types`` hold the run snapshot and the provenance graph.
