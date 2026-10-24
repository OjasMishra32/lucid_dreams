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

## Watch me try (Gemini feedback on your attempt)

A lesson's dream page links to `/library/<id>/try`: film your try, and Gemini compares it with the teacher's clip and
says what to fix, moment by moment ("0:02 · Your elbow flares out; keep it under the ball."). The notes sit beside both
videos, side by side, and tapping one seeks both to that moment.

- **Filming:** the laptop or phone camera (`getUserMedia` + `MediaRecorder`, MP4 where the browser can, else WebM)
  wherever the page is a secure context: on the Mac itself (`localhost`) or over https. On a plain-http LAN address the
  camera API is blocked, so the button becomes a file input with `capture="user"`, which opens the phone's own camera.
  A 5 s countdown to step back, up to 15 s of you, the lesson playing alongside.
- **On the Mac:** the try streams to `.data/attempts/<id>/<try>/` and avconvert re-encodes it (H.264, at most 20 s, no
  location metadata; WebM, which AVFoundation can't read, goes as recorded, up to 20 s: a browser recording carries no location).
  The teacher's side is the same clip window the plan was written from (`cutWindow` in `lib/bridge/experience.ts`),
  cut once per run into `.data/attempts/<id>/lesson.mp4`; the orbit render stands in when there's no clip.
- **Gemini** gets both videos and returns `{ notes: [{ attemptS, teacherS, note }], good, unclear }`, the main fix first;
  both uploads are deleted from Google right after. It never names or describes the person, and avoids left/right
  (front cameras mirror).
- **Into the lesson:** the main fix becomes the plan's last step, `"Your fix"` (the teacher's segment it's about,
  speed 0.5, repeat 2, tip = the fix), and experience.json gains `"feedback": { createdAt, notes, good, attempt, step }`
  (`teacherS` in the bundle's clip time). Saved to the bundle and the `.data/experiences` cache, so a re-fetch keeps it;
  a newer try replaces it. Only ever for plans whose `mode` is `teach`.
- No key: the try is kept and shown side by side, with no notes. A bad key fails with a sentence, never a stack trace.
- Tries are the learner's own videos: their routes send no CORS headers, so only this web app's pages can read them.

| Call | Reply |
| --- | --- |
| `GET /api/dreams/<id>/attempts` | `{ gemini, lesson: { state, src, scale, orbit }, attempts }` (newest first) |
| `POST /api/dreams/<id>/attempts` | multipart `file` (video), optional `durationS` -> `202` the try (`working`), or `400`/`409`/`429 { error }` |
| `GET /api/dreams/<id>/attempts/<try>` | `{ state: working/ready/failed/off, stage, notes, good, unclear, added, video }` |
| `POST /api/dreams/<id>/attempts/<try>` | ask Gemini again (after a failure, or once a key is in) |
| `DELETE /api/dreams/<id>/attempts/<try>` | the try's video and notes, gone from the Mac (its fix and notes leave the lesson too, if they're the lesson's latest) |
| `GET /api/dreams/<id>/attempts/<try>/video`, `GET /api/dreams/<id>/lesson` | the two videos, with Range |

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
