import logging
import warnings
from importlib.resources import files
from typing import Any, Optional, Dict

from distributed.utils import silence_logging_cmgr

from bokeh.plotting import figure
from bokeh.models import LayoutDOM

import dfdashboard
import dfdashboard.perf_constants as pc
from dfdashboard.analyzer import (
    DFAnalyzer,
    setup_dask_cluster,
    update_dft_configuration,
)
from dfdashboard.cli_args import get_args
from dfdashboard.logging import configure_logging
from dfdashboard.http.server import HTTPServer
from dfdashboard.http.bokeh import setup_bokeh_apps
from dfdashboard.base.component import DFDashboardComponent

warnings.filterwarnings("ignore")

DFDASHBOARD_PATH = files(dfdashboard)

log = logging.getLogger(__name__)


# --- Components -----------------------------------------------------


class DummyPlot(DFDashboardComponent):
    def build(self, runtime) -> LayoutDOM:
        p = figure(title="Static Dummy Plot", width=400, height=300)
        p.line(x=[1, 2, 3], y=[4, 6, 2], line_width=2)
        self.root = p
        return self.root


# --- Conditions for Analyzer ---------------------------------------------


def get_conditions(json_object: dict):
    app_io_cond = "getitem" in json_object["name"] or (
        (json_object["cat"] == pc.PerfTracerCategory.FETCH_DATA.value)
        and (json_object["name"] == pc.PerfTracerFetchData.ITER.value)
    )
    compute_cond = (
        ("compute" in json_object["cat"])
        or ("compute" in json_object["name"])
        or (
            json_object["cat"] == pc.PerfTracerCategory.TRAIN_COMPUTE.value
            and (
                (json_object["name"] == pc.PerfTracerTrainCompute.STEP)
                or (json_object["name"] == pc.PerfTracerTrainCompute.FORWARD)
                or (json_object["name"] == pc.PerfTracerTrainCompute.BACKWARD)
            )
        )
        or (
            json_object["cat"] == pc.PerfTracerCategory.TEST_COMPUTE.value
            and (
                (json_object["name"] == pc.PerfTracerTestCompute.STEP)
                or (json_object["name"] == pc.PerfTracerTestCompute.FORWARD)
            )
        )
        or (json_object["name"] == "TorchFramework.compute")
        or (json_object["name"] == "TFFramework.compute")
    )
    io_cond = json_object["cat"] in ["POSIX", "STDIO"]
    return app_io_cond, compute_cond, io_cond


def additional_columns_function(
    json_object, current_dict, time_approximate, condition_fn, load_data
):
    def convert_int(val: Any) -> Optional[int]:
        try:
            return int(val)
        except Exception:
            return None

    d = {}
    if "args" in json_object:
        if "step" in json_object["args"]:
            d["step"] = convert_int(json_object["args"]["step"])
        if "epoch" in json_object["args"]:
            d["epoch"] = convert_int(json_object["args"]["epoch"])
    return d


load_cols = {"step": "int64[pyarrow]", "epoch": "int64[pyarrow]"}


# --- Main Entry ----------------------------------------------------------


def silence_worker_log():
    logging.getLogger('distributed').setLevel(logging.CRITICAL)

def main():
    args = get_args()
    configure_logging(log_level=args.log_level, log_file=args.log_file)

    update_dft_configuration(
        verbose=args.dfanalyzer.verbose,
        workers=args.dfanalyzer.workers,
        time_granularity=args.dfanalyzer.time_granularity,
        conditions=get_conditions,
        debug=args.dfanalyzer.debug,
        batch_size=args.dfanalyzer.batch_size,
        index_dir=str(args.dfanalyzer.index_dir) if args.dfanalyzer.index_dir else None,
        rebuild_index=args.dfanalyzer.rebuild_index,
    )

    applications: Dict[str, Dict[str, Any]] = {
        "/": {
            "type": "tabs",
            "args": {"sizing_mode": "stretch_both"},
            "children": [
                {
                    "title": "Events",
                    "content": {
                        "type": "component",
                        "id": "events_table",
                        "args": {
                            "class_path": "dfdashboard.components.table.EventsTable",
                            "args": {},
                        },
                    },
                },
                {
                    "title": "Timeline",
                    "content": {
                        "type": "column",
                        "args": {
                            "spacing": 20,
                        },
                        "children": [
                            {
                                "type": "row",
                                "args": {
                                    "spacing": 20,
                                },
                                "children": [
                                    {
                                        "type": "component",
                                        "id": "bandwidth_timeline",
                                        "args": {
                                            "class_path": "dfdashboard.components.timeline.BandwidthTimeline",
                                            "args": {
                                                "time_col": "io_time",
                                                "figsize": (800, 400),
                                            },
                                        },
                                    },
                                    {
                                        "type": "component",
                                        "id": "xfer_timeline",
                                        "args": {
                                            "class_path": "dfdashboard.components.timeline.TransferSizeTimeline",
                                            "args": {
                                                "figsize": (800, 400),
                                            },
                                        },
                                    },
                                ],
                            },
                            {
                                "type": "row",
                                "children": [
                                    {
                                        "type": "component",
                                        "id": "dummy_plot",
                                        "args": {
                                            "class_path": "dfdashboard.app.DummyPlot",
                                        },
                                    },
                                    {
                                        "type": "component",
                                        "id": "polling_plot",
                                        "args": {
                                            "class_path": "dfdashboard.components.polling.DummyPollingPlot",
                                        },
                                    },
                                ],
                            },
                        ],
                    },
                },
            ],
        },
        "/demo": {
            "type": "row",
            "children": [
                {
                    "type": "component",
                    "id": "dummy_plot",
                    "args": {
                        "class_path": "dfdashboard.app.DummyPlot",
                    },
                },
                {
                    "type": "component",
                    "id": "polling_plot",
                    "args": {
                        "class_path": "dfdashboard.components.polling.DummyPollingPlot",
                    },
                },
            ],
        },
    }

    with silence_logging_cmgr(logging.CRITICAL):
        try:
            server = HTTPServer()
            dask_client = setup_dask_cluster(dask_scheduler=args.dask_scheduler)
            dask_client.register_worker_callbacks(silence_worker_log)
            analyzer = DFAnalyzer(
                args.trace,
                load_fn=additional_columns_function,
                load_cols=load_cols,
            )

            server.start(
                routes=[],
                dashboard_address=f"{args.address}:{args.port}",
                default_port=9000,
            )
            setup_bokeh_apps(
                server=server,
                applications=applications,
                analyzer=analyzer,
                dask_client=dask_client,
                prefix="",
            )
            print(f"Open DFDashboard on http://{server.address}:{server.port}")
            server.io_loop.start()
        except KeyboardInterrupt:
            print("\nShutting down...")
            server.io_loop.stop()
            dask_client.shutdown()
            server.close()
