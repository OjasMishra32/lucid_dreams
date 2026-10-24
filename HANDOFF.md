# Handoff: Lucid Dreams, Sat Oct 24, 2026, ~1 PM ET

For a new Claude session picking this up. **Read `AGENTS.md` first** (the ground truth: product, contracts, rules,
team, status log). This file adds what tonight's session knows that isn't written anywhere else: the state right
now, the work in flight, how to run things, and what's left.

## Deadlines
- **Sun Oct 25, 10 AM ET: feature freeze**; film the demo video.
- **Sun 3 PM ET: Devpost submitted** (hard deadline 5 PM).
- Finals Mon 10:15 AM if top 10.

## How Ojasva wants to work (follow these)
- **Act, don't ask.** Keep updates short and plain.
- **Usage is tight:** run at most 1-2 background agents at a time, and do small things inline.
- **Extreme realism, judged in the actual scene from every angle.** No blur, floaters, ghost limbs, clipping or
  "mushy" hands or faces. Look at renders yourself before calling anything done.
- **Hands-only Quest 3S, locked down.** No gesture may trigger anything by accident. One vocabulary everywhere:
  palm-up left-hand menu, right index presses, pinch to grab.
- **Commits:** plain messages about Lucid Dreams, **no AI co-author trailers**. Use `git pull --no-rebase --no-edit`,
  never stash, and commit only your own files; teammates' agents push to main all the time.
- **Public figures** (Magnus, Bobby Fischer, LeBron, Federer):
  - labelled "…Not affiliated.";
  - never speak;
  - no brand logos.
- **Privacy:** `ian-grandma*` is private. Never serve it over HTTP or a tunnel, and never put it on the site, kiosk,
  showcase or git. It reaches the headset only by `adb push`.

## State now: what works (all on main, all in the WebXR app `apps/webxr`)
Everything has been tested in Meta's WebXR emulator (IWER, `?emulate`) and the desktop browser. **Almost nothing has
been tried on the real Quest yet.** That is the biggest open risk.

| World | URL / dream | What's there |
| --- | --- | --- |
| Chess vs legends | `?mode=chess&strength=carlsen` / `fischer` | Photoreal Magnus (`magnus-carlsen-uika-360`) and Bobby (`bobby-fischer-uika`) at a real walnut table. They play at peak Elo via Stockfish, reach and move pieces without clipping (`apps/webxr/scripts/check_chess_poses.ts` passes), press the clock, and shake your tracked hand before the match (a nod on a laptop). Board on an anchor with a handle; captures into your hand. |
| Tennis vs Federer | `?mode=tennis` | A full match on grass: every serve, every stroke, full scoring, AI with real GVHMR motion (`public/tennis/motions/`). Federer (`roger-federer-uika`) is **held from the library** because his face isn't recognisable enough yet; tennis loads him by direct link. |
| Basketball | `?dream=lebron-shot`, `?dream=jump-shot-hq` | Hold, dribble and shoot a ball; pass to LeBron and he catches and shoots with his real release. The tracked ball is in the replay (`lucid.ball`). **Ojasva said no more LeBron features.** |
| Golf | `?dream=golf-01` | A 7-iron in your hands, a ball to hit, a lesson. |
| Guitar | `?dream=guitar-01` | A guitar at your waist, chords along the neck, strum. |
| Dance / tai chi | `?dream=dance-01`, `taichi-01` | Lessons, Follow along (glowing targets from `joints.json`, a score), Mirror. |
| Lessons, all replays | | Step card, Back/Again/Next, Reality check. |

Library: one of each (see `dreams/.held` for what's hidden). Replays were re-reconstructed today with
`lucid.recon --source-agree`, which removed the ghost limbs. The trade: views PSNR went up, but pixel match to the
source camera went down; the measured table is in `team/ian.md` "SUBMISSION". Tai chi and jump shot were moved down
onto the floor (`lucid.floor`).

## In flight when this session ended (check them first)
Five background agents were running in the old session; they stop when that session does. For each, check
`git log` for its commit and `git status` for half-done edits. The tree currently has uncommitted changes in:
- `apps/webxr/src/{chess/game.ts, club.ts, dream.ts, experience.ts, follow.ts, guitar.ts, styles.css, viewer.ts,
  xr/menu.ts}`
- `avatars/avatar_audit.py`

Finish, or `git diff` and decide; run `npx tsc --noEmit` in apps/webxr.
1. **Chess "famous moves":** `apps/webxr/src/chess/famous.ts`, hooks in game.ts. Find the legend's real move from
   positions in their real games; positions must be verified by replaying the PGN legally and by Stockfish. The
   legend nods (`nod()`) or shakes his head (`headShake()` in seated.ts).
2. **Golf tempo coach + guitar rhythm:**
   - golf: his backswing:downswing tempo from `joints.json` against yours, plus tempo tones;
   - guitar: `pipeline/lucid/strums.py` writes `strums.json` from the audio, and a rhythm lane scores your strums.
   - Touches club.ts, guitar.ts and viewer.ts.
3. **Dance ghost:** records your head and hands on your turn and replays a glowing "you" beside the teacher, with a
   score card; `pipeline/lucid/beats.py` writes `beats.json`, shown as beat pulses on the floor. `dance-01` already
   has `beats.json`. Touches follow.ts, experience.ts and viewer.ts.
4. **Federer's face:** UIKA distills from many sharp 2009-10 frontal Commons photos, plus hair and headband fixes.
   Ship only if he reads as unmistakably Federer (`lhmpp_avatar.py likeness` makes the photo-vs-render sheet); then
   remove `roger-federer-uika` from `dreams/.held`.
5. **Magnus neck blob:** a dark fuzzy blob where his neck meets his left shoulder when he turns. Fix in
   `avatars/lhmpp_cleanup.py`, then redeploy `magnus-carlsen-uika-360` on the Mac and HiPerGator.

## What's left (in order)
1. Land or clean up the five items above.
2. **Test on the Quest 3S (Ojasva in the headset):** chess (handshake, moves, table), tennis (serve/rally/menu),
   basketball, golf, guitar, dance, frame rate, and that hands never trigger things by accident. Fix what he finds.
3. **Write-up (Ian owns it):** `demo/devpost.md`, `README.md`, `demo/video.md`, `demo/judges.md` must match what's
   true. `team/ian.md` "SUBMISSION" has the measured numbers and the "new since" list. Ojasva reviews by Sun 10 AM.
4. **Court Side (Vishal, `docs/plans/court-side-status.md`):** asks 1-19 are answered. Answer new asks at the top
   (newest first) in place, as "**(Ojasva, time): …**".
5. Known flaws:
   - the legends' hands are soft up close (rebuilt hands looked worse);
   - Bobby's collar points are a bit patchy;
   - dance sits ~2 cm into the floor (left alone);
   - LeBron's ball track covers fewer frames.

## Running services on Ojasva's Mac
- **Ports:**
  - `:5170` web app + bridge (`apps/web`, runner mode);
  - `:5175` Talk (`apps/talk`, keys in its git-ignored `.env`);
  - `:5180` WebXR, https (what the headset uses);
  - `:5181` WebXR over plain http (working tree, for desktop checks);
  - `:5190` public site (`apps/site`).
- **Cloudflare quick tunnels** (campus Wi-Fi blocks the Quest from the Mac):
  - WebXR: `cloudflared tunnel --url https://localhost:5180 --no-tls-verify`;
  - the bridge and Talk URLs are in `~/LucidDreams-held/{bridge,talk}-tunnel.txt`.
  - Quick-tunnel URLs change if restarted; update those files, and the headset's `bridge.txt`/`talk.txt` via adb.
- **Autopilot:** `pipeline/runner/autopilot.py` fetches finished runs into `dreams/`, and `caffeinate -dimsu` keeps
  the Mac awake.
- **Quest setup:** `~/LucidDreams-held/quest-setup.sh` waits for a USB-connected Quest, then installs Ian's APK and
  pushes grandma, `talk.txt` and `bridge.txt`. Log: `~/Library/Logs/quest-setup.log`.

## HiPerGator
- `ssh -S ~/.ssh/cm-hpg -o BatchMode=yes hpg` uses a shared control socket. If it's gone, Ojasva has to log in
  again; never type his password. `L=/blue/iruchkin/vishalnaveen/lucid`.
- **Jobs:** source `$L/code/pipeline/hpg/env.sh`. B200s: `-p hpg-b200 -A iruchkin -q iruchkin`, 3-4 CPUs per GPU job
  (the group limit is 96 cores). Runs live in `$L/runs/<id>/` (views, prepped.mp4, bundle, recon).
- **Code:** the HiPerGator copy is `$L/code/pipeline`; rsync changed files there after committing.
- **Storage:** tight earlier; 1.6 TB free at handoff. Delete intermediates anyway.

## Pipeline tools added today (all in `pipeline/lucid/`, documented in their docstrings)
- `ball.py`: the basketball tracked as one ball (round, off the body by `joints.json`, falling when free).
- `floor.py`: moves a bundle so planted feet touch y = 0, with its joints and props.
- `recon.py` options:
  - `--source-agree` (no ghost limbs);
  - `--source-masks/--source-ignore/--source-focal` (shared frames, e.g. Court Side);
  - `--extra-sources` (more real camera angles).
- `export.py --placement-from <old dream.json>`: re-export without moving anything.
- `clean.py`, `clean_check.py`: measuring tools; the cleanup itself didn't help, so it's unused.
- A local Python with numpy and scipy is only in scratch (`uv venv` one if needed). Tests:
  `PYTHONPATH=pipeline python -m unittest discover -s pipeline/tests`.

## Where the old session kept things
- `~/LucidDreams-held/`: old bundles (`prev/`, `prefloor/`), an archive of the piano run, tunnel URL files, the Quest
  setup script, and the legends' source photos.
- Rollback copies on HiPerGator: `$L/data/avatars/.../<id>.prev`; the Federer one is `roger-federer-uika.prestruct`.
