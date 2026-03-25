# Config Explorer

Read-only React application for browsing environment `.properties` files, surfacing known values from matching files in other environments, and comparing two files side by side.

## What it does

- Shows a folder tree of discovered `.properties` files.
- Loads a selected file into a property-focused form.
- For each property, shows the current value plus known values observed in files with the same filename and property key.
- Compares any two property files and lists:
  - keys present only in the left file
  - keys present only in the right file
  - keys present in both files but with different values

## Run locally

```bash
npm install
npm run dev
```

The Vite UI runs on `http://localhost:5173`. The dev script automatically finds an available API port starting at `4177` and points the frontend proxy at it.

When the app opens, it shows an intro screen where the user can:

- use the currently detected folder
- choose a different parent config folder with the browser's native directory picker

## Share safely

You can share just the `config-explorer` app without sharing your real property files.

By default, the server scans the parent folder of `config-explorer`. Users can also pick a different folder from the intro screen, or set `SCAN_ROOT` manually if they prefer automation.

The interactive folder picker works best in Chromium-based browsers such as Chrome and Edge.

PowerShell example:

```powershell
$env:SCAN_ROOT='C:\path\to\target-config-root'
npm.cmd run dev
```

Example layout when sharing:

```text
Anywhere/
  config-explorer/
```

Then set `SCAN_ROOT` to the folder that contains the environment subfolders you want to inspect.
