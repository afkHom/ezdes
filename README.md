# EZDES

Plans a production shift on the etch line from a workbook of jobs. It picks which whole WO jobs go
into the shift (day preference by copperweight, due dates, how long a job has been waiting), runs
them in the quickest order the line allows, shows when each core is loaded and comes out, and
prints a compact landscape sheet for the floor.

## Run it

| How | Command | Shared-folder button |
|---|---|---|
| Just open it | double-click `web/index.html` | no (choose a file instead) |
| Windows | edit `EZDES_DATA_DIR` in `Run-EZDES.bat`, then run it | yes |
| Any OS | `python server.py --data-dir /path/to/workbooks` | yes |
| Docker | `EZDES_DATA_DIR=/path/to/workbooks docker compose up -d --build` | yes |
| ZimaOS | `zima-compose.yml` (pulls the published image) | yes |

The server binds to `127.0.0.1` by default. Pass `--host 0.0.0.0` (Docker does this) to serve the LAN.
It only exposes workbooks sitting directly in the data folder: the browser never sends a path.
See [README-Docker.md](README-Docker.md) for containers.

If you open the page under a host name with dots in it (e.g. `planner.company.lan`), add that name
to `EZDES_ALLOWED_HOSTS` / `--allowed-hosts`. IP addresses, `localhost`, single-word names and
`*.local` names always work. Any other name is refused, which stops other websites reaching the
server through DNS rebinding.

There is no login: anyone who can reach the port can read the workbooks in the data folder. Keep
it on the plant network, or bind it to `127.0.0.1` when only one PC uses it.

No internet is needed: the Excel library is vendored in `web/vendor/`.

## How a shift is planned

1. **Which jobs.** Jobs are ranked by the day score for their copperweight (editable under *Day
   scores*; light early in the week, heavy later), plus due-date urgency and +10 per work day a
   job has been waiting. *Fill the shift* adds jobs in that order while the last core still comes
   out before the shift ends (after breaks), then backfills any time left.
2. **What order.** Every order of the weight blocks is tried and the quickest wins. Jobs due today
   or overdue are kept near the front. Each job's cores stay together; bottom-image cores are
   bunched so the diverters are set once.
3. **Timing.** The conveyor sets the gap between cores, so a line of *n* cores takes *n* × the
   rule's interval to feed. At a speed change the next weight waits until the last core is fully
   out (slowing down) or out of the etcher (speeding up), plus the minutes to change the setting
   (one default, or per weight pair). Travel and interval can be typed per weight or derived from
   a measured line length and core pitch.

Also: the shift can start on the weight already running (by default, where the previous plan
ended), the last job can run on into the next shift, cores can be ticked *Done*, and the printout
can carry a blank *Actual* column. The help dialog in the app explains each setting.

## Layout

```
server.py          stdlib-only HTTP server (static files + /api/files)
web/engine.js      scheduling engine: pure functions, no DOM
web/app.js         UI: state, events, rendering
web/store.js       browser persistence (one versioned key, migrates old data)
web/index.html     page markup and help
web/styles.css     styles, light/dark, print
tests/             server unit tests + engine tests
sample-data/       example workbook for trying it out
```

## Tests

```bash
python -m unittest discover -s tests -v
node tests/run-engine-tests.js
```

The engine tests also run in a browser: `python -m http.server 8790`, then open
`http://localhost:8790/tests/engine.test.html`. GitHub runs both on every push and pull request,
and only publishes the Docker image when they pass.

See [REWRITE-NOTES.md](REWRITE-NOTES.md) for what changed from the original and why.
