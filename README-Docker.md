# EZDES Docker deployment

## Start the service

1. Install Docker Engine or Docker Desktop on the server.
2. In this folder, run:

```powershell
$env:EZDES_DATA_DIR = 'C:\\Production\\ExcelFiles'
$env:EZDES_STATE_DIR = 'C:\\Production\\EZDES-State'
docker compose up -d
```

3. Open `http://SERVER-IP:8765/copper-speed-organizer.html`.
4. In EZDES, enter `/data` in **File directory**, then select **Use latest Excel file**.

The host folder set in `EZDES_DATA_DIR` is mounted read-only at `/data`, so the container can choose the latest `.xlsx`, `.xls`, or `.csv` file without modifying it. `EZDES_STATE_DIR` is a separate writable folder containing the shared speed tracker. Keep that folder to preserve tracker entries across updates.

When EZDES is opened through this server, speed-tracker entries are shared by every browser using that server. Opening the HTML file directly falls back to storage in that individual browser.

## Stop the service

```powershell
docker compose down
```

## Update after changes

```powershell
docker compose pull
docker compose up -d --force-recreate
```
