import logging
from contextlib import suppress

from tornado.httpserver import HTTPServer as BaseHTTPServer
from tornado.ioloop import IOLoop

import tlz

from dfdashboard.http.routing import RoutingApplication, Handlers
from distributed.utils import clean_dashboard_address
from distributed.comm.addressing import get_address_host
from distributed.comm.utils import get_tcp_server_addresses

log = logging.getLogger(__name__)


class HTTPServer:
    def __init__(self):
        self.http_application: RoutingApplication | None = None
        self.http_server: BaseHTTPServer | None = None
        self.io_loop = IOLoop.current()
        self.address: str = ""
        self.port: int | None = None

    def start(self, routes: Handlers, dashboard_address: str, default_port=0):
        self.http_application = RoutingApplication(routes)
        self.http_server = BaseHTTPServer(self.http_application)

        http_addresses = clean_dashboard_address(dashboard_address or default_port)
        for http_address in http_addresses:
            # Handle default case for dashboard address
            # In case dashboard_address is given, e.g. ":8787"
            # the address is empty and it is intended to listen to all interfaces
            if dashboard_address is not None and http_address["address"] == "":
                http_address["address"] = "0.0.0.0"

            if http_address["address"] is None or http_address["address"] == "":
                address = self._start_address
                if isinstance(address, (list, tuple)):
                    address = address[0]
                if address:
                    with suppress(ValueError):
                        http_address["address"] = get_address_host(address)

            change_port = False
            retries_left = 3
            while True:
                try:
                    if not change_port:
                        self.http_server.listen(**http_address)
                    else:
                        self.http_server.listen(**tlz.merge(http_address, {"port": 0}))
                    break
                except Exception:
                    change_port = True
                    retries_left = retries_left - 1
                    if retries_left < 1:
                        raise

        bound_addresses = get_tcp_server_addresses(self.http_server)

        # If more than one address is configured we just use the first here
        self.http_server.address, self.http_server.port = bound_addresses[0]
        self.address, self.port = bound_addresses[0]

        # Warn on port changes
        for expected, actual in zip(
            [a["port"] for a in http_addresses], [b[1] for b in bound_addresses]
        ):
            if expected != actual and expected > 0:
                log.warning(
                    f"Port {expected} is already in use.\n"
                    "Perhaps you already have a cluster running?\n"
                    f"Hosting the HTTP server on port {actual} instead"
                )

    def close(self):
        if self.http_application:
            for application in self.http_application.applications:
                if hasattr(application, "stop") and callable(application.stop):
                    application.stop()

        if self.http_server:
            self.http_server.stop()
