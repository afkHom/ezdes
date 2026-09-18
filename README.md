# EZDES Standalone

This branch is the direct-open version of EZDES. It has no Python server, Docker service, shared storage, or folder-path access.

## Open EZDES

Double-click `Open-EZDES.bat`, or open `copper-speed-organizer.html` in a modern browser.

Keep these files together in the same folder:

- `copper-speed-organizer.html`
- `xlsx.full.min.js`
- `Open-EZDES.bat` (optional convenience launcher)

Choose an Excel or CSV workbook inside EZDES. The workbook is processed locally in the browser. Presets, notes, pins, mixed-layer choices, and manual schedule order are saved only in that browser's local storage.

The standalone branch intentionally does not include latest-file folder lookup or storage shared across devices.
