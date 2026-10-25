Producing runs
==============

You have a pipeline that writes DFTracer traces, and you want the dashboard to follow them while they grow.
This page gives the directory to write and the three writes that make a run count as finished.
:doc:`runs` holds the full rules.

Write the raw files
-------------------

Give every run its own directory below one root, and write the raw traces into ``raw`` inside it.

.. code-block:: text

   <root>/<run>/raw/<process>.pfw.gz

Only ``.pfw.gz`` is read.
An uncompressed ``.pfw`` file is refused, so write with gzip on.

Split the run
-------------

The dashboard reads a compact set faster than the raw files, and it prefers a compact set when both are present.

.. code-block:: bash

   dftracer_split -d <root>/<run>/raw -o <root>/<run>/compact --compress

The split copies the ``end`` record of each source file into a chunk, which is how the server later proves that the set is complete.

Drop the marker
---------------

Write a marker after the last chunk lands.
``_SUCCESS`` is the default name, and ``--done-marker`` adds others.

.. code-block:: bash

   touch <root>/<run>/_SUCCESS

Serve the tree
--------------

.. code-block:: bash

   dfdashboard-serve --watch <root> --web-dist web/dist

The runs bar lists the run and marks it done.
``GET /api/runs`` reports the same state and the reason behind it.

Keep the raw set
----------------

A compact set with a raw set next to it is proven by the record counts of the raw files.
Without a raw set the server waits for the settle window before it calls the run done.
Keep the raw files, or write a marker, to avoid that wait.
