from typing import Optional

from distributed import Client

from bokeh.document import Document

from dfdashboard.http.server import HTTPServer
from dfdashboard.analyzer import DFAnalyzer

class DFDashboardRuntime:
    def __init__(
      self, 
      document: Document,
      analyzer: DFAnalyzer, 
      dask_client: Client, 
      server: Optional[HTTPServer] = None
    ):
        self.document = document
        self.analyzer = analyzer
        self.dask_client = dask_client
        self.server = server

    @property
    def has_server(self):
        return self.server is not None

    @property
    def io_loop(self):
        if not self.server:
            raise RuntimeError("No server to get io_loop from")
        return self.server.io_loop
