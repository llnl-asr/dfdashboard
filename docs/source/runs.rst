Run directories
===============

This page is the contract between a trace producer and DFDashboard.
It lists the layout the server reads and the rules it applies to that layout.

A run is one execution of an application.
The server finds runs by their trace files, so the unit you create on disk is the unit that appears in the dashboard.

Layout
------

.. code-block:: text

   <root>/                              pass this to --watch
     <run>/                             one run, id is the path relative to <root>
       raw/                             original files, one per process
         elmerfold-1033-app.pfw.gz
       compact/                         dftracer_split output, preferred
         app-1_chunk0.pfw.gz
       _SUCCESS                         optional marker, this run is finished

The shape is free.
Both trees below are also read.

.. code-block:: text

   <root>/20260930_234947/*.pfw.gz               trace files straight in the run directory
   <root>/20261001_124333/raw/*.pfw.gz           one format directory, no compact set

Rules
-----

- Any directory that holds trace files is a run, at any depth.
  The run id is its path relative to the watched root, after format directory names are removed.
- Only ``.pfw.gz`` is read.
  The engine refuses an uncompressed trace with ``dftracer traces must be gzip-compressed``, so run ``dftracer_split --compress``.
- The names ``raw``, ``raws``, ``compact``, ``split``, ``chunks``, ``merged`` and ``traces`` are format directory names.
  A run keeps its id above them, so ``20261001_124333/raw`` is the run ``20261001_124333``.
- A compact set always wins over a raw set of the same run.
  Both hold the same records, so reading both would count every event twice.
- A file named ``*_chunk<N>.pfw.gz`` marks a compact set.
  The detector reads file names, not directory names, so a renamed directory changes nothing.
- A directory whose name starts with a dot is skipped.
  The server keeps its index in ``--index-dir``, outside the tree.
- Run order is by first timestamp in band order, so a directory name never decides the order.
  A run with no records yet sorts last.

Watcher
-------

The watcher uses kernel events on a local filesystem and a stat poll on a network filesystem such as NFS or Lustre, because a write from another node produces no local event.
``GET /api/runs`` reports which one is in use.

``--watch`` rescans the tree while the server runs.
``--trace`` opens a fixed set of files and never rescans.

Completion
----------

A run is ``live`` while it is still being written, ``done`` when it is finished, and ``stalled`` when nothing changed for ``--stall`` seconds and the run is not done.
``GET /api/runs`` reports the reason next to the state, so a run that says ``done`` also says how that was proven.
:doc:`api/index` points at the response shape.

.. list-table::
   :header-rows: 1

   * - Reason
     - Applies to
     - How it is decided
   * - ``marker``
     - raw and compact
     - A marker file is present in the run directory or in its format directory.
   * - ``end-record``
     - raw
     - Every file ends with the ``end`` record that the DFTracer writer emits.
   * - ``verified``
     - compact
     - The ``end`` records the set holds match the raw set it was split from.
   * - ``quiet``
     - compact
     - No raw set is present and nothing changed for ``--settle`` seconds.
   * - ``writing``
     - all
     - Not finished. This is the reason for a ``live`` or ``stalled`` state.

A marker file is the fastest and most direct signal, because the producer writes it after the last trace record.
The default names are ``_SUCCESS``, ``.done``, ``manifest.json`` and ``split.json``.
Add more names with ``--done-marker``.

A raw set needs no marker.
Each file ends with an ``end`` record that carries ``num_events``, so the last record of the file answers whether the file is complete.

A compact set is proven by the raw set.
``dftracer_split`` copies the ``end`` record of every source file into some chunk, so the count of those records and the sum of their ``num_events`` must equal the raw set.
A split that is still running falls short, which makes the check exact and needs no cooperation.

A compact set with no raw set next to it is the one case without a proof.
The server then waits for ``--settle`` seconds without a write.
Keep the raw set, or have the split script write a marker, to avoid that wait.
