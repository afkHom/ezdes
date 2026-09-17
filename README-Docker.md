# EZDES Docker deployment

## Start the service

1. Install Docker Engine or Docker Desktop on the server.
2. In this folder, run:

```powershell
$env:EZDES_DATA_DIR = 'C:\Production\ExcelFiles'
docker compose up -d --build
```

3. Open `http://SERVER-IP:8765/copper-speed-organizer.html`.
4. In EZDES, enter `/data` in **File directory**, then select **Use latest Excel file**.

The host folder set in `EZDES_DATA_DIR` is mounted read-only at `/data`, so the container can choose the latest `.xlsx`, `.xls`, or `.csv` file without modifying it.

## Stop the service

```powershell
docker compose down
```

## Update after changes

```powershell
docker compose up -d --build
```