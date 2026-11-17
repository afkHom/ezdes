# EZDES with Docker

The container serves the planner on port 8765 and reads workbooks from a folder mounted
read-only at `/data`. The page offers **Load latest from shared folder** automatically; there is
no path to type.

## Build and run here

```powershell
$env:EZDES_DATA_DIR = 'C:\Production\ExcelFiles'
docker compose up -d --build
```

Open `http://SERVER-IP:8765/`. Old bookmarks to `/copper-speed-organizer.html` redirect there.

Update after changes: `docker compose up -d --build`. Stop: `docker compose down`.

## ZimaOS (published image)

Use `zima-compose.yml`. Change `/DATA/Excel` to the folder holding the workbooks. It pulls
`ghcr.io/afkhom/ezdes:latest`, which the GitHub workflow rebuilds after its tests pass on every
push to `main`.

## Notes

- If you open it under a dotted host name such as `planner.company.lan`, set
  `EZDES_ALLOWED_HOSTS=planner.company.lan` in the compose file's `environment:`. IP addresses,
  `localhost`, single-word names and `*.local` names work without it.
- There is no login. Anyone who can reach port 8765 can read the workbooks in the mounted folder.
  To limit it to the host itself, publish the port as `"127.0.0.1:8765:8765"`.

- The container runs as a non-root user and has a health check (`/api/health`).
- Only workbooks sitting directly in the mounted folder are offered; Excel lock files (`~$…`) are skipped.
- Settings, notes, pins and done ticks are stored in each browser, not on the server.
