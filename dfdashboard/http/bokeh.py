from typing import Dict, Any

from bokeh.application import Application
from bokeh.application.handlers.function import FunctionHandler
from bokeh.server.server import BokehTornado
from bokeh.server.util import create_hosts_allowlist
from bokeh.document import Document

from distributed import Client as DaskClient

from dfdashboard.base.page import DFDashboardPage
from dfdashboard.base.runtime import DFDashboardRuntime
from dfdashboard.http.server import HTTPServer
from dfdashboard.analyzer import DFAnalyzer


def make_bokeh_app(
    layout_config: Dict[str, Any],
    server: HTTPServer,
    analyzer: DFAnalyzer,
    dask_client: DaskClient,  
):
    def app_entry(doc: Document):
        runtime = DFDashboardRuntime(
            document=doc,
            analyzer=analyzer,
            dask_client=dask_client,
            server=server
        )
        page = DFDashboardPage(
            runtime=runtime,
            document=doc,
            layout_config=layout_config,
        )
        root = page.build()
        doc.add_root(root)

    return Application(FunctionHandler(app_entry))


def BokehApplication(
    server: HTTPServer,
    applications: Dict[str, Dict[str, Any]],
    analyzer: DFAnalyzer,
    dask_client: DaskClient,
    prefix: str = "/",
    template_variables: Dict[str, Any] = None,
) -> BokehTornado:
    template_variables = template_variables or {}
    prefix = "/" + prefix.strip("/") + "/" if prefix else "/"

    apps = {}
    for route, layout_config in applications.items():
        if not isinstance(layout_config, dict):
            raise TypeError(
                f"Application '{route}' must be a layout dictionary (parsed YAML or JSON)."
            )
        apps[route] = make_bokeh_app(layout_config, server=server, analyzer=analyzer, dask_client=dask_client)

    extra_websocket_origins = create_hosts_allowlist(["*"], server.http_server.port)

    return BokehTornado(
        apps,
        prefix=prefix,
        use_index=False,
        absolute_url="",
        extra_websocket_origins=extra_websocket_origins,
    )


def setup_bokeh_apps(
    server: HTTPServer,
    applications: Dict[str, Dict[str, Any]],
    analyzer: DFAnalyzer,
    dask_client: DaskClient,
    prefix: str = "",
):
    bokeh_app = BokehApplication(
        server=server,
        applications=applications,
        analyzer=analyzer,
        dask_client=dask_client,
        prefix=prefix,
    )
    server.http_application.add_application(bokeh_app)
    bokeh_app.initialize(server.io_loop.current())
    bokeh_app.start()
