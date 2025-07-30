# DFDashboard
The Interactive Visualization Layer of the DataFlowX Suite

## Installing package (dev)

```
DFTRACER_VERSION=develop
pip install git+https://github.com/LLNL/dftracer.git@main
pip install git+https://github.com/LLNL/dftracer.git@$main#egg=pydftracer
```

## Running

To launch the dashboard with one or more trace files, run:

```bash
dfdashboard-serve --trace trace1.pfw.gz trace2.pfw.gz ...
# or
dfdashboard-serve --trace <DIR>\*.pfw.gz
```