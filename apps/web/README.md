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

On the demo table: `/showcase` is the five moments from `demo/showcase.md`, each opening the viewer (or the chess table
for the legends); `/kiosk` cycles the best dreams full screen, 8 s each (F for full screen, arrow keys to step). Every
dream page has its Places (the viewer with `?place=`) and an "Open on Quest" address to type in the headset's browser.

## Live (`/live`): how it works, shown

For the judges' laptop: one run, read from HiPerGator every 5 s and refreshed in place. Its stages with real timings
(from the run's `status.json`, plus the time each one waited for a GPU), the GPUs on it right now by model (the lab's
jobs in `squeue`, matched by the run's `slurm.json` or its folder), and the latest fitted frame: the strip
`recon.py --peek` writes to `runs/<id>/recon/peek-<frame>.jpg`, each pair 4DAnyone's view beside our render from the
same camera. `/live?id=<run>` shows that run; plain `/live` follows the newest run still building, else shows the newest
one. Linked from the library's "In progress" row and from each job page.

- Everything comes through lucid_runner's own SSH connection and rsync (read-only: files and `squeue`, never a job
  change). One read per run every 5 s, however many people are watching; fitted frames are copied to `.data/live/`.
- If HiPerGator stops answering, the page keeps the last answer and says how old it is.
- Mock mode shows the demo run's real stages and timeline on this Mac, labelled as a demo, with the sample bundle's
  thumbnail and no fitted frame (there is none to show).

`GET /api/live?id=<run>[&follow=1]` returns what the page shows (`LiveReply` in `lib/live.ts`).

## Modes

| `BRIDGE_MODE` | What happens |
| --- | --- |
| `mock` (default) | Jobs walk through the real stages and messages in about a minute (`MOCK_SECONDS`). A finished job becomes a dream that links the sample bundle's files (`LUCID_SAMPLE_DREAM`, default `synthetic-test`) under the job's id and name. |
| `runner` | Real jobs on HiPerGator through `pipeline/runner/lucid_runner.py` (Ojasva's Mac only). The upload streams to disk, `submit` runs in the background, `status` is polled (cached 4 s), and when a run is done the bridge calls `fetch` once and reports `done` after the bundle is in `dreams/<id>/`. Runs the autopilot started answer too, and the library's "In progress" lists every unfinished run in `dreams/.runs.json` (submitted by hand or by the autopilot) with its live status. |

Bundles live in `<repo>/dreams/` (git-ignored), shared with the runner and the WebXR viewer. For mock mode on your
own laptop, start from the committed sample: `cp -R samples/synthetic-test dreams/`.

## The experience step (Gemini)

The main goal is one sentence: any photo or video, plus what you want to do with that person, and they're in your
room doing it with you. Make a dream asks "What do you want to do with them?" (the `intent`); it goes to the runner as
`--intent` and lands in `dream.json`. When the dream arrives, the bridge asks Gemini to turn intent + person into
`experience.json` (AGENTS.md, Contracts, "Experience"): `teach` (steps with times, speed, repeats and a tip each),
`companion`, `watch` or `play` (chess, at a strength), and where they stand (`facing`, `beside`, `ahead`). The WebXR
viewer and the Quest app run it; the dream page shows the plan and names the main action by it.

- Gemini watches the clip window the person was built from: the upload cut on the Mac to `[startS, startS + durationS]`
  (location metadata stripped). Step times are seconds in the bundle's clip time. Clips that only live on HiPerGator
  come back as the run's `prepped.mp4` (runner mode); `preview.mp4` is used only when there's no clip at all. Avatars
  send their photo; with no picture, the plan comes from the sentence alone.
- Once per dream and intent: a copy is cached in `.data/experiences/`, so a re-fetched bundle never asks again.
- Uploads are deleted from Gemini as soon as the plan is written. Gemini never names the person or speaks as them;
  tips are read by the device's own voice.
- Needs a key from https://aistudio.google.com/apikey in `apps/web/.env.local` (git-ignored):

```bash
GEMINI_API_KEY=...
# optional: GEMINI_MODEL (comma-separated fallbacks)
```

`GET /api/dreams/<id>/experience` says where a plan stands (`ready`, `working`, `failed` with the reason, or `off`);
`POST` to the same path writes it again.

## API (contract in AGENTS.md)

| Call | Reply |
| --- | --- |
| `POST /api/jobs` | multipart `file`, `name`, `kind` (`replay` or `avatar`), optional `startS` and `intent` -> `201 { "id" }`, or `400 { "error" }` saying what to fix |
| `GET /api/jobs/:id` | `{ id, status, stage, progress, etaS, message }` |
| `GET /api/dreams` | every `dream.json`, newest first |
| `GET /dreams/<id>/...` | bundle files, with Range support; `/dreams/index.json` mirrors the WebXR viewer's index |

All responses send `Access-Control-Allow-Origin: *`, so the Quest app and the WebXR viewer can call them directly.

## Design

Same tokens as `apps/webxr` (black, `#f5f5f7` text, `#86868b` secondary, one accent `#0071e3`, SF Pro / Inter,
hairlines at 12% white, 18 px radius). They're at the top of `app/globals.css`.
