# Rewrite notes: what changed and why

The original was one 110-line HTML file (most of it on a few very long minified lines) plus a
54-line Python server. The scheduling rules came through unchanged. Almost everything around
them changed.

## Bugs and risks fixed

| Original | Problem | Now |
|---|---|---|
| `/latest?directory=<any path>` on `0.0.0.0` | Anyone on the network could read the newest spreadsheet in **any folder** on the host (e.g. `C:\Users\...\Documents`). | One configured data folder. The browser asks for a file by name, and the name has to be one the server listed. Binds to `127.0.0.1` unless told otherwise. |
| "Latest file" = newest `.xlsx` | While someone has the workbook open in Excel, `~$workbook.xlsx` (the lock file) is the newest file, so "Use latest" broke. | Lock files and hidden files are skipped. |
| Static server rooted at the app folder | `ezdes_server.py`, Dockerfile, and so on were downloadable. | Only `web/` is served. |
| SheetJS 0.18.5 from jsDelivr | Old npm build with known advisories (prototype pollution, ReDoS), and the page broke with no internet. | SheetJS 0.20.3 is vendored locally. |
| Pins, notes, bottom-image choices and manual order were keyed by **row index** | Load tomorrow's file and they attached to whatever row now sat at that index. | Lines get a `uid` built from WO, TN and weight, and notes and pins are keyed by job. They follow the job into the next workbook. |
| Rules, day and shift reset on every reload | Only presets were saved. | The current settings save automatically, and presets are still there. |
| Data checks said "Job 4" | That was the position in the *schedule*, not a spreadsheet row. | "Row 17" is the actual sheet row (the offset is handled even when the sheet range doesn't start at A1). |
| Weights outside 0.5–4 (e.g. `5`) | Got a day score of 0 and silently sank to the bottom. | They use the nearest defined rank. |
| Duplicate or blank headers | Columns overwrote each other. | Renamed to `Name (2)` and `Column 5`. |
| `"1,200"` cores | Parsed as NaN, which fell back to 1. | Thousands separators are handled. |
| `Docker` | Ran as root, had no healthcheck, and only published `:latest`. | Runs as a non-root user, has a healthcheck, gets a `:sha` tag too, and tests run before publishing. |

## Performance

`ruleFor()` queried the rules table **in the DOM** on every call, `idFor()` was `indexOf` over all
rows, and `workloadBonus()` scanned every row. They ran inside sort comparators, so a schedule
rebuild was roughly O(n³ log n), and the whole thing re-ran on every keystroke in the rules table.
Now each line's rule, priority and base time is computed once per rebuild, and inputs are debounced.

## Structure

- **`engine.js` is pure.** It takes lines, settings and a plan and returns a schedule, with no DOM and no storage. That's what made 13 real tests possible: day ordering, whole-job selection, fill-shift skipping, timing math, pins against manual order, bottom-image changeover, and checks.
- **`app.js` only renders.** It uses event delegation instead of re-binding listeners on every render.
- **`store.js`** uses one versioned localStorage key, and every access is wrapped in try/catch. It migrates old presets, notes and pins once.
- It's still zero-build and stdlib-only, which is the right weight for a tool that runs on a factory PC or a NAS.

## UX changes (judgment calls, easy to revert)

- **No Apply mapping or Run schedule buttons.** The old UI needed both, *and* auto-ran on some inputs anyway. Now any change rebuilds the schedule.
- **Speed is no longer mapped.** The scheduler never used it, even though it was *required* (only a warning read it). It still shows in the table and the export.
- **Due dates now affect scheduling.** In the original they were mapped but never read (see below).
- **Fill the shift is the default** rather than "plan every job".
- The **Schedule positions** side panel and the **Mixed layers** side panel became columns in the main table: ↑/↓/Pin/Note buttons on each job, and a Bottom dropdown on mixed lines. This removes the `width: calc(100% + 521px); margin-left: -245px` layout hack.
- `prompt()` and `confirm()` are replaced with a proper note dialog. Undo now also covers Reset order, so it needs no confirmation. Ctrl+Z and Ctrl+Y work.
- Drag and drop on the file box. A workbook with several sheets opens the first sheet that has a Copperweight header.
- If the page is served by the server and a data folder is configured, it offers "Load latest from shared folder" automatically. Nobody has to type `/data`.
- The old `copper-speed-organizer.html` URL redirects, so bookmarks still work.

## Due dates (new)

- **Production date:** a date picker that stays in sync with the weekday buttons. It defaults to the next date that falls on the selected day. Picking a date on another weekday switches the day.
- **What counts as a job's due date:** its earliest line's due date. Every line of the job carries the same urgency.
- **Urgency points**, added to the line priority:

  | When the job is due | Points |
  |---|---|
  | Overdue | +100 |
  | On the production date | +80 |
  | Next day | +50 |
  | In 2–3 days | +25 |
  | In 4–7 days | +10 |

  The weight-preference gap between days is at most 90, so an overdue job always beats the day's weight preference.
- **"Due dates" setting:** Ignore (0×), Normal (1×), or Strong (2×).
- **Effect on the schedule:** urgent jobs are picked first, and their weight block runs earlier in the shift. Blocks are never split, so changeovers stay minimal.
- **Where it shows up:** "Overdue 6d", "Due today" and "Due in 2d" badges on the job (these print too), and a summary card showing what is due by the production date. That card warns when an urgent job doesn't fit the shift.
- **Date formats:** ISO, `m/d/y` (switches to day-first when the first number is over 12), Excel serial numbers, and written dates. Unreadable dates are flagged in Data checks and ignored.
- **Auto-mapping** prefers "Due date" over a generic "Date" column.

## Scheduler logic, second pass

The first rewrite kept the original algorithm. This pass changes how the order is decided.

- **Day scores pick the shift; time decides the order.** The day score (light early in the week,
  heavy later), due dates and waiting time decide *which* jobs get into the shift. Inside the shift,
  every order of the weight blocks is tried (all of them up to 7 blocks; a local search above that)
  and the fastest wins. The one exception is jobs due today or overdue: each hour they would wait costs
  their urgency points in minutes. On real data this usually means fast → slow (h → 1 → 2 → 3), which
  avoids waiting for the line to clear. The summary compares it with the plain day-score order.
- **Waiting time (aging).** The app remembers the first day each job appeared in a loaded workbook.
  Every production day since then adds +10, up to +100, so light work squeezed out late in the week
  still gets in. These first-seen dates are kept in the browser, and are forgotten after 120 days once
  the job is gone. If the selected shift runs over after the search, the lowest-ranked jobs are dropped
  before the backfill.
- **Jobs stay together.** Inside a block, each job's lines run back to back, most urgent job first.
  A job with lines in two neighbouring weights runs last in the first block and first in the next, so
  it doesn't stop and set up again. The table says "job runs on through the weight change".
  This replaces `softlyGroup`, whose "within 15 points" check was always true.
- **"On the machine now".** The shift can continue the weight that is already running, with no
  first-core travel and no speed change. Otherwise it's a cold start, as before.
- **The clock is the loader's.** The conveyor sets the gap between cores and the operator feeds on a
  timer, so a line of n cores takes n × interval to feed. Travel through the line only matters at a
  speed change and at the end of the shift. Each line shows when its first core goes on ("Load") and
  when its last core is out ("Out"). An earlier version charged a full travel at the start of every
  weight *and* a clearing wait at every speed change, which counted the same minutes twice.
- **Speed changes wait for the last core, by direction.** Slowing down: the next weight is fed when
  the last core is fully out (a light core stuck at a slow speed is ruined). Speeding up: when the
  last core is out of the etcher, by default halfway down the line (the etcher is the second
  quarter). Both are "% of line" settings, plus the minutes to change the setting itself (default 2;
  the old 10 was a guess that really described the clearing). With these numbers slow → fast is the
  quicker direction, because speeding up only waits for half the travel; the search works it out
  from the rules, so it changes if the numbers do.
- **h/h travels the line in 5 minutes** (the default was 10). If the line is measured, "Line length"
  and "Core pitch" under the rules derive every weight's travel and interval from its speed.
- **A job off its usual speed** (the sheet's Speed column, e.g. 22 instead of 24) is its own speed
  block, so the line clears before and after it. Data checks note it.
- **Done cores.** The workbook lists whole orders even when part has run. Ticking Done on a core
  drops it from the plan (listed under it, undoable) and stays with that core in later workbooks.
- **Run-on.** With "Next shift continues the line" ticked, the last job may run into the next
  shift's list; the planner prefers one at the speed the shift ends on. Off, jobs finish the same day.
- **Saturday** can be planned (its day scores copy Friday's); due dates still count Mon–Fri.
- **Printing** can add a blank "Actual" column for operators who write times down.
- **Due dates count production days.** Planning Friday, a job due Monday is due the next work day
  (it was "3 days"), and one due Saturday is due today. **Slack:** a job that needs N shifts loses
  N−1 days, so a 2-shift job due tomorrow scores as due today. Chips now say "Due Wed" instead of
  "Due in 2d".
- **Fill the shift has a second pass.** After the greedy pick, the minutes the search saved are
  offered to the jobs that were left out. Pinned jobs are always included, even past capacity
  (before, a second pin could silently drop out).
- **A line with no core-weight rule holds its job back** instead of scheduling it at 0 minutes,
  which made the shift look emptier than it was. The summary counts held-back jobs.

- **No workload bonus.** The original gave weights with many jobs up to +30 (except h, which got
  nothing). Now that the shift's real time is measured, it only distorted the day preference, so it's
  gone. The day-score table is editable under "Day scores" and saved with presets.
- **"On the machine now" defaults to where the previous plan ended.** Each production date's plan
  records the weight it ends on. The next date starts from the latest earlier one, and a note above
  the plan says so. Choosing a weight by hand lasts until the day or date changes.
- **Breaks (min)** come off the shift.
- **Bottom image = diverters.** A mixed core whose lighter side isn't clear needs the diverters set.
  That's its own setting ("Bottom image setup", default 10 min). It used to borrow "Setup per job",
  which is 0 when WO changes cost nothing. It's paid when a run of image cores starts, and image cores
  are grouped (and carried across weight changes when possible) so it's paid as rarely as possible.

Tunables live at the top of `engine.js`: `DUE_DELAY_MINUTES_PER_POINT_HOUR`, `AGING_POINTS_PER_DAY`
and `AGING_POINTS_CAP`.

## Security review (second pass)

| Finding | Fix |
|---|---|
| No `Host` check: a malicious website the planner visits could use DNS rebinding to reach the local server and read the workbooks. | Requests are refused unless the host is an IP, `localhost`, a single-word or `*.local` name, or listed in `EZDES_ALLOWED_HOSTS`. |
| A symbolic link (or Windows junction) dropped into the shared folder was followed, so it could expose any file the server can read. | Links are skipped, and the real path must still sit directly in the data folder. |
| No browser security headers. | Content-Security-Policy (scripts only from the app itself), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. |
| Workbooks were read whole into memory, and idle connections held a thread forever. | Downloads stream in chunks; connections time out after 30 s. |
| Downloaded workbooks could stay in a shared PC's browser cache. | `Cache-Control: no-store` on workbook downloads. |
| Folder listings were served for `web/` subfolders. | Turned off. |
| The workflow gave `packages: write` to every job, including the one running tests. | Only the publish job has it. |
| A rule weight typed as `__proto__` could pollute JavaScript objects through the speed-change table. | Such keys are refused and only own properties are read. |
| A local file of any size was parsed. | Files over 50 MB are refused; macros, styles and rich-text HTML are not parsed. |

Not changed (decisions, not bugs): there is no login, so anyone who can reach the port can read the
workbooks in the data folder; Python's `http.server` is fine for a plant network but should not face
the internet; GitHub Actions are pinned to version tags, not commit hashes.

## Performance pass

Nothing runs on a timer: the page is completely idle until something is edited, typing in a setting
causes one rebuild (debounced), and a rebuild for a 100-core workbook takes about 10 ms including
the table.

The one hot spot was **Fill the shift**. For every job left out, it re-ran the full order search
(up to 5,040 block orders), so a 300-line workbook with 6–7 speed blocks took about 2.7 s per edit.
Now the full search runs once; filling the shift reuses that order (a job that adds a new speed
block has that block tried in each position), only the closest near misses get a full re-search
(at most 4, skipping jobs shaped like one that already failed), and one final full search orders
the result. Worst case: 2.7 s → about 0.1 s. Compared with the old method across 234 test
scenarios, plans were identical in 196, held more work in 22 and less in 8 (18,152 vs 18,044 cores
in total). Your workbook plans identically. A test now fails if this case takes over a second.

Also: a workbook's first usable sheet was converted to rows twice on load; it is now converted once.

## Numbers that are still guesses

The default rules (speeds, travel and interval per weight), the 2-minute speed change, the 50%
etcher position, and the 10-minute diverter setup were given from memory or chosen by me. Timing a
few real changeovers, or entering a measured line length and core pitch, will tighten every plan.
