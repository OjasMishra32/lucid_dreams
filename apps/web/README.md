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

## The experience step (Gemma)

The main goal is one sentence: any photo or video, plus what you want to do with that person, and they're in your
room doing it with you. Make a dream asks "What do you want to do with them?" (the `intent`); it goes to the runner as
`--intent` and lands in `dream.json`. When the dream arrives, the bridge asks Gemma to turn intent + person into
`experience.json` (AGENTS.md, Contracts, "Experience"): `teach` (steps with times, speed, repeats and a tip each),
`companion`, `watch` or `play` (chess, at a strength), and where they stand (`facing`, `beside`, `ahead`). The WebXR
viewer and the Quest app run it; the dream page shows the plan and names the main action by it.

- Gemma sees 6–8 evenly spaced JPEG frames from the clip window the person was built from: the upload cut on the Mac
  to `[startS, startS + durationS]` (location metadata stripped). Step times are seconds in the bundle's clip time.
  Clips that only live on HiPerGator come back as the run's `prepped.mp4` (runner mode); `preview.mp4` is used only
  when there's no clip at all. Avatars send their photo; with no picture, the plan comes from the sentence alone.
- Once per dream and intent: a copy is cached in `.data/experiences/`, so a re-fetched bundle never asks again.
- The planning request uses inline frames rather than Google Files. Gemma never names the person or speaks as them;
  tips are read by the device's own voice.
- Needs a key from https://aistudio.google.com/apikey in `apps/web/.env.local` (git-ignored):

```bash
GEMINI_API_KEY=...
# optional: GEMINI_MODEL=gemma-4-31b-it (otherwise the newest available gemma-...-it is selected)
```

`GET /api/dreams/<id>/experience` says where a plan stands (`ready`, `working`, `failed` with the reason, or `off`);
`POST` to the same path writes it again.

### Testing the intent box

`tests/intents.json` holds forty sentences, ten per mode (the five showcase moments, instruments, sport and dance,
cooking and crafts, companions, chess at every strength), each with the mode, place, environment, objects (and chess
strength) it should become.

```bash
npm --prefix apps/web test                         # both of the below
npm --prefix apps/web run test:plan                # clean()'s rules against canned model answers: no key, no network
npm --prefix apps/web run test:intents             # all forty through Gemma (needs GEMINI_API_KEY); without one, checks the file
npm --prefix apps/web run test:intents -- play     # one mode, or any words from a case id
```

The live check plans each sentence alone (no clip: an avatar for chess, a replay otherwise), prints every miss, and
says how many the model got right before `clean()` applied its rules. Those rules only cover what the sentence leaves
no doubt about: chess needs an avatar; companions and chess face you in your room; a lesson "next to me" is beside you;
instruments beside, whole-body moves ahead, hands-on work facing; a named place wins; an activity with no home
(cooking, crafts, tennis) says `room`, so the players don't pick a place from words like "box" or "shot"; objects are
lowercase singular nouns. `lib/bridge/*.ts` imports `server-only`, so the scripts run with `node --conditions=react-server` (and `tsx`).

## The coach in the lesson (Gemini Live)

In a lesson in the WebXR viewer, **Ask** (a fingertip button beside Place in your room, "Ask about this step" on the
laptop's step card, or the A key) opens a Gemini Live session about the step on screen: you ask out loud ("how should
my wrist be here?"), the teacher pauses, and the answer is read in the device's own voice, the same one that reads the
tips, never the person's. It listens for a follow-up for 10 s, then closes; it stops at once (mic released) when the
step changes, you leave the room or press Ask again.

- **The key stays on this Mac.** The viewer asks `/api/live/token` (through its own server, so the https page never
  calls http) for a **single-use ephemeral token** (`authTokens.create`, v1alpha) that has to open its session within
  a minute and expires after 5. The token is locked to one Live model and one config (`liveConnectConstraints`, every
  field locked): text replies, the system instruction with the plan's title and intent and the step's title, tip,
  clip times and speed, and where the teacher was paused. When the dream's `experience.json` has the step, its words
  are used, not the viewer's. The viewer then talks to Gemini directly over a WebSocket: your voice as 16 kHz PCM up,
  text back.
- **Never the person's voice.** Replies are text, spoken by the device. A Live model that can only speak gets audio
  plus its transcript; the viewer reads the transcript and never plays the audio. Gemini never names the person or
  speaks as them.
- **Models:** `gemini-3.8-live`, then `gemini-3.1-flash-live-preview` (override with `GEMINI_LIVE_MODEL`,
  comma-separated). Each is tried with text replies first, then audio plus transcript; the viewer remembers what worked.
- **Off without a key:** with no `GEMINI_API_KEY` the viewer shows no Ask button at all, and the lesson runs as before.
  A bad key or quota shows one sentence on the step card.
- **Rate limit:** 8 tokens a minute per device (the headset's address, forwarded by the viewer's server), 120 an
  hour for the Mac.

## API (contract in AGENTS.md)

| Call | Reply |
| --- | --- |
| `POST /api/jobs` | multipart `file`, `name`, `kind` (`replay` or `avatar`), optional `startS` and `intent` -> `201 { "id" }`, or `400 { "error" }` saying what to fix. An avatar may repeat `file` up to 10 times (one person): the first is the body photo (`.data/uploads/<uuid>/input.<ext>`), the rest are face photos in `faces/` beside it (`face-01.jpg`, ...; HEIC becomes JPEG before the runner submits) |
| `GET /api/jobs/:id` | `{ id, status, stage, progress, etaS, message }` |
| `GET /api/dreams` | every `dream.json`, newest first |
| `GET /dreams/<id>/...` | bundle files, with Range support; `/dreams/index.json` mirrors the WebXR viewer's index |
| `GET /api/live/token` | `{ state: "on" \| "off" }`: whether the lesson coach is available (a Gemini key is set) |
| `POST /api/live/token` | JSON `{ dream?, index, count, title, tip?, start, end, speed?, at?, plan?: { title?, intent? }, attempt? }` -> `201 { token, model, reply, attempt, attempts, expiresAt }`; `503` off, `429` too many, `400` / `502` `{ error }` in a sentence |

All responses send `Access-Control-Allow-Origin: *`, so the Quest app and the WebXR viewer can call them directly.

## Design

Same tokens as `apps/webxr` (black, `#f5f5f7` text, `#86868b` secondary, one accent `#0071e3`, SF Pro / Inter,
hairlines at 12% white, 18 px radius). They're at the top of `app/globals.css`.
