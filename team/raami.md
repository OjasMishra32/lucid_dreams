# Raami: the product app, the bridge and the Gemini guide

You own the product people touch outside the headset, and the API that connects everything. The bar is
**Apple-level design**: calm, white space, one accent colour, SF Pro / Inter, real content, no gradients-everywhere
or "AI template" look. This is our **Best Design** entry. Read `AGENTS.md` first.

## Your big chunk

| Piece | Done means |
| --- | --- |
| Web app in `apps/web/` (Next.js + TypeScript) | Landing page with the one-line pitch and a hero, "Make a dream" upload flow, the library of dreams, a dream detail page |
| Upload flow | Drop a clip or photo, name it, pick "replay" or "avatar"; checks the clip against the rules in `AGENTS.md` before upload (length, resolution, orientation) and says exactly what to fix |
| Live progress | Polls `GET /api/jobs/:id`; shows the stages (`check`, `views`, `upscale`, `reconstruct`, `export`) with a calm progress bar and ETA |
| Library and detail | Cards with `thumb.jpg`; detail page plays `preview.mp4` (the 360 orbit) and shows the fidelity numbers from `dream.json` |
| The bridge API | A small server on Ojasva's Mac implementing the job API in `AGENTS.md`. Start with a **mock** that serves a sample bundle and fake progress so you, Ian and the demo never wait; Ojasva wires the real HiPerGator calls in |
| Gemini guide (MLH prize) | Gemini watches the source clip and returns: the move's name, its steps with timestamps, and coaching tips. Shown on the detail page and spoken in the headset (Ian plays the audio) |

## Milestones

| When | Done |
| --- | --- |
| Fri 11 PM | Mock bridge running; web app skeleton with landing, upload and library against the mock |
| Sat 10 AM | Upload -> real job -> bundle works through the real bridge (with Ojasva) |
| Sat 8 PM | Polished end to end; Gemini guide working |
| Sun 10 AM | Frozen; screenshots for Devpost to Atina |

## Talk to

- Ojasva: wiring the bridge to HiPerGator, job stages and timings.
- Ian: the library endpoint.
- Atina: she designs the in-headset UI to match your web app, so share your colours, type and components early.
- Atina: copy, screenshots, the demo flow.

## Ready for you: the pipeline side of the bridge

`pipeline/runner/lucid_runner.py` (Python, stdlib only) already talks to HiPerGator. Your bridge can shell out to it,
or `import lucid_runner` and call the functions. Every command prints one JSON object.

| Bridge endpoint | Call |
| --- | --- |
| `POST /api/jobs` (save the upload to a temp file first) | `python3 pipeline/runner/lucid_runner.py submit <file> --name "<name>"` -> `{ "id", "slurm" }` |
| `GET /api/jobs/:id` | `lucid_runner.py status <id>` -> `{ id, status, stage, progress, etaS, message }`, exactly the contract shape |
| when `status` is `done` | `lucid_runner.py fetch <id>` -> copies the bundle into `<repo>/dreams/<id>/`, returns its `dream.json` |
| `GET /api/dreams` | read `<repo>/dreams/*/dream.json` (newest first), or proxy the viewer's `/dreams/index.json` |
| `GET /dreams/<id>/...` | serve `<repo>/dreams/` statically |

- It only works on Ojasva's Mac (it uses his HiPerGator connection). For your own development, use the mock with a
  sample bundle: `dreams/synthetic-test/` on Ojasva's Mac is a real bundle you can copy.
- `status` messages are written for people ("Imagining every angle of them", "Building them in 3D, frame by frame"):
  show them as-is under the progress bar.
- Real runs take roughly 6 min (views) + 25 min (reconstruction, split across GPUs) + 2 min (export). Design the
  progress screen for a wait of about half an hour: it should feel calm, not stuck.
- Bundles now also carry `frames.reality` and `metrics.seenFraction` (how much of the person the camera really saw).
  Show "62% seen by the camera" on the detail page: judges love honest numbers.
- The 3D viewer is `apps/webxr` (Ojasva's). Link a dream's detail page to `https://<mac>:5180/?dream=<id>` for
  "View in 3D / in your room" instead of building your own 3D view.

## Next chunk (added after your web app + bridge push: excellent, the runner wiring and seen % are exactly right)

1. **Gemini guide (MLH Best Use of Gemini). Highest priority.** For every dream, send the source clip
   (`dream.source.clip`, or the run's `prepped.mp4`) to Gemini's video understanding and get back JSON:
   `{ "move": "Step-back jumper", "summary": "...", "steps": [{ "t": 0.4, "title": "Load", "cue": "Sink the hips" }],
   "tips": ["..."] }`. Save it as `guide.json` in the bundle (add `"guide": "guide.json"` to `dream.json`: an
   additive contract change, tell the team). Show it on the dream page as a calm step list synced to the preview video
   (tap a step to jump). Generate a spoken version (Gemini TTS) as `guide.m4a` so the headset can play it.
2. **Demo mode on Ojasva's Mac.** Make `BRIDGE_MODE=runner npm --prefix apps/web start` the documented demo command
   and test it end to end as soon as the first real dream lands (SMPL-X download is the last blocker).
3. **Landing hero.** Lead with the newest real dream's `preview.mp4` (the 360 orbit), big and quiet, like an Apple
   product page. The viewer's landing in `apps/webxr` does a small version of this: match it.
4. **Make a dream, for landscape clips.** The pipeline now crops landscape clips to a fixed 9:16 window around the
   person automatically, so stop rejecting landscape: accept it and say "We'll frame them for you."
5. **Screenshots** of every page for Atina's Devpost once real dreams are in.

## Unblocked (Ojasva, Fri 11 PM): your three asks are answered

- **Sample bundle:** it's in the repo now: `samples/synthetic-test/`. `cp -R samples/synthetic-test dreams/`.
- **Avatar jobs:** `lucid_runner.py submit <photo> --kind avatar --name "<name>"` now runs Vishal's DiGS job. Pass
  `kind` straight through from `POST /api/jobs`. Status and fetch work the same as replays.
- **`startS`: approved.** Add it to `POST /api/jobs` and pass `--start-s` to the runner. It's in the contract now.
- **Gemini key:** get your own free key at https://aistudio.google.com/apikey and put it in `apps/web/.env.local`
  (git-ignored). For the demo, put the same key on Ojasva's Mac yourself when you're at the table.

## Your backlog (ordered; decide everything inside apps/web yourself)

1. **Gemini guide** (MLH prize): `guide.json` (move, summary, steps with timestamps, tips) + spoken `guide.m4a`;
   dream page shows steps synced to the preview video. Cache per dream so it runs once.
2. **5-second window picker** in Make a dream: a filmstrip of the clip with a draggable 5-second highlight -> `startS`.
   It should feel like trimming in Photos.
3. **"From a photo" flow** (`kind: "avatar"`): full-body photo checks (one person, head to toe, decent size), a consent
   checkbox ("I have permission to bring this person in"), and the same calm progress screen.
4. **Landing:** hero = newest real dream's 360 preview; a three-step "How it works" with real numbers pulled from
   `dream.json` (views, Gaussians per frame, % seen); one closing line and the Make a dream button.
5. **Dream page:** big preview, the guide, honest numbers (PSNR, % seen), "View in your room" linking to the WebXR
   viewer, and a share link with the thumb as the preview image.
6. **Failure states that feel designed:** a run that fails shows what to fix (from the runner's message), never a stack trace.
7. **Demo command:** `npm run demo` in apps/web that starts the web app in runner mode; document it in the README.
8. **Polish pass:** motion (subtle, under 300 ms), focus states, empty states, mobile layout, Lighthouse 95+.
9. **Screenshots** of every page at 2x for Atina's Devpost once real dreams exist.
