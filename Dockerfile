# syntax=docker/dockerfile:1

# Stage 1: build the SolidJS single-page frontend
FROM node:20-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Stage 2: install the Python package into an isolated venv
FROM python:3.12-slim AS build
RUN apt-get -o APT::Sandbox::User=root update \
    && apt-get -o APT::Sandbox::User=root install -y --no-install-recommends \
        build-essential cmake ninja-build git \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
ENV UV_LINK_MODE=copy
WORKDIR /src
COPY pyproject.toml README.md hatch_build.py ./
COPY python/ ./python/
# Same place the wheel puts it, so the runtime needs no --web-dist.
COPY --from=web /web/dist ./python/dftracer/dashboard/web_dist
# --no-sources ignores any [tool.uv.sources] override (e.g. a local dev path for
# dftracer-utils) so the image always resolves dependencies from the index.
RUN uv venv /opt/venv \
    && VIRTUAL_ENV=/opt/venv uv pip install --no-sources .

# Stage 3: slim runtime with just the venv and the built SPA
FROM python:3.12-slim AS runtime
# Shared libraries the dftracer-utils C++ extension links against at runtime
# (libatomic is required for 64-bit atomics, notably on arm64).
RUN apt-get -o APT::Sandbox::User=root update \
    && apt-get -o APT::Sandbox::User=root install -y --no-install-recommends \
        libatomic1 libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
WORKDIR /app
# Mount traces here; override the CMD to point elsewhere.
VOLUME ["/data"]
EXPOSE 5006
ENTRYPOINT ["dfdashboard-serve", "--host", "0.0.0.0", "--port", "5006"]
CMD ["--trace", "/data"]
