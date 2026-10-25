Docker
======

The image builds the browser app, installs the package and serves the traces mounted at ``/data``.

Build it from the root of the checkout.

.. code-block:: bash

   docker build -t dfdashboard .

Run it with a directory of traces.

.. code-block:: bash

   docker run --rm -p 5006:5006 -v /path/to/traces:/data:ro dfdashboard

Open http://127.0.0.1:5006.

The entry point already passes ``--host 0.0.0.0 --port 5006 --trace /data``.
Override the command to point the server at one file.

.. code-block:: bash

   docker run --rm -p 5006:5006 -v "$PWD/traces:/data:ro" dfdashboard --trace /data/run1.pfw.gz

Every other option is in ``dfdashboard-serve --help``.
