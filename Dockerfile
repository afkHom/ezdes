FROM python:3.12-slim

WORKDIR /app
COPY copper-speed-organizer.html ezdes_server.py ./

ENV EZDES_HOST=0.0.0.0
ENV EZDES_PORT=8765
ENV EZDES_OPEN_BROWSER=0

EXPOSE 8765
CMD ["python", "ezdes_server.py"]