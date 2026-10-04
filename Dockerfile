FROM python:3.12-slim

WORKDIR /app
COPY copper-speed-organizer.html ezdes-core.js schedule-viewer.css schedule-viewer.js learning-center.css learning-center.js ezdes_server.py ./

ENV EZDES_HOST=0.0.0.0
ENV EZDES_PORT=8765
ENV EZDES_OPEN_BROWSER=0
ENV EZDES_DATA_DIR=/data
ENV EZDES_STATE_DIR=/state

EXPOSE 8765
CMD ["python", "ezdes_server.py"]
