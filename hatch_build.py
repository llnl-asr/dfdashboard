"""Build hook: put the compiled SPA inside the wheel.

The server falls back to ``<package>/web_dist`` when ``--web-dist`` is not
given, so an installed ``dftracer-dashboard`` needs no flag and no checkout.
Set ``DFDASHBOARD_SKIP_WEB=1`` to build a wheel without the SPA (tests only).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

ROOT = Path(__file__).parent
WEB = ROOT / "web"
OUT = ROOT / "python" / "dftracer" / "dashboard" / "web_dist"


class WebBuildHook(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict) -> None:
        if os.environ.get("DFDASHBOARD_SKIP_WEB") == "1":
            return
        if shutil.which("npm") is None:
            raise RuntimeError(
                "npm is required to build the dashboard SPA into the wheel; "
                "set DFDASHBOARD_SKIP_WEB=1 to build without it"
            )
        if not (WEB / "node_modules").is_dir():
            _run(["npm", "ci"], WEB)
        _run(["npm", "run", "build"], WEB)
        if not (WEB / "dist" / "index.html").is_file():
            raise RuntimeError("npm run build produced no web/dist/index.html")
        shutil.rmtree(OUT, ignore_errors=True)
        shutil.copytree(WEB / "dist", OUT)
        build_data.setdefault("artifacts", []).append(
            "python/dftracer/dashboard/web_dist/**"
        )


def _run(cmd: list[str], cwd: Path) -> None:
    print(f"hatch_build: {' '.join(cmd)} (in {cwd})", file=sys.stderr)
    subprocess.run(cmd, cwd=cwd, check=True)
