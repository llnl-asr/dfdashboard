"""The run-directory page must match the code that decides those rules.

Reference prose drifts from the source it describes. These checks fail when the
page and `dftracer.dashboard.data.watch` or the CLI disagree, so a rename cannot land
silently.
"""

import contextlib
import io
import re

from dftracer.dashboard import cli
from dftracer.dashboard.data.watch import _FORMAT_DIRS, _MARKERS

PAGE = "docs/runs.rst"

# Flags that belong to other tools, which the page quotes in a command.
FOREIGN_FLAGS = {"--compress"}


def _page() -> str:
    with open(PAGE) as fh:
        return fh.read()


def _help() -> str:
    buf = io.StringIO()
    with contextlib.suppress(SystemExit), contextlib.redirect_stdout(buf):
        cli.parse_args(["--help"])
    return buf.getvalue()


def test_page_names_every_marker():
    text = _page()
    missing = [m for m in _MARKERS if m not in text]
    assert not missing, f"{PAGE} does not mention markers {missing}"


def test_page_names_every_format_directory():
    text = _page()
    missing = [d for d in _FORMAT_DIRS if d not in text]
    assert not missing, f"{PAGE} does not mention format directories {missing}"


def test_page_names_every_state_and_reason():
    text = _page()
    for word in ("live", "done", "stalled", "marker", "end-record", "verified", "quiet"):
        assert word in text, f"{PAGE} does not mention {word}"


def test_every_flag_in_the_page_exists():
    flags = set(re.findall(r"--[a-z][a-z-]+", _page())) - FOREIGN_FLAGS - {"--help"}
    help_text = _help()
    missing = sorted(f for f in flags if f not in help_text)
    assert not missing, f"{PAGE} names flags the CLI does not have: {missing}"


def test_page_is_in_the_docs_tree():
    with open("docs/index.rst") as fh:
        assert "runs" in fh.read(), "docs/index.rst does not include the runs page"


def test_page_quotes_the_engine_error_verbatim():
    with open("python/dftracer/dashboard/data/watch.py") as fh:
        source = fh.read()
    assert "gzip" in source
    assert "must be gzip-compressed" in _page()
