# ---- 1. Build the frontend ------------------------------------------------
FROM node:22-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
# `prebuild` generates the emoji data and copies the Twemoji SVGs first.
RUN npm run build

# ---- 2. Runtime: Python serves the API, the gateway and the built app ------
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TAVERN_DATA_DIR=/data \
    TAVERN_STATIC_DIR=/app/static

WORKDIR /app

# ffmpeg converts jukebox uploads and measures loudness; yt-dlp needs a
# JavaScript runtime (Deno) to import from YouTube.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

COPY backend/requirements.txt ./
RUN pip install -r requirements.txt

RUN useradd --system --uid 1000 --user-group --home-dir /app --no-create-home tavern \
    && mkdir -p /data && chown tavern:tavern /data

COPY docker-entrypoint.py /app/docker-entrypoint.py
COPY backend/tavern ./tavern
COPY --from=frontend /build/dist ./static

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=4)"]

# Fixes ownership of /data, then runs the server as the unprivileged user.
ENTRYPOINT ["python", "/app/docker-entrypoint.py"]
# Keep a single worker: live updates and rate limits live in this process.
CMD ["uvicorn", "tavern.main:app", "--host", "0.0.0.0", "--port", "8080", "--no-server-header", "--timeout-graceful-shutdown", "5"]
