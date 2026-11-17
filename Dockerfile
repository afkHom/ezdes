FROM python:3.13-slim

WORKDIR /app
COPY server.py ./
COPY web ./web

ENV EZDES_HOST=0.0.0.0 \
    EZDES_PORT=8765 \
    EZDES_DATA_DIR=/data \
    EZDES_OPEN_BROWSER=0 \
    PYTHONUNBUFFERED=1

RUN useradd --system --no-create-home ezdes && mkdir -p /data
USER ezdes

EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=3s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/api/health')"
CMD ["python", "server.py"]
