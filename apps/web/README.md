# Lucid Dreams web app and bridge

The product people touch outside the headset (landing, Make a dream, library, dream pages) and the bridge that
implements the job API in [AGENTS.md](../../AGENTS.md). One Next.js server, one port: **5170**.

```bash
npm --prefix apps/web install
npm --prefix apps/web run dev          # http://<mac>:5170, open from any laptop or the Quest on the same Wi-Fi
```

For the demo, run the production build instead (faster, no dev overlay):

```bash
npm --prefix apps/web run build && npm --prefix apps/web start
```

## Modes

| `BRIDGE_MODE` | What happens |
| --- | --- |
| `mock` (default) | Jobs walk through the real stages and messages in about a minute (`MOCK_SECONDS`). A finished job becomes a dream that links the sample bundle's files (`LUCID_SAMPLE_DREAM`, default `synthetic-test`) under the job's id and name. |
| `runner` | Real jobs on HiPerGator through `pipeline/runner/lucid_runner.py` (Ojasva's Mac only). The upload streams to disk, `submit` runs in the background, `status` is polled (cached 4 s), and when a run is done the bridge calls `fetch` once and reports `done` after the bundle is in `dreams/<id>/`. Runs the autopilot started answer too. |

```bash
BRIDGE_MODE=runner npm --prefix apps/web start
```

Bundles live in `<repo>/dreams/` (git-ignored), shared with the runner and the WebXR viewer. For mock mode on your
own laptop, copy a real bundle there first, e.g. `dreams/synthetic-test/` from Ojasva's Mac.

## API (contract in AGENTS.md)

| Call | Reply |
| --- | --- |
| `POST /api/jobs` | multipart `file`, `name`, `kind` (`replay` or `avatar`) -> `201 { "id" }`, or `400 { "error" }` saying what to fix |
| `GET /api/jobs/:id` | `{ id, status, stage, progress, etaS, message }` |
| `GET /api/dreams` | every `dream.json`, newest first |
| `GET /dreams/<id>/...` | bundle files, with Range support; `/dreams/index.json` mirrors the WebXR viewer's index |

All responses send `Access-Control-Allow-Origin: *`, so the Quest app and the WebXR viewer can call them directly.

## Design

Same tokens as `apps/webxr` (black, `#f5f5f7` text, `#86868b` secondary, one accent `#0071e3`, SF Pro / Inter,
hairlines at 12% white, 18 px radius). They're at the top of `app/globals.css`.
