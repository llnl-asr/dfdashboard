# DFDashboard

A browser dashboard for DFTracer traces, the interactive visualization layer of the DataFlowX suite.

DFDashboard reads `.pfw.gz` traces through the [dftracer-utils](https://github.com/llnl-asr/dftracer-utils) C++ index.
The browser asks for one time window at a time, so a large trace opens right away.
Status: pre-release.
The package is not on PyPI yet, so install it from this repository.

## Install

DFDashboard runs on Python 3.10 or newer.
The install also needs Node 22 and npm, because the wheel carries the built browser app.

```bash
pip install "dftracer-dashboard @ git+https://github.com/llnl-asr/dfdashboard.git@develop"
```

## Quickstart

```bash
dfdashboard-serve --trace run1.pfw.gz
```

Open http://127.0.0.1:5006.
The Overview tab shows the run summary and its cards.
The Timeline tab draws the events, the counters and one lane for each thread.
Give a directory instead of a file to read every trace below it, or `--watch` to follow a tree that keeps growing.
Press `?` in the app for the keys and the mouse gestures.

Every option is in `dfdashboard-serve --help`.

## Learn more

The pages below live in [`docs/source`](docs/source/index.rst).

- [Getting started](docs/source/getting-started.rst) takes you from a checkout to a served trace.
- [Producing runs](docs/source/producing-runs.rst) shows the directory a producer writes so the dashboard follows a run while it grows.
- [Run directories](docs/source/runs.rst) is the reference for that directory and for the completion rules.
- [Shortcuts](docs/source/shortcuts.rst) lists the keys and the mouse gestures.
- [API reference](docs/source/api/index.rst) points at the HTTP specification and the command reference.
- [Architecture](docs/source/architecture.rst) explains why the browser streams Arrow and why the queries run in the engine.
- [Docker](docs/source/docker.rst) runs the image.

## Development

```bash
python -m pytest tests -q                  # backend, runs on 3.10 to 3.12
ruff check python tests
ruff format --check python tests
ty check python
```

The browser suite builds the app first and then drives it.

```bash
cd web
npm ci
npm run build
npx playwright test -c tests/e2e/playwright.config.ts
```

The suite writes its own run tree under `/tmp/dfdashboard-e2e`, so nothing else has to be running.
Install the git hooks with `pre-commit install`.

## Help

Report a bug or ask a question at https://github.com/llnl-asr/dfdashboard/issues.

## License

DFDashboard is distributed under the terms of the MIT license.
All new contributions must be made under this license.

See [LICENSE](LICENSE) and [NOTICE](NOTICE) for details.

SPDX-License-Identifier: MIT

LLNL-CODE-2024514 — Applied Storage Research (ASR)
