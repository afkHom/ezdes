# Local test deployment

This branch must be built from its own files. Pulling `ghcr.io/afkhom/ezdes:latest` would load production, not this local learning test build.

See [README-Local-Test.md](README-Local-Test.md) for local launch, Docker/Zima instructions, password configuration, persistence and backups.

Set a strong `EZDES_PASSWORD` in your environment before starting. Docker connections require authentication even when the published port is localhost-only. Sign in using username `ezdes` and your password.

```shell
docker compose up -d --build
```

Open http://localhost:8777/copper-speed-organizer.html on the machine running Docker. Default compose is local-only and uses `ezdes-living-local`, so it will not replace the production container. Put workbooks in `data`, or configure the host `EZDES_DATA_DIR` before starting. Enter `/data` in EZDES's folder field.

The `state` volume stores `ezdes.sqlite3` and must be retained across rebuilds. Stop the container before copying it for backups.
