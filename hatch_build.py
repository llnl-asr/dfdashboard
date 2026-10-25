"""Build hook: put the compiled SPA inside the wheel.

The server falls back to ``<package>/web_dist`` when ``--web-dist`` is not
given, so an installed ``dftracer-dashboard`` needs no flag and no checkout.
A wheel without the SPA is a blank page, so this fails instead of shipping one.
A prebuilt bundle placed in the package (Docker, CI) is used as it is; it is
rebuilt when the checkout's sources are newer or ``web/`` is absent.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

ROOT = Path(__file__).parent
WEB = ROOT / "web"
OUT = ROOT / "python" / "dftracer" / "dashboard" / "web_dist"
BUNDLE = OUT / "index.html"
SOURCES = ("src", "index.html", "package.json", "vite.config.ts")


class WebBuildHook(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict) -> None:
        # An editable install ships no artifact, so it needs no bundle: the
        # server reads web/dist from the checkout through --web-dist.
        if version == "editable":
            return
        if not _fresh():
            _build()
        if not BUNDLE.is_file():
            raise RuntimeError("the wheel would carry no SPA: build web/ first")
        build_data.setdefault("artifacts", []).append("python/dftracer/dashboard/web_dist/**")
        _check_servable()


def _newest(folder: Path) -> float:
    return max((p.stat().st_mtime for p in folder.rglob("*") if p.is_file()), default=0.0)


def _fresh() -> bool:
    """A bundle that is present and not older than anything in web/."""
    if not BUNDLE.is_file():
        return False
    if not WEB.is_dir():
        return True
    stamped = BUNDLE.stat().st_mtime
    marks = [
        _newest(WEB / name) if (WEB / name).is_dir() else (WEB / name).stat().st_mtime
        for name in SOURCES
        if (WEB / name).exists()
    ]
    return all(m <= stamped for m in marks)


def _build() -> None:
    if shutil.which("npm") is None:
        raise RuntimeError(
            "npm is required to build the dashboard SPA into the wheel; "
            "build web/ first or install node"
        )
    if not (WEB / "node_modules").is_dir():
        _run(["npm", "ci"], WEB)
    _run(["npm", "run", "build"], WEB)
    if not (WEB / "dist" / "index.html").is_file():
        raise RuntimeError("npm run build produced no web/dist/index.html")
    shutil.rmtree(OUT, ignore_errors=True)
    shutil.copytree(WEB / "dist", OUT)


def _check_servable() -> None:
    """The SPA must carry its JavaScript, not only the shell."""
    index = BUNDLE.read_bytes()
    if b"<script" not in index:
        raise RuntimeError(f"{BUNDLE} has no script tag")
    if not any(p.suffix == ".js" for p in OUT.rglob("*")):
        raise RuntimeError(f"{OUT} has no JavaScript bundle")


def _run(cmd: list[str], cwd: Path) -> None:
    print(f"hatch_build: {' '.join(cmd)} (in {cwd})", file=sys.stderr)
    subprocess.run(cmd, cwd=cwd, check=True)
