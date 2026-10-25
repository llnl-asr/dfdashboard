:layout: landing
:description: A browser dashboard for DFTracer traces, the interactive visualization layer of the DataFlowX suite.

.. raw:: html

   <div class="dfd-hero">
     <h1>Look at a DFTracer trace in a browser</h1>
     <p class="dfd-tagline">DFDashboard reads <code>.pfw.gz</code> traces through the
     <a href="https://github.com/llnl-asr/dftracer-utils">dftracer-utils</a> C++ index and
     streams one time window at a time to a canvas timeline, so a trace of any size
     opens right away.</p>
   </div>

.. image:: _static/overview.png
   :alt: The DFDashboard Overview tab, with a summary strip, a run bar listing three runs and the overview cards.
   :class: dfd-hero-shot

.. grid:: 1 2 3 3
   :gutter: 3
   :class-container: sd-mb-4

   .. grid-item-card:: :octicon:`rocket` Getting started
      :link: getting-started
      :link-type: doc

      Go from a fresh clone to a served trace in six steps.

   .. grid-item-card:: :octicon:`list-ordered` Producing runs
      :link: producing-runs
      :link-type: doc

      Write the directory a producer needs so the dashboard follows a run
      while it grows.

   .. grid-item-card:: :octicon:`book` Run directories
      :link: runs
      :link-type: doc

      The reference for the layout, the watcher and the completion rules.

   .. grid-item-card:: :octicon:`gear` Shortcuts
      :link: shortcuts
      :link-type: doc

      The keys and mouse gestures of the timeline, and what each one does.

   .. grid-item-card:: :octicon:`code` API reference
      :link: api/index
      :link-type: doc

      The HTTP specification the server publishes and the command reference.

   .. grid-item-card:: :octicon:`light-bulb` Architecture
      :link: architecture
      :link-type: doc

      Why the browser streams, why the queries run in the engine and what each
      module owns.

   .. grid-item-card:: :octicon:`container` Docker
      :link: docker
      :link-type: doc

      Build the image and serve a directory of traces from it.

What it shows
-------------

.. grid:: 1 1 3 3
   :gutter: 2

   .. grid-item-card:: A timeline that keeps up

      Events, counters and one lane per thread on canvas.
      Pan, zoom and hover stay smooth because the server answers each window
      with only the events that window holds.

   .. grid-item-card:: The cost, next to the time

      Overview cards for bandwidth, latency, access pattern and the busiest
      process, rendered by the same trace queries that feed the views.

   .. grid-item-card:: Runs as directories

      Point the server at a tree of runs.
      It reports every new run, prefers a compact set from ``dftracer_split``
      and marks a run done when the producer says so.

.. toctree::
   :maxdepth: 2
   :hidden:

   getting-started
   producing-runs
   docker
   runs
   shortcuts
   api/index
   architecture
