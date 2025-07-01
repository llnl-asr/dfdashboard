import warnings
from importlib.resources import files

from bokeh.layouts import column
from bokeh.server.server import Server
from bokeh.plotting import figure
from bokeh.sampledata.sea_surface_temperature import sea_surface_temperature
from bokeh.models import ColumnDataSource

import pandas as pd

import dfdashboard
import dfdashboard.perf_constants as pc
from dfdashboard.analyzer import (
    DFAnalyzer,
    setup_dask_cluster,
    update_dft_configuration,
)
from dfdashboard.cli_args import DFDashboardArgs, get_args, Arguments

DFDASHBOARD_PATH = files(dfdashboard)

warnings.filterwarnings("ignore")


def app(doc):
    original_df = sea_surface_temperature.copy().reset_index()
    original_df["time"] = pd.to_datetime(original_df["time"])

    source = ColumnDataSource(data=original_df)
    plot = figure(x_axis_type="datetime", y_range=(0, 25), y_axis_label="Temperature (Celcius)", title="Sea surface temperature")
    plot.line("time", "temperature", source=source)

    doc.add_root(column(plot))


# @TODO: make this generalizable for all apps
# Note that we pass arguments here, e.g.
# - maybe we can pass FQN and instantiate those FQN from user code
# - maybe user can pass json object that we can parse as conditions
def get_conditions():
    def _get_conditions_(json_object: dict):
        app_io_cond = "getitem" in json_object["name"] or (
            (json_object["cat"] == pc.PerfTracerCategory.FETCH_DATA.value)
            and (json_object["name"] == pc.PerfTracerFetchData.ITER.value)
        )
        compute_cond = (
            # all compute "category"
            ("compute" in json_object["cat"])
            # all compute "name"
            or ("compute" in json_object["name"])
            # constant-based
            # - training
            or (
                json_object["cat"] == pc.PerfTracerCategory.TRAIN_COMPUTE.value
                and (
                    (json_object["name"] == pc.PerfTracerTrainCompute.STEP)
                    or (json_object["name"] == pc.PerfTracerTrainCompute.FORWARD)
                    or (json_object["name"] == pc.PerfTracerTrainCompute.BACKWARD)
                )
            )
            # - validation/test
            or (
                json_object["cat"] == pc.PerfTracerCategory.TEST_COMPUTE.value
                and (
                    (json_object["name"] == pc.PerfTracerTestCompute.STEP)
                    or (json_object["name"] == pc.PerfTracerTestCompute.FORWARD)
                )
            )
            # some "relaxation for DLIO"
            or (json_object["name"] == "TorchFramework.compute")
            or (json_object["name"] == "TFFramework.compute")
        )
        io_cond = json_object["cat"] in ["POSIX", "STDIO"]
        return app_io_cond, compute_cond, io_cond

    return _get_conditions_


def parallel_sum(array, num_chunks=10):
    """
    Computes the sum of a NumPy array in parallel using Dask.

    Parameters:
        array (np.ndarray): The input array to sum.
        num_chunks (int): Number of chunks to split the array into.

    Returns:
        float: The total sum of the array.
    """

    import numpy as np
    import dask

    def chunk_sum(arr):
        return arr.sum()

    chunks = np.array_split(array, num_chunks)
    tasks = [dask.delayed(chunk_sum)(chunk) for chunk in chunks]
    total = dask.delayed(sum)(tasks)
    return total.compute()


def _main(args: Arguments):
    update_dft_configuration(
        verbose=args.dfanalyzer.verbose,
        workers=args.dfanalyzer.workers,
        time_granularity=args.dfanalyzer.time_granularity,
        conditions=get_conditions(),
        debug=args.dfanalyzer.debug,
        batch_size=args.dfanalyzer.batch_size,
        index_dir=str(args.dfanalyzer.index_dir) if args.dfanalyzer.index_dir is not None else None,
        # dask_scheduler=str(args.dask_scheduler) if args.dask_scheduler is not None else None,
        rebuild_index=args.dfanalyzer.rebuild_index,
    )

    server = Server(
        {
            "/": app,
        },
        num_procs=1,
        adress=args.address,
        port=args.port,
    )

    setup_dask_cluster(dask_scheduler=args.dask_scheduler)

    import numpy as np
    data = np.random.rand(1_000_000)
    result = parallel_sum(data)
    print("Result", result)

    try:
        server.start()
        print(f"Open DFDashboard on http://{args.address}:{server.port}")
        server.io_loop.start()
    except KeyboardInterrupt:
        server.stop()


def main():
    args = get_args()
    _main(args=args)
