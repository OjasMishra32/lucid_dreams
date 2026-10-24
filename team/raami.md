# Raami: the product app, the bridge and the Gemini guide

You own the product people touch outside the headset, and the API that connects everything. The bar is
**Apple-level design**: calm, white space, one accent colour, SF Pro / Inter, real content, no gradients-everywhere
or "AI template" look. This is our **Best Design** entry. Read `AGENTS.md` first.

## TOP PRIORITY (Sat 1 AM): more photos in, the most human result out

Ojasva's verdict on the photo people: "creepy, uncanny". One photo is too little. The face now gets its own model
(LAM, one photo becomes a 3D head that talks and blinks), and it does better with the right photo. Your part is
getting several photos in and picking the winner:

1. **Several photos of one person.** "From a photo" takes 1-10 photos of the same person: the best head-to-toe
   one builds the body, every face photo goes to the face model. Show a strip of thumbnails with "Body" and
   "Face" tags, and reject photos with no face or two people.
   - **Contract change** (posted in the Status log): `POST /api/jobs` with `kind=avatar` accepts repeated `file`
     fields; the first is the body photo.
   - The bridge saves the rest to `faces/` next to it. Ojasva makes `lucid_runner.py` pass them on.
2. **Gemini realism check** (`apps/web/server/realism.ts`). When a dream lands, send Gemini the source photo and
   three renders (front, 3/4 and profile, frames of `preview.mp4`). Ask for JSON: same person (yes/no plus
   confidence), and concrete defects (eyes, skin tone, hairline, hands, seams, floaters) with where they are.
   - Show it on the dream page as an honest "Realism check" panel.
   - Use it to choose between candidate heads (one per face photo): the highest same-person confidence ships.
   - Cache it by `updatedAt`, and rate-limit it.
3. **You own `apps/site` now** (the public showcase site; same design bar). Swap the hero to the real `jump-shot`
   replay: `PERSON.frames` in `apps/site/src/config.ts` points at a bundle. Then make the use-case reel play the
   three best real dreams with their names. No public-figure dream in the hero.

## MORE (Sat 1:20 AM): a lot more, in order, after the top items (Gemini prize work first)

1. **Gemini Live coach in the lesson.** A fingertip "Ask" button in the WebXR viewer (you have Ojasva's OK to edit
   `apps/webxr`) opens a Gemini Live audio session: "how should my wrist be here?" is answered about the step on
   screen, with the step's clip time and tip in the context.
   - It speaks in the device's voice, never the person's.
   - The API key stays on the bridge: a token endpoint in `apps/web` mints short-lived credentials.
2. **"Watch me try" feedback.** In the web app, record your attempt with the laptop or phone camera. Gemini compares
   it with the teacher's clip and returns timestamped notes ("0:02, your elbow flares out; keep it under the ball").
   Show them on both videos side by side, and add the notes to the experience as a `feedback` step.
3. **A live pipeline page for the judges** (`/live`): the stages of a running job (upload, views, reconstruct,
   export) with real timings, GPUs in use and the latest truth-vs-render strip (`runs/<id>/recon/peek-*.jpg`,
   fetched by the runner), so "how it works" is shown, not told. Calm, one accent colour, no dashboard clutter.
4. **The intent box understands more.** Ten example sentences per mode (teach, companion, watch, play). Test that
   Gemini picks the right mode, place, environment and props for all forty, and fix the prompt until it does. Keep
   the forty as a test file in `apps/web`.
5. **Accessibility and polish:** keyboard paths through Make a dream, reduced-motion everywhere on the site, alt
   text on every preview, and Lighthouse 95+ on `apps/site` too.

## BIG CHUNK (Sat 12:20 AM): make the main goal real in the web app

Round two is excellent (guide, window picker, consent, Lighthouse 98-100, the injection fix). Your two notes for
Ojasva are done: avatars now arrive with `avatar.ply` (the fetch skips only `/frames/*.ply`), and `.gitignore`
anchors `/dreams/`. Tonight's real dreams land in `dreams/` within the hour: `jump-shot`, `jump-shot-2`,
`lebron-jumper` (intent "teach me this jump shot"), `piano-han` (Jason Han, "sit next to me and teach me this
piece"), and avatars `bobby-fischer`, `magnus-carlsen` ("play chess with me") and `juice-wrld` ("I just want to see
him"). In order:

1. **One Gemini call, two files.** Your guide step writes `guide.json`; the players run `experience.json`
   (AGENTS.md, Contracts, Experience). Have the same call return both (or derive experience.json from the guide):
   `mode` from the intent, `steps` = your guide steps with `start`/`end` in the bundle's clip time, `speed` 0.5,
   `repeat` 2, a short `tip`; `place` (`beside` for instruments, `ahead` for moves you follow, `facing` otherwise);
   `environment` (concert-hall, court, gym, ring, studio, mountains, or room); `objects` (["basketball", "hoop"]).
   Write it into the bundle and add `"experience": "experience.json"` to dream.json. Run it on every dream above as
   it lands. The WebXR viewer and Ian's Quest app pick it up with no other change.
2. **The intent field in Make a dream** is still missing: one line under the file ("What do you want to do with
   them?") with tappable suggestions ("Teach me this", "Sit next to me and teach me this piece", "Just be with me",
   "Play chess with me"), sent as `intent` and passed to the runner as `--intent`.
3. **Showcase page** (`/showcase`, linked first in the nav): the five moments from `demo/showcase.md` as big,
   quiet cards with each dream's preview video; each opens the right thing (viewer with `?dream=`, or chess with
   `?mode=chess&opponent=`). This is what judges see first on the laptop.
4. **Dream page:** a Places row (Your room, Concert hall, Court, Gym, Ring, Studio, Mountains) that opens the viewer
   with `?place=<id>`; the plan's steps with times; Reality check's % seen; for avatars, "Play chess with them".
5. **Jobs:** list runs submitted by hand too (they're in `dreams/.runs.json`) with live status from the runner.
6. **Open on Quest:** a short, typeable URL on every dream page (the Mac's LAN address + `:5180/?dream=<id>`),
   large and copyable, because the Quest browser can't scan a QR code.
7. **Finals kiosk** (`/kiosk`): full-screen previews of the best dreams cycling every 8 s, with the person's name
   and the one sentence, for the laptop on the demo table.

## ADDED (Fri 11:40 PM): sentences and places

- Suggestions under the intent field: "Teach me this", "Sit next to me and teach me this piece", "Just be with me",
  "Play chess with me".
- The Gemini plan may set `"environment"` (a place id: concert hall, court, ring, studio; list in AGENTS.md under
  Experience once the Places builder pushes). Ask Gemini to pick one only when the activity clearly has a home
  (piano -> concert hall, basketball -> court).
- `demo/showcase.md` lists the five demo moments; make sure each one works end to end from the web app.

## ADDED (Fri 11 PM): props in the plan

When Gemini writes `experience.json`, also ask it which objects matter for the intent (`"objects": ["basketball",
"hoop"]` for a jump shot, `["guitar"]` for a strum). Put that list in experience.json as `objects`. The pipeline
(`props.json`) tracks the ones it can see (the ball) and adds the ones it can't (a regulation hoop for a shooting
lesson). The dream page can show them as small chips under the plan.

## NEXT (Fri 10:45 PM): real dreams land tonight, give them plans

Three real replays finish tonight and land in `dreams/` on Ojasva's Mac: `jump-shot`, `jump-shot-2` and
`lebron-jumper` (its `dream.json` carries `"intent": "teach me this jump shot"`). Buster Keaton (1920) and possibly
Josephine Baker (1928), both public domain, follow.

1. **Run your Gemini experience step on each as it lands.** That's the first real test of the main goal: LeBron's
   clip + "teach me this jump shot" should come out as 3-5 steps (dribble, gather, set, release, follow-through)
   with real timestamps. Until a plan exists, the viewer falls back to three equal parts, so a real plan is the
   visible win.
2. **Intent field in Make a dream** (unchanged, still top).
3. **The public site is separate.** Ojasva is building a showcase site in `apps/site` (3D hero, scroll story, use
   cases). Keep `apps/web` as the tool people use. Its landing can stay simple and link "See what it does" to the
   site. Same tokens, so they feel like one product.
4. **Old footage picker:** for a long upload (a film, an hour of home video), call `python -m lucid.find_windows
   <file>` through the runner on HiPerGator (it scores every 5-second stretch for one person, whole body, still
   camera) and show the best windows as tappable thumbnails, which set `startS`. Ojasva can wire the runner call if
   you build the UI.

## NOW (Fri 10:10 PM): your top item is the brain of the main goal

Thanks for catching the export bug ("Jump shot" split on the space): fixed in `stage-export.sbatch` (every job field
is read on its own now), before the first real runs reached export. That would have cost us the night.

The product, in one line (AGENTS.md, top): **any photo or video + one sentence of what you want to do with that
person -> they're in your room doing it with you.** The sentence is the `intent`; the plan is `experience.json`
(AGENTS.md, Contracts, "Experience"). You own turning one into the other. This is also our MLH Gemini entry, and it
replaces the separate "guide" item.

1. **"What do you want to do with them?"** in Make a dream: one text field under the file, with three tappable
   suggestions that fill it ("Teach me this", "Just be with me", "Play chess with me"). Send it as `intent` in
   `POST /api/jobs`, and pass it to the runner as `--intent "<text>"` (the runner already takes it, and it lands in
   `dream.json` as `intent`).
2. **The experience step (Gemini):** when a dream finishes (it appears in `dreams/<id>/` on the Mac), call Gemini with
   the clip window the person was built from (the uploaded file cut to `[startS, startS + durationS]`; not
   `preview.mp4`, which is an orbit render), the intent and the name, with a JSON response schema matching
   `experience.json`. Rules for the prompt: step times are seconds in that cut (0 = its first frame); 2-6 steps for
   teach; `place` is `ahead` for moves you follow (dance, sport form), `facing` for things you watch hands do (guitar,
   cooking) and for companions; tips are short, second person, one sentence. Write `dreams/<id>/experience.json`, add
   `"experience": "experience.json"` to its `dream.json`. Cache: never call twice for the same id + intent.
3. **Dream page:** show the plan (title, steps with times) and make "View in your room" the obvious action; for
   `play` mode also link `https://<host>:5180/?mode=chess&opponent=<id>&strength=<strength>`.
4. Then: the 5-second window picker, photo consent checkbox, captions track, chess nav link (unchanged).

Test now without HiPerGator: `dreams/test-avatar/` on Ojasva's Mac has a hand-written `experience.json` (a two-step
"wave hello" lesson). The WebXR viewer already runs it: `http://localhost:5181/?dream=test-avatar`.

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

## Update (Fri 9 PM): checked what's in, here's what's next

In and working: web app + bridge (landing, Make a dream with clip checks, live progress, library, dream pages, mock
and runner modes, `/api/dreams` for Ian, run-id validation). Great base.

Not started yet, in this order:
1. **Gemini guide** (MLH Gemini prize, so it matters): `guide.json` + spoken `guide.m4a` per dream, steps synced to the
   preview video on the dream page, cached so it runs once. Key in `apps/web/.env.local` (git-ignored).
2. **5-second window picker** in Make a dream (`startS` in the POST; the bridge and runner already take it).
3. **Photo flow consent:** the photo/avatar toggle exists; add the required checkbox ("I have permission to bring this
   person in") and the full-body photo checks (one person, head to toe).
4. **Captions on the dream page:** bundles will get an optional `captions` (WebVTT, `captions.vtt`) from Atina's new
   captions step. Show them under the preview video as a `<track>`, styled like the rest of the page.
5. **Avatars show a live preview now:** the WebXR viewer skins avatar bundles live (no more rest pose), so "View in
   your room" works for `kind: "avatar"` too. Same link.
6. **Chess link:** add a quiet "Chess" item to the nav that opens `https://<host>:5180/?mode=chess` (the side mode:
   hand-tracked board, engine up to Carlsen's peak rating). On a dream page for an avatar, also offer
   "Play chess with them" -> `?mode=chess&opponent=<id>`.
7. `npm run demo`, the polish pass and screenshots, as before.
