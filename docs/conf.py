# Configuration file for the Sphinx documentation builder.
#
# Single doc source shared by ReadTheDocs (GitHub) and GitLab Pages.

project = "dfdashboard"
copyright = "2025-2026, Lawrence Livermore National Security"
author = "Ray A. O. Sinurat, Hariharan Devarajan"

extensions = []

# Every reference must resolve. Combined with -W (and fail_on_warning on Read
# the Docs) a broken link or a missing target fails the build instead of
# shipping a silent dead link.
nitpicky = True

templates_path = ["_templates"]
exclude_patterns = ["_build", "Thumbs.db", ".DS_Store"]

try:
    import sphinx_rtd_theme  # noqa: F401

    html_theme = "sphinx_rtd_theme"
except ImportError:
    html_theme = "alabaster"

html_static_path = []
