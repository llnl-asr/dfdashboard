"""Problem-shaped API errors: a machine-readable code next to the human detail.

The SPA branches on the code, never on the detail text, so a message can be
reworded without quietly breaking a recovery path.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

NO_SUCH_RUN = "no_such_run"
NO_SUCH_FILE = "no_such_file"
NO_TRACE_YET = "no_trace_yet"
UNKNOWN_TASK = "unknown_task"
UNKNOWN_DASHBOARD = "unknown_dashboard"
NOT_WATCHING = "not_watching"
INVALID_QUERY = "invalid_query"


class ApiError(StarletteHTTPException):
    """An HTTP error whose body carries a code the client can branch on."""

    def __init__(self, status_code: int, code: str, detail: str = "") -> None:
        super().__init__(status_code=status_code, detail=detail or code)
        self.code = code


def install_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"code": exc.code, "detail": exc.detail, "status": exc.status_code},
        )
