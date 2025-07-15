from typing import Optional, Union

import pandas as pd
import dask.dataframe as dd

from dfdashboard.analyzer import DFAnalyzer

def assign_seconds(df: pd.DataFrame):
    # dummy placeholder; replace with your own
    return df["index"] / 10


def create_timeline(analyzer: DFAnalyzer):
    analyzer.events["index"] = analyzer.events["size"]
    timeline = (
        analyzer.events.groupby(["phase", "trange", "pid", "tid"])
        .agg(
            {
                "index": "count",
                "size": "sum",
                "io_time": "sum",
                "app_io_time": "sum",
            }
        )
        .groupby(["phase", "trange"])
        .agg(
            {
                "index": "sum",
                "size": "sum",
                "io_time": max,
                "app_io_time": max,
            }
        )
        .reset_index()
        .set_index("trange", sorted=True)
    )
    return timeline

def length(df: Optional[Union[pd.DataFrame, dd.DataFrame]] = None) -> int:
    if df is None:
        return 0

    if isinstance(df, pd.DataFrame):
        return df.shape[0]
    elif isinstance(df, dd.DataFrame):
        return df.map_partitions(len).sum().compute()
    return 0
