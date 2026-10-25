# Configuration file for the Sphinx documentation builder.
#
# Single doc source shared by Read the Docs (GitHub) and GitLab CI.

project = "DFDashboard"
copyright = "2025-2026, Lawrence Livermore National Security"
author = "Ray A. O. Sinurat, Hariharan Devarajan"

extensions = [
    "sphinx_design",  # grid and cards on the landing page
    "sphinx.ext.autodoc",  # the API reference is generated from the docstrings
    "sphinx.ext.viewcode",  # and links each entry to its source
]

# Every reference must resolve. Combined with -W (and fail_on_warning on Read
# the Docs) a broken link or a missing target fails the build instead of
# shipping a silent dead link.
nitpicky = True

autodoc_default_options = {
    "members": True,
    "member-order": "bysource",
}
autodoc_typehints = "signature"

# fastapi fails to build its pydantic models under an autodoc import, but every
# use of it here is at call time, so a stub is enough to read the modules.
autodoc_mock_imports = ["fastapi", "starlette"]

# The reference names base classes from other packages. They are not part of
# this site, so a missing target for them is not a broken link.
nitpick_ignore_regex = [
    ("py:class", r"(enum|threading|concurrent|asyncio|pathlib|typing_extensions)\..*"),
    ("py:class", r"(pydantic|pydantic_settings|starlette|bokeh|panel|uvicorn)\..*"),
    ("py:class", r"(BaseSettings|ThreadPoolExecutor|Theme|Enum|TypedDict)"),
    ("py:class", r"(fastapi|dftracer\.utils)\..*"),
    # Payload aliases and TypeVars have no own target, and a subscripted type in
    # an annotation is not a class to link.
    ("py:class", r"(DataFrame|TraceData|P|OpStatsPayload|ProcBytesPayload|.*TraceData)"),
    ("py:class", r"(collections|_asyncio|_collections_abc)\..*"),
    ("py:class", r"(dict|list|tuple|set|frozenset|Optional|Union|Literal|Callable)\[.*"),
]

templates_path = ["_templates"]
exclude_patterns = ["_build", "Thumbs.db", ".DS_Store"]

# The same theme and accent as the dftracer-utils docs, so the two sites read
# as one project.
html_theme = "shibuya"
html_theme_options = {
    "accent_color": "cyan",
    "github_url": "https://github.com/llnl-asr/dfdashboard",
    "globaltoc_expand_depth": 1,
}

html_static_path = ["_static"]
html_css_files = ["custom.css"]
