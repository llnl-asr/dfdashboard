from typing import Any, Optional, Type, List

from tornado.httputil import HTTPServerRequest
from tornado import web
from tornado.routing import _RuleList

Handlers = _RuleList

# taken from https://github.com/dask/distributed/blob/main/distributed/http/routing.py#L49
class RoutingApplication(web.Application):
    def __init__(self, 
        handlers: Optional[_RuleList] = None,
        default_host: Optional[str] = None,
        transforms: Optional[List[Type[web.OutputTransform]]] = None,
        **settings: Any,
    ) -> None:
        super().__init__(handlers, default_host, transforms, **settings)
        self.applications: list[web.Application] = []

    def find_handler(  # type: ignore[no-untyped-def]
        self, request: HTTPServerRequest, **kwargs
    ):
        handler = super().find_handler(request, **kwargs)
        if handler and not issubclass(handler.handler_class, web.ErrorHandler):
            return handler
        else:
            for app in self.applications:
                handler = app.find_handler(request, **kwargs) or handler
                if handler and not issubclass(handler.handler_class, web.ErrorHandler):
                    break
            return handler

    def add_application(self, application: web.Application) -> None:
        self.applications.append(application)
