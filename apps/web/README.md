# Lucid Dreams web app and bridge

The product people touch outside the headset (landing, Make a dream, library, dream pages) and the bridge that
implements the job API in [AGENTS.md](../../AGENTS.md). One Next.js server, one port: **5170**.

```bash
npm --prefix apps/web install
npm --prefix apps/web run dev          # http://<mac>:5170, open from any laptop or the Quest on the same Wi-Fi
```

**The demo** (Ojasva's Mac, real HiPerGator jobs, production build):

```bash
npm --prefix apps/web run demo
```

## Modes

| `BRIDGE_MODE` | What happens |
| --- | --- |
| `mock` (default) | Jobs walk through the real stages and messages in about a minute (`MOCK_SECONDS`). A finished job becomes a dream that links the sample bundle's files (`LUCID_SAMPLE_DREAM`, default `synthetic-test`) under the job's id and name. |
| `runner` | Real jobs on HiPerGator through `pipeline/runner/lucid_runner.py` (Ojasva's Mac only). The upload streams to disk, `submit` runs in the background, `status` is polled (cached 4 s), and when a run is done the bridge calls `fetch` once and reports `done` after the bundle is in `dreams/<id>/`. Runs the autopilot started answer too. |

Bundles live in `<repo>/dreams/` (git-ignored), shared with the runner and the WebXR viewer. For mock mode on your
own laptop, start from the committed sample: `cp -R samples/synthetic-test dreams/`.

## The Gemini guide

For every replay, the bridge asks Gemini to watch the move and write a guide: the move's name, its steps with the
second each begins, tips, and a narration that a TTS voice speaks into `guide.m4a` for the headset. It runs once per
dream, in the background, as soon as the dream lands (or when its page is first opened), and is kept in the bundle
as `guide.json` with `"guide": "guide.json"` added to `dream.json`.

- Gemini watches the original clip (trimmed on the Mac to the 5 seconds that were rebuilt, location metadata
  stripped) together with `preview.mp4`, and times every step on the preview's clock, so tapping a step on the dream
  page lands on the right pose. In runner mode, clips that only live on HiPerGator come back as the run's `prepped.mp4`.
- Uploaded videos are deleted from Gemini as soon as the guide is written. Gemini never names the person or speaks
  as them: it is a coach talking to you.
- Needs a key from https://aistudio.google.com/apikey in `apps/web/.env.local` (git-ignored):

```bash
GEMINI_API_KEY=...
# optional: GEMINI_MODEL, GEMINI_TTS_MODEL (comma-separated fallbacks), GEMINI_VOICE (default Sulafat)
```

`GET /api/dreams/<id>/guide` says where a guide stands (`ready`, `working`, `failed` with the reason, or `off`);
`POST` to the same path writes it again.

## API (contract in AGENTS.md)

| Call | Reply |
| --- | --- |
| `POST /api/jobs` | multipart `file`, `name`, `kind` (`replay` or `avatar`), optional `startS` -> `201 { "id" }`, or `400 { "error" }` saying what to fix |
| `GET /api/jobs/:id` | `{ id, status, stage, progress, etaS, message }` |
| `GET /api/dreams` | every `dream.json`, newest first |
| `GET /dreams/<id>/...` | bundle files, with Range support; `/dreams/index.json` mirrors the WebXR viewer's index |

All responses send `Access-Control-Allow-Origin: *`, so the Quest app and the WebXR viewer can call them directly.

## Design

Same tokens as `apps/webxr` (black, `#f5f5f7` text, `#86868b` secondary, one accent `#0071e3`, SF Pro / Inter,
hairlines at 12% white, 18 px radius). They're at the top of `app/globals.css`.
