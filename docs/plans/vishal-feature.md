# Vishal's feature: Ghost Coach ("your try, in 3D")

Planning doc, Sat Oct 24 early morning. No code yet. Owner: Vishal (avatars + web app).
Read with `AGENTS.md` (main goal, The bar, Contracts, Consent, Honesty) and `team/vishal.md`.

## Why this, in one paragraph

The product line is "any photo or video in, plus one sentence, and they're in your room doing it with you", and the
tagline promises you can "learn the move from them". Today the lesson stops at *watch*: teach mode slows the teacher
and freezes for "your turn", and Watch me try returns Gemini's 2D notes on your phone video. Nobody ever sees *their
own attempt* in 3D next to the teacher, measured. Ghost Coach closes that loop. It is built from parts that are
already mine (Watch me try, retargeting, foot lock, hand poses, avatars, "you, perfected"), so it is clearly mine and
barely overlaps Ojasva or Ian. The first milestone ships something on its own (the Remix fallback below).

---

## 1. Questions I skipped

None of them would have changed the direction, so I went ahead. Two facts I couldn't check from the repo decide
*how* this gets built, and they go to Ojasva first (section 9): does a `vishal` avatar bundle exist yet, and can
4DAnyone's bundled GVHMR run on its own on a short clip?

## 2. Ideas (diverge)

| # | Idea (one sentence) | Combines | Frontier hook (public < 12 months) | Demo moment |
| --- | --- | --- | --- | --- |
| 1 | **Ghost Coach**: film your try. Minutes later your own body, doing exactly what you did, stands overlaid on the teacher's 4D replay. The joints where you differ glow, Gemini names the two biggest fixes, and "Show me right" plays your body doing it correctly | Watch me try, GVHMR (in 4DAnyone), retarget, foot lock, your avatar (DiGS / LHM++), teacher's 4DAnyone replay + GVHMR, Gemini | Teacher reconstructed in 4D from one internet video (4DAnyone, Aug 2026); learner as a photoreal LHM++ / DiGS avatar (Mar / Jun 2026); Gemini's video notes grounded in a 3D measurement | Your translucent self inside LeBron, right elbow glowing red at 0.8 s; tap, and you shoot it his way |
| 2 | **Replay-to-Rig**: use a person's 4D replay (35 dB against real frames) as the *teacher* for their rigged avatar, so the avatar reaches replay fidelity and can still do any move | 4D replay, digs_finetune / head-distill fit loop, foot lock | Extends our research claim: one video, then 4DAnyone, then a 4D replay distilled into a rig | Replay and avatar side by side, indistinguishable, then the avatar does a different move |
| 3 | **LHM++ on 4DAnyone's views**: feed 16 of one frame's 48 generated views as LHM++'s "photo set", so a single clip gives a 360-degree-informed avatar in minutes | 4DAnyone views, `lhmpp-avatar.sbatch`, blink, realism metrics | LHM++ (Mar 2026) fed by 4DAnyone (Aug 2026): neither paper does this | A table on the slide: one photo vs views vs real frames |
| 4 | **Remix**: any person in the library x any move in the library, made instantly on the Mac (numpy retarget + foot lock; players skin live, so no GPU) | Avatars, every replay's GVHMR motion, retarget, foot lock, `motionFrom` (Raami proposed it) | Rides on 4DAnyone motion + LHM++ / DiGS bodies | Drag your card onto LeBron's card: you're shooting his jumper beside him seconds later |
| 5 | **One home video becomes her**: body (LHM++ from frames), face (UIKA distill), her own words moving her lips (A2E), blinks, sitting beside you | `video_frames`, `lhmpp-avatar`, `uika-head`, `head-distill`, `blink`, `lips` | LHM++, UIKA (CVPR 2026) | Grandma beside you on the sofa, her own voice, her own mouth moving |
| 6 | **Gemini choreographer**: an intent with no clip ("dance with me", "show me tai chi") is stitched from motion segments already in the library and played by any avatar | Gemini plan, library GVHMR motions, retarget, idle blending | Gemini picks and orders 4DAnyone-derived motion | "Grandma, do the tai chi form": she does, from a stranger's clip |
| 7 | **Talk with them**: Gemini Live answers in a consenting person's cloned voice, lips driven live | Gemini Live, A2E lips, voice | Live A2E + Gemini Live | A conversation with an avatar. **Rejected**: an AI speaking *as* a real person breaks the spirit of rules 5 and 6 (tips are "never the person's" voice) |
| 8 | **Step inside them**: you stand inside the teacher, see their hands where yours are, and a live score tracks your hands against theirs | Replay / avatar, Quest hand tracking, hand poses | Weak (players + hand tracking are not new) | Look down, LeBron's hands are on yours |
| 9 | **Mirror me**: your photoreal avatar copies your head and hands live (3-point IK) | Avatar, IK, WebXR / Quest tracking | Weak | You wave, and you-across-the-room waves |
| 10 | **Identity map**: a heat overlay of how much of a face is really the person (identity + seen fraction per region) | realism.py, seenFraction, Gemini realism check | Weak | "82% her; the ear is imagined" |
| 11 | **Smooth slow-mo**: interpolate Gaussians between warm-started replay frames so 0.25x lessons don't stutter | Replay frames | Weak | 0.25x looks like 100 fps |

## 3. Scores (1-5; for GPU safety and overlap, 5 = safe / none)

Overlap was checked against the Status log through Sat 4:01 AM.

| # | Wow live | Fits the one line | Frontier | 24 h feasible | GPU-fail safety | Low overlap | Prizes it helps | Total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 Ghost Coach | 5 | 5 | 3 | 3 | 4 | 5 | Overall, AI Hack, Social Impact, Gemini, Design | **25** |
| 4 Remix | 4 | 4 | 2 | 5 | 5 | 4 | Overall, Design | 24 |
| 2 Replay-to-Rig | 3 | 4 | 5 | 4 | 3 | 3 | AI Hack, Overall (tech) | 22 |
| 6 Gemini choreographer | 3 | 4 | 3 | 3 | 5 | 4 | Gemini | 22 |
| 3 LHM++ on views | 2 | 4 | 4 | 5 | 3 | 2 | AI Hack | 20 |
| 5 Home video becomes her | 5 | 5 | 4 | 2 | 1 | 2 | Social Impact | 19 |
| 8 Step inside them | 5 | 4 | 2 | 2 | 5 | 1 | Design | 19 |
| 7 Talk with them | 4 | 3 | 4 | 2 | 3 | 4 | (rejected on consent) | n/a |
| 10 Identity map | 2 | 3 | 2 | 4 | 3 | 2 | | 16 |
| 9 Mirror me | 3 | 2 | 1 | 3 | 5 | 1 | | 15 |
| 11 Smooth slow-mo | 2 | 3 | 2 | 3 | 4 | 1 | | 15 |

Overlap notes: Watch me try, `/live`, retarget, foot lock, hand poses and digs-perform are already yours (#1, #4).
LHM++ runs are Ojasva's agent's (#3). The family moment is Ian's and already your brief's item 1 (#5). Players and
two-people-at-once are Ian's and Ojasva's (#8, #9, #11). The Realism panel and Reality check are Raami's (now yours)
and Ojasva's (#10).

## 4. Push-back and the pick

**The tempting pick is #5 (one home video becomes her), and it's the wrong "feature".** It is the most moving
moment, but it is Ian's moment and his family's consent. It chains five GPU stages that have **never run on the
cluster** (UIKA env + 4.6 GB weights, head-distill, blink on real FLAME, lips through the FBX route, LHM++ on her
frames), so one failure kills it. It is also already your brief's top item, so it should *run anyway* rather than
be your headline. Keep pushing those jobs through Ojasva in parallel; Ghost Coach needs one tiny L4 job and won't
compete with them.

**#2 (Replay-to-Rig) is the best research but a weak live moment.** Judges can't see "+N dB" in a headset. It
is the right next row in your results table if a GPU slot is free, not the demo moment.

**My own pick has a weak spot, and here's the honest version.** Ghost Coach's motion capture is GVHMR (2024), not
new. Its frontier credit is the stack it stands on: a 4DAnyone teacher (Aug 2026), an LHM++ / DiGS learner (2026),
and Gemini. The new thing we can claim and *measure* is a coach whose words are tied to a 3D measurement
(section 7, number B). Say exactly that to judges; don't claim GVHMR as new.

**Recommendation: #1 Ghost Coach. Runner-up / fallback: #4 Remix**, which is literally Ghost Coach's first
milestone. If the attempt-motion job isn't working by **Sat 5 PM**, ship Remix as the feature (it needs no GPU) and
keep Ghost Coach as pre-recorded tries.

---

## 5. Build plan: Ghost Coach

### User story

"I'm in LeBron's jump-shot lesson. After his steps, I set my phone on the table, press **Try it**, and shoot. About
two minutes later my own body, translucent and doing exactly what I did, stands inside his, synced to his clock. My
right arm glows red at the set point. The card says *'Your elbow opens 28 degrees wider than his at the set point
(0.8 s)'* and *'You release 0.2 s early'*. I tap **Show me right** and my body shoots it his way. I try again and the
score goes from 61 to 78."

### The 30-second demo moment

1. (0-8 s) LeBron's replay in passthrough, teach mode, step 3 "Set point" at 0.5x.
2. (8-15 s) Cut to the laptop: Vishal's earlier try (pre-recorded, honest label "recorded at 9:12") becomes a
   ghost. The web app's 3D view orbits it overlaid on LeBron, the right arm glows, and the two notes come up.
3. (15-22 s) Back in the headset: the same ghost stands inside LeBron; scrub to 0.8 s and the elbow gap is visible
   from the side.
4. (22-30 s) **Show me right**: the ghost becomes Vishal's photoreal avatar doing LeBron's motion, feet planted.
   The score chip reads try 1: 61, try 3: 78.

A live try during finals is a bonus. It runs only if an L4 is reserved (section 9).

### How it fits the contracts (all additive; one Status-log line before the first push)

- **No change to `POST /api/jobs`.** The attempt goes through the existing `POST /api/dreams/:id/feedback`
  (Watch me try), which gains a second, slower result.
- **experience.json `feedback`** (already additive, yours) gains:
  - `ghost`: the ghost dream's id
  - `perfected`: the dream id of the learner doing the teacher's motion
  - `measured`: an overall score 0-100; per-step scores; the top deviations, each with a body part, teacher
    time, attempt time, degrees, and a plain-words direction; the noise floor used
  - `tries`: earlier scores, so the chip can show progress
- **A new avatar dream per try**, e.g. `<teacher>-try-<n>`: a normal avatar bundle (kind `avatar`, skinned by every
  player today). Its `dream.json` gains optional `"ghostOf": "<teacher id>"` and `"ghost": "ghost.json"`. ghost.json
  holds, per frame and per body part (6 parts), the error from 0 to 1, so a player can tint each Gaussian by its
  dominant skin joint's part.
- **Coordinates:** the ghost is authored in the teacher bundle's frame (meters, floor y = 0, front -Z), so a player
  that puts it under the same root as the teacher gets the overlay for free.
- **Private and held:** never for a `"private": true` dream, an `ian-grandma*` id or a held dream, and never with
  someone else's avatar. The learner avatar must be on the consented list and belong to the person who pressed
  Try. Same gates as head swap and Watch me try.
- **Who to tell:** Ojasva (ghost overlay in WebXR, the job, `ghostOf`), Ian (the Quest overlay, the demo script),
  and everyone through one line in the Status log.

### The pipeline, step by step

| Step | Input | Model / tool | Output | Runs on | Who triggers |
| --- | --- | --- | --- | --- | --- |
| 1 Record | Teacher dream with a `teach` plan | Watch me try (exists): MediaRecorder, no mic | Attempt MP4, metadata stripped | Browser, then bridge Mac | The learner |
| 2 Keep briefly | Attempt MP4 | Bridge | Held in the bridge's private data folder **only until step 3 returns**, then deleted (today it's deleted right after Gemini) | Bridge Mac | Bridge |
| 3 Attempt motion | Attempt MP4 | GVHMR, the copy bundled in 4DAnyone (with its YOLO + ViTPose); my `gvhmr.py` turns it into our Motion | `attempt.motion.json` (KB), world-grounded SMPL-X at 25 fps | HiPerGator, one L4, target under 5 min | Bridge via `lucid_runner.py`'s existing remote + rsync, **with Ojasva's OK** (he owns submission); pre-recorded tries submitted by Ojasva |
| 4 Teacher motion | Teacher run | Already on disk: `runs/<id>/views/gvhmr/` | Teacher Motion in the bundle frame (export's `placement`) | Fetched once to the Mac (KB) | Ojasva fetch, once per teacher |
| 5 Align in time | Both motions + the plan's steps | New numpy module in `lucid_avatars` (call it `compare`): features = local rotations of 15 major joints + root height and speed; dynamic time warping, step by step | Warp map (attempt time to teacher time) | Bridge Mac, seconds | Bridge |
| 6 Measure | Aligned motions | Same module: geodesic angle error per joint, grouped into 6 parts (head and neck, trunk, left / right arm, left / right leg); noise floor from GVHMR jitter; deviations reported only above 2x the floor; mirrored compare for a left-handed learner (keep the lower error and say "mirrored") | `measured` + ghost.json | Bridge Mac | Bridge |
| 7 Ghost bundle | Learner avatar + attempt motion warped to the teacher's clock | `retarget.py`, `foot_contact.py`, bundle writer, all existing | `<teacher>-try-<n>` avatar bundle in the teacher's frame | Bridge Mac, seconds | Bridge |
| 8 Perfected bundle | Learner avatar + teacher motion | Same, = "you, perfected" without the GPU, because players skin live (digs-perform's GPU render isn't needed) | `<learner>-<teacher>` avatar bundle | Bridge Mac, seconds | Bridge |
| 9 Words | Attempt clip window + teacher window + `measured` | Gemini (existing Watch me try call); the prompt now gets the measured deviations as ground truth: explain these, cite their times, add nothing it can't see | `feedback.notes` tied to deviations | Bridge to Gemini | Bridge |
| 10 Show | The above | **Web app (mine):** a "Your try in 3D" panel on the dream page, Spark 2.4 (already in apps/site), teacher replay + ghost overlaid, orbit, scrub synced, parts tinted by ghost.json, deviation chips jump to their time, Show me right swaps ghost and perfected. **WebXR / Quest:** load `feedback.ghost` as a second person at zero offset, 50% opacity (Ian's "Bring in another" already places one 1.5 m beside) | What judges see | Browser, headset | Ojasva / Ian for the headset |

Without a learner avatar, step 7 uses a **neutral ghost**: a plain Gaussian body sampled on the SMPL-X surface with
SMPL-X's own skin weights, made in numpy on the Mac, no GPU. A translucent neutral body is arguably clearer for
corrections anyway. "Show me right" then needs the real avatar.

### Milestones (start Sat 6 AM; freeze Sun 10 AM)

| When | Build | Minimum shippable at this point |
| --- | --- | --- |
| **Sat 6-7 AM** (1 h) | Send the asks in section 9. Film 3 test tries of yourself on the phone: a clean shot, one with the elbow flared, one that releases early (portrait, whole body, tripod; same rules as clips). List which teachers have GVHMR motion (jump-shot, lebron-jumper(-hq), golf-01, dance-01, taichi-01, guitar-01) and get Ojasva to fetch their motions | Test data and answers |
| **Sat 7-11 AM** (4 h) | **Remix core, no GPU:** teacher motion onto the learner avatar (retarget + foot lock) gives the perfected bundle. The compare module with tests written first. Synthetic checks: the teacher vs itself gives 0. A time-stretched copy gives about 0 after the warp. A copy with the right elbow pushed 30 degrees gives the right arm as the top deviation at the right time, about 30 degrees. A mirrored copy is caught by the mirror compare. Bridge: `motionFrom` on avatar jobs makes a Remix on the Mac | **Fallback feature ships here: Remix** ("you, perfected" instantly, any avatar x any move), with a Status-log line |
| **Sat 11 AM-3 PM** (4 h) | **Attempt motion job:** an sbatch that runs 4DAnyone's GVHMR on one clip and writes `attempt.motion.json` (same env, no new install). Ojasva runs it on the 3 test tries. Measure the noise floor (clean try vs a second clean take) and check the flared elbow and early release come out on top | Ghost bundles + `measured` for pre-recorded tries, viewable in any player as a second person |
| **Sat 3-9 PM** (6 h) | **Web app panel** (Spark overlay, part tint, chips, Show me right, try history). Wire the bridge: Try it, then the job, polling, compare, ghost, grounded Gemini. Lighthouse and phone width checks as for every other page. **Sat 5 PM go / no-go:** no working attempt job means Remix is the headline | Live loop on the laptop with pre-recorded tries; live tries if the job runs |
| **Sat 9 PM-1 AM** (4 h) | **Headset + numbers:** the contract line; Ojasva / Ian load `feedback.ghost` overlaid (or beside, which exists). Measure the slide numbers (section 7) on 3+ tries and 10 notes. Help Ian film the 30 s moment in passthrough | Demo moment filmed |
| Sat 1-7 AM | Sleep (protect it; the freeze-morning bugs are the expensive ones) | |
| **Sun 7-10 AM** (3 h) | Polish only: labels ("recorded at 9:12", "mirrored", "GVHMR estimate"), empty and error states, the README section, one slide. **Freeze at 10 AM** | Frozen |

### What to measure for the slide (before / after)

- **A. Learning number:** overall score and the top part's error, try 1 vs try 3 after following the notes (e.g.
  "right elbow 28 degrees to 9 degrees"). Report n honestly (it's one learner, three tries).
- **B. Grounding number (the claim that's new):** on 10 tries, how often each Gemini note points at a body part
  and time the 3D measurement also flags, comparing Gemini-only notes (today's Watch me try) with grounded notes.
  For example, "notes that match a measured error: 4 of 10 to 9 of 10".
- **C. Speed:** seconds from Stop to a ghost in the room (job queue wait shown separately from compute).
- **D. Sanity:** noise floor in degrees (two clean takes), and that synthetic injected errors come back at the
  right joint, time and size. Put it in the README, not the slide.

### Risks and the graceful fallback for each

| Risk | Fallback |
| --- | --- |
| 4DAnyone's GVHMR won't run on its own on a clip, or needs pieces only the views stage builds | Ask Ojasva at 6 AM; if it's not working by Sat 5 PM, **Remix becomes the feature** and Ghost Coach is shown only on tries Ojasva processed by any route |
| GPU queue full at finals | Pre-recorded tries already processed; a live try shows today's 2D Watch me try notes while the earlier ghost plays |
| No `vishal` avatar | Neutral ghost (numpy, no GPU) for the overlay; Show me right falls back to the teacher alone. Ask Ojasva for `digs-sample ID=vishal` or LHM++ from your photos early |
| GVHMR jitter swamps the differences | Smooth in rotation space, compare 6 parts not 55 joints, report only deviations above 2x the measured noise floor, say "about" in the UI |
| Learner filmed from a different side, or left-handed | World-grounded motion removes the camera; heading aligned at frame 0; mirrored compare picks the better match and says so |
| No Gemini key on the bridge | Notes written from `measured` alone (a plain template: part, direction, degrees, time); the panel says "measured notes" |
| Players can't overlay in time | The web app's Spark view is the overlay surface; the headset uses Ian's existing "Bring in another" (beside, not inside) |
| Attempt video privacy | Deleted from the Mac as soon as step 3 returns and from Gemini after its answer; only the motion (joint angles, no pixels) and notes stay; refused for private, held or `ian-grandma*` dreams; your own avatar only |
| Starving the grandma / head-distill runs | One L4 job of a few minutes per try; tell Ojasva it always yields to her runs |

### What to ask Ojasva and Ian

**Ojasva (send at 6 AM, in this order):**
1. Does a `vishal` avatar bundle exist? If not, please run `digs-sample ID=vishal`, or LHM++ from my photos, today.
2. 15 minutes: can 4DAnyone's bundled GVHMR run on its own on a short clip in the 4DAnyone env (entry point,
   checkpoints)? I'll write the sbatch; you submit the 3 test tries by about 1 PM.
3. OK for the bridge (runner mode) to submit this one small L4 job by itself when someone presses Try it, and one L4
   kept free during the finals demo window.
4. Fetch the teachers' `views/gvhmr/` motions (KB each) to the Mac.
5. WebXR: show `feedback.ghost` under the teacher's root at 50% opacity with the per-part tint (I can write it in
   `apps/webxr` with your OK, as Raami did for the coach).

**Ian:** load `feedback.ghost` at zero offset (your two-people code, the same root), plus the tint if there's time.
Put the 30-second moment into the rehearsed demo and the video script after the LeBron lesson.

### Pitch for judges (one paragraph)

Lucid Dreams already puts a teacher from any video in your room. Ghost Coach finishes the lesson. Film your try on
a phone, and minutes later your own body, doing exactly what you did, stands inside the teacher's, synced to their
clock. The joints where you differ glow, a coach tells you the two biggest fixes, and one tap shows your body doing
it right. The teacher is a 4D reconstruction from one internet video (4DAnyone, August 2026), you are a photoreal
avatar (LHM++ and DiGS-Avatar, 2026), and the coach's words are tied to a 3D measurement instead of a guess. In our
tests that raised the share of notes that matched a real error from X to Y. The hard parts were putting two
single-camera motions, from different people, bodies and camera angles, into one real-size frame with the feet
planted, aligning them in time step by step, and telling real mistakes from tracking jitter.
