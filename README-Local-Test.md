# EZDES — local living-database test build

This build is for local evaluation on `codex/living-database`. It does not replace production or testing and is not published to GitHub or the container registry.

## Start locally

Extract the entire ZIP to one folder. Do not open the HTML inside the ZIP. Run `Run-EZDES.bat` with Python 3.12 or newer installed. Open http://localhost:8777/copper-speed-organizer.html. The server listens on localhost only by default.

You can also open `copper-speed-organizer.html` directly. Keep all JS and CSS files next to it. Excel import still requires internet access to load the workbook-reading library. Direct HTML mode stores history and tracker records in the current browser, not on a shared server.

## Saved data and backups

Server mode stores history and tracker records together in `state/ezdes.sqlite3`. Approvals update both in one transaction. Existing `speed-tracker.json` and `production-learning.json` files are migrated automatically on the first request and left untouched as backups. Records without a run reference remain visible but do not count towards new recommendations.

Use a separate test state folder. If you want to test existing production records, stop production long enough to make a copy, then point this test build at the copy, not the live production state directory.

To back up server data, stop EZDES and copy the entire `state` folder. Restore that folder with EZDES stopped. Keep it when replacing application files or rebuilding a container. Do not run an older JSON-only server against newly saved SQLite history: its old JSON files will be out of date.

Direct HTML mode uses a single browser storage record for learning and tracker approvals. Clearing site data, changing browsers, or moving the app to another address can make those records unavailable. Keep independent backups using Production learning → Export backup. The JSON export is an archive; there is not an automatic restore button yet. Back up the browser profile before moving it. Separate simultaneous browser tabs do not have the server's multi-user transaction guarantees; use server mode for shared work.

Completion marks are now tied to the workbook's contents and individual row data. A different workbook with the same filename no longer inherits completion marks, pins or manual order. Old filename-only completion marks and plan settings are intentionally not carried forward because their row identities were unsafe. Configure the plan once again for this version.

## Production learning

Record a real completed run's actual stable speed, tool number, copperweight and unique run reference (for example `2026-10-04 shift A run 01`). Reusing a reference for the same tool and weight is rejected. Selecting a scheduled layer fills its planned details, but deliberately leaves actual speed blank.

A recommendation needs at least three distinct usable runs, a reasonably consistent speed range, and a difference from the recorded planned speed. Problem runs do not count. Approval saves the tracker entry and decision together; it never changes scheduling rules automatically. Tracker entries are separated by tool **and** weight, so one tool's 2/2 recommendation cannot erase its 1/1 entry.

## Timing and scheduling

Timing uses the first core's travel time plus the following cores' intervals. Consecutive layers with the same heaviest weight and target speed do not repeat the first-core travel time. Setup/changeover rules are included consistently in the summary, arranged table, viewer and exported scheduled-line hours. Standalone layer hours in the export are explicitly separate from scheduled-line hours.

Fill available shift only accepts complete WO jobs whose actual candidate schedule fits the shift, including setup and manual order. An oversized first job is skipped, not forced into the schedule. Invalid or missing weight/timing rules prevent scheduling and appear in Data checks. Invalid core counts show a warning and consistently use one core.

Unrecognized column names can be mapped manually. Choose the correct header row, then map Copperweight and Speed to different columns. Duplicate and blank headers receive unique names so data is not overwritten.

## Folder access and network access

Latest-file access is restricted to `EZDES_DATA_DIR` (the `data` folder beside the application by default). Put workbooks there or set `EZDES_DATA_DIR` before starting the server. Absolute folder paths must remain inside that directory. The server does not expose its source, Git files, or saved state through the website.

For deliberate LAN access set `EZDES_HOST=0.0.0.0` and a strong `EZDES_PASSWORD`. The browser will ask for username `ezdes` and that password (`EZDES_USER` can change the username). Network requests are blocked when no password is configured. Basic authentication is not encryption; use HTTPS through a trusted reverse proxy before using it on an untrusted network. Do not expose this test server directly to the internet.

The default Docker compose builds the local files, uses a distinct image/container name and localhost port 8777, and never pulls the production image. Set a strong `EZDES_PASSWORD` in your environment, then run `docker compose up -d --build`; rebuild with the same command after changes. Docker requests require that password even when the published port is localhost-only. For Zima, build `docker build -t ezdes-living-local:test .` on the server first, then use `zima-compose.yml` with `EZDES_PASSWORD` configured. This local image is intentionally not in the registry.

## Regression tests

Run `python -m unittest discover -s tests -p "test_*.py"` for server/storage checks. Browser regressions use Node.js and Playwright: `node --test tests/review-regressions.mjs` (install Playwright in a development copy if it is not present). The browser suite uses installed Microsoft Edge and a simulated workbook reader to test UI behavior without a network dependency. It does not substitute for testing your real workbooks and production estimates.
