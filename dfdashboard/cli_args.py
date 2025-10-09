from dataclasses import dataclass
from pathlib import Path
from functools import partial

from jsonargparse import ArgumentParser, ActionConfigFile, Namespace
from jsonargparse._util import import_object

from dfdashboard.logging import LogLevel

class DFDashboardArgumentParser(ArgumentParser):
    ...

def to_partial(component: dict):
    cls = import_object(component["class_path"])
    init_args = component.get("init_args", {})
    return partial(cls, **init_args)

def dot_unflatten(d):
    result = {}
    for key, value in d.items():
        parts = key.split(".")
        cur = result
        for part in parts[:-1]:
            cur = cur.setdefault(part, {})
        cur[parts[-1]] = value
    return result

@dataclass
class DFAnalyzerArgs:
    workers: int = 4
    time_granularity: float | None = None
    rebuild_index: bool = False
    verbose: bool = False
    trace_ext: str = ".pfw.gz"
    batch_size: float = 1024 * 128
    reset: bool = False
    debug: bool = False
    dask_scheduler: Path | None = None
    index_dir: Path | None = None

@dataclass
class DFDashboardArgs:
    trace: str
    address: str = "0.0.0.0"
    port: int = 5006
    dask_scheduler: Path | None = None
    log_level: LogLevel = LogLevel.INFO
    log_file: Path = Path("dfdashboard.log")

Arguments = Namespace


def get_args():
    parser = DFDashboardArgumentParser()
    parser.add_argument("-c", "--config", action=ActionConfigFile, help="Path to a configuration file in json or yaml format.")
    parser.add_class_arguments(DFAnalyzerArgs, "dfanalyzer")
    parser.add_class_arguments(DFDashboardArgs)
    # parser.add_class_arguments(Main, "m")
    # parser.add_argument("--components", type=dict, help="List of components to load.")
    # args.components = dot_unflatten(args.components)
    # partials = {
    #   name: to_partial(cfg)
    #   for name, cfg in args.components.items()
    # }
    # print(partials["my_component"](x=2))
    args = parser.parse_args()
    return args
