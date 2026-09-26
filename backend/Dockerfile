FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim AS build
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY backend/app ./app
COPY data ./library

FROM build AS build-dev
RUN uv sync --frozen --no-install-project

FROM python:3.13-slim-bookworm AS base
WORKDIR /app
RUN echo "wireshark-common wireshark-common/install-setuid boolean false" | debconf-set-selections     && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tshark     && rm -rf /var/lib/apt/lists/*
RUN useradd -r -u 1001 app && mkdir -p /data/uploads && chown app:app /data/uploads
ENV PATH="/app/.venv/bin:$PATH" UPLOAD_DIR=/data/uploads DATA_DIR=/app/library

FROM base AS test
COPY --from=build-dev --chown=app:app /app /app
COPY --chown=app:app backend/tests ./tests
COPY --chown=app:app backend/tools ./tools
COPY --chown=app:app backend/pyproject.toml ./
USER app
CMD ["python", "-m", "pytest", "-q"]

FROM base AS runtime
COPY --from=build --chown=app:app /app /app
USER app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
