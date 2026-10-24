import asyncio
import gzip
import os

import pytest

pytest.importorskip("dftracer.analyzer")

from dfdashboard.analysis._dfa import warmup  # noqa: E402
from dfdashboard.analysis.base import RunContext  # noqa: E402
from dfdashboard.analysis.pipelines import DFAnalyzerParams, DFAnalyzerPipeline  # noqa: E402
from dfdashboard.compute.cluster import ClusterManager  # noqa: E402


def _write_trace(directory: str) -> str:
    lines: list[str] = []
    base = 1_000_000
    for i in range(32):
        lines.append(
            f'{{"name":"read","cat":"POSIX","pid":1,"tid":1,"ts":{base + i * 100},'
            f'"dur":10,"ph":"X","args":{{"ret":1024,"fhash":"f1"}}}}'
        )
    path = os.path.join(directory, "t.pfw.gz")
    with gzip.open(path, "wt") as fh:
        fh.write("\n".join(lines) + "\n")
    return path


class _Data:
    def __init__(self, trace_dir: str) -> None:
        self.trace_dir = trace_dir


def test_dfanalyzer_runs_in_process(tmp_path):
    # dfanalyzer imports dask_jobqueue, which installs a SIGINT handler and so
    # only imports from the main thread; the server warms it the same way.
    assert warmup()

    _write_trace(str(tmp_path))
    pipeline = DFAnalyzerPipeline()
    ctx = RunContext(data=_Data(str(tmp_path)))

    res = asyncio.run(pipeline.run(ctx, DFAnalyzerParams()))

    assert res.data["layers"], "the analyzer found no view layers"
    assert res.data["columns"], "the main view has no columns"
    assert res.data["main_view_path"], "the main view parquet was not written"
    assert os.path.exists(res.data["main_view_path"])
    assert res.data["raw_stats"]["total_event_count"] == 32


def test_dfanalyzer_uses_the_dashboard_cluster(tmp_path):
    assert warmup()

    _write_trace(str(tmp_path))

    async def run():
        cluster = ClusterManager()
        try:
            ctx = RunContext(data=_Data(str(tmp_path)), client_provider=cluster.client)
            res = await DFAnalyzerPipeline().run(ctx, DFAnalyzerParams(cluster="external"))
            # The analyzer closes its own client, not the dashboard's cluster.
            assert cluster._client is not None
            return res
        finally:
            await cluster.close()

    res = asyncio.run(run())
    assert res.data["layers"]
    assert res.data["columns"]
    assert os.path.exists(res.data["main_view_path"])
