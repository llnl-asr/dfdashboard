# Migration Plan: dfdashboard

Selected: 2026-07-30. Source: git@github.com:llnl/dfdashboard.git (default branch **main**). Target: ssh://git@czgitlab.llnl.gov:7999/dftracer/dfdashboard.git (repo exists on czgitlab).

## Findings

- Pure-Python package (hatchling, `requires-python >=3.12`), entry point `dfdashboard-serve = dfdashboard:main` (Bokeh/Dask/Tornado dashboard for DFTracer `.pfw.gz` traces).
- NO `.github/workflows`, NO tests, NO `docs/` — CI and Sphinx docs authored from scratch.
- Packaging gap (pre-existing): `dfdashboard/cli_args.py` imports `jsonargparse` and `dfdashboard/analyzer.py` imports `pyarrow`, neither declared in `pyproject.toml`; CI installs them explicitly with a comment.
- `zindex_py` dep ships as an sdist; building with vendor Cray compiler wrappers produces a module linked against `libfi.so.1`/`libcraymath.so.1` that fails to import on TOSS. CI (and the local smoke test) set `CC=gcc CXX=g++`.
- No dftracer-group GitHub dependency URLs — all deps are third-party PyPI; the only `github.com/LLNL/DFDashboard` reference is the self-install line in README.md (left untouched). No in-place changes.

## Steps

1. [x] Fresh clone (main)
2. [x] gitlab remote added + verified
3. [x] CI: authored fresh `.gitlab-ci.yml` — `.corona-batch` template; `test` job (venv, `pip install -e .` + jsonargparse/pyarrow, import smoke check + `dfdashboard-serve --help`) on push + merge_request_event
4. [x] Docs: authored host-neutral Sphinx docs (`docs/conf.py` with rtd→alabaster fallback, `index.rst`, `introduction.rst`, `api.rst`, `requirements.txt`) + `pages` job (main + temp gitlab-migration rule)
5. [x] In-place GitLab URL switch — none needed (no dftracer-group deps); REVERT.md bullet added
6. [x] Local tests (YAML OK; sphinx build succeeded; venv smoke test passed with CC=gcc)
7. [x] Commit on gitlab-migration; sync .migration/ into repo
8. [x] Push main, tags (none), gitlab-migration
9. [x] Pipeline: <https://czgitlab.llnl.gov/dftracer/dfdashboard/-/pipelines>
10. [ ] User merges after green pipeline (then remove the temporary `gitlab-migration` rule from the `pages` job)

## Executed changes (what to undo on revert)

- `gitlab` remote: `ssh://git@czgitlab.llnl.gov:7999/dftracer/dfdashboard.git`
- Branch `gitlab-migration` (from `main`) adding only new files: `.gitlab-ci.yml`, `docs/{conf.py,index.rst,introduction.rst,api.rst,requirements.txt}`, `.migration/{REVERT.md,dfdashboard.md}`
- No in-place source changes; `.github/` absent; origin never pushed.
- Pushed to gitlab: `main`, `gitlab-migration` (no tags exist).
- SHAs: main = e5927ee8f1b83e6cc2e3458c85e832003d9c77c9, gitlab-migration = 88e848fb0d4af0446b02a10ed8cc266c58586ad7.

## Status log

- 2026-07-30: cloned, remote added, plan created.
- 2026-07-30: CI + docs authored; local tests passed (YAML OK, sphinx build succeeded, venv import smoke check OK after forcing CC=gcc for zindex_py); no in-place dep changes needed; committed on gitlab-migration; pushed main + gitlab-migration to czgitlab.
- 2026-07-30: CI switched to corona flux-allocation flow, single allocation per pipeline; MR opened.
- 2026-07-30: Flux allocation made global via allocate/.flux-jobid artifact/release-allocation jobs; wait-event timeout removed.
- 2026-07-30: branch rebuilt onto merged main; allocate switched to flux alloc --bg.
- 2026-07-30: CI now runs inside podman containers (python:3.11) on the allocated node via flux run; Cray-compiler zindex_py workaround dropped (container uses gcc). Pattern validated on cpp-logger.
- 2026-07-30: fixed allocation-id race — 'flux job last' is user-global and concurrent pipelines cancelled each other's allocations; now uses a unique per-job name (<proj>-$CI_PIPELINE_ID-$CI_JOB_ID) with 'flux jobs --name' lookup, and cleanup only cancels a non-empty .flux-jobid.
