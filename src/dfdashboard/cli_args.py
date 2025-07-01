from dataclasses import dataclass
from pathlib import Path

from jsonargparse import ArgumentParser, ActionConfigFile, Namespace

class DFDashboardArgumentParser(ArgumentParser):
    ...


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
    address: str = "0.0.0.0"
    port: int = 5006
    dask_scheduler: Path | None = None

Arguments = Namespace

def get_args():
    parser = ArgumentParser()
    parser.add_argument("-c", "--config", action=ActionConfigFile, help="Path to a configuration file in json or yaml format.")
    parser.add_class_arguments(DFAnalyzerArgs, "dfanalyzer")
    parser.add_class_arguments(DFDashboardArgs)
    return parser.parse_args()
