# Ian: the Quest app

You own what people actually see: photoreal people standing on the real floor in Meta Quest 3S passthrough,
moving smoothly at full frame rate. Read `AGENTS.md` first.


## NOW (Sat 10:50 PM): three laptop jobs (no headset), in order

1. **Protect Talk on the public link.** The relay in `apps/webxr/vite.config.ts` adds the Talk token for anyone who
   opens https://getluciddreams.vercel.app/xr/?dream=vishal, and `apps/talk/server.mjs` has no limits, so anyone with
   the link (judges, the Devpost page, a bot) can keep spending our OpenAI and ElevenLabs credits.
   - In the Talk server: a per-visitor limit (say 20 turns an hour, keyed on the visitor's address; ask Ojasva to have
     the relay pass `x-forwarded-for`), a daily cap for everyone, a cap on recording length (about 20 s), and a log
     line per turn.
   - In the viewer (`apps/webxr/src/talk.ts`): when a limit hits, the caption says so plainly ("Talk is resting, try
     again in a few minutes") and nothing hangs.
   - Test it from the laptop viewer (Talk works there without a headset). Push it and add one Status log line.
2. **Talk's replies from Gemma.** The MLH prize here is **Best Use of Gemma** (Google's open model), not Gemini.
   Today `gpt-4o-mini` writes the replies, so have Gemma write them for Vishal and your grandma, with the same rules:
   short, in their own words, never invents memories, labelled AI voice, her Vietnamese with the English line. Use
   Atina's key and the newest `gemma-...-it` the Gemini API lists (or Gemma on the Mac through Ollama, which keeps a
   family's words on the machine). Keep Whisper and ElevenLabs, and fall back to `gpt-4o-mini` if Gemma fails or runs
   slow. Measure the round trip over 10 tries each (today's median is 3.1 s: heard 1.5, reply 1.0, spoken 0.5) and
   put the numbers in the Status log. Keys stay in `apps/talk/.env`, never in git.
3. **The public README** (MLH Best Open Source reads it) is from Saturday 1 AM: DiGS-era, Raami's app, the retired
   site. Rewrite it from what's true now (AGENTS.md Status log; numbers from the SUBMISSION table below):
   - one line of what it is and the one link (website, `/xr/` for the headset)
   - what you can do: learn, play, talk, moments
   - how it works: the replay pipeline and the avatar chain (LHM++, UIKA)
   - the measured table, honesty and consent, how to run each app, the repo map (apps/site is gone), credits, team
   Add 3 or 4 real stills from the laptop viewer at the top. Short and plain.

## IAN (Sat 5:05 PM): grandma is public, with the family's yes

My family agreed to her being shown and heard: in the library, on the home page's Talk with them, in the showcase,
on the headset through the tunnel, and in the launch video. Her `dream.json` says `"private": false` (Ojasva's
Sat 4:46 PM entry). Still true: her replies are labelled AI voice and never invent memories, her clip and photos never
go to Gemini, and nothing of hers goes in git.

## FROM OJASVA (Sat 7:20 AM): your Quest kit is staged on my Mac

- Your app (LucidDreams.apk), grandma's replay (fetched, kept in dreams/.held) and the Talk server (your .env and
  persona.md in apps/talk, git-ignored, `node apps/talk/server.mjs` running) are set up. Campus Wi-Fi blocks the Quest
  from my Mac, so Talk and the bridge are reached through Cloudflare tunnels; the Quest setup (install the APK, push
  grandma, write talk.txt with the token and bridge.txt) runs by itself the moment I plug the headset in.
- **Privacy fix, heads-up:** through a tunnel the bridge served grandma's files to anyone with the address. Now the
  bridge and the WebXR server never serve a private dream over HTTP (files and index; any ian-grandma* id or
  `"private": true`). The headset gets her over USB only (`adb push`, as your handoff says). If the Quest app ever
  fetched private dreams from the bridge, that path is gone on purpose.
- I'll run your checklist on the headset and send back the Talk round trip, the frame rate with grandma, and logs.

## SUBMISSION (Sat 5:50 AM): the write-up is a night behind; bring it up to date (yours since Atina's hand-off)

`demo/devpost.md` is from Fri 11:21 PM: its metrics table says "[pending]" and it predates most of what we'll demo.
By **Sun 10 AM** (feature freeze, filming), update `demo/devpost.md`, `README.md`, `demo/video.md` and
`demo/judges.md` with what is true now. Measured numbers, redone Sat 12:15 PM after the ghost-limb fix: the five
replays with a solved real camera were re-reconstructed with `lucid.recon --source-agree` (the doubled shoes, second
legs and half-transparent torsos are gone from every side) and swapped into the library. Old -> new, measured like this:
- **Views PSNR / SSIM**: our render against 4DAnyone's generated views, every 8th of the 48 cameras, median over the
  bundle's frames (`recon/` and `recon-agree/recon-*.json`). **The fit trained on these views; none is held out**
  (every run reports `heldOut: false`), so don't call them held-out (this table's earlier label was wrong).
- **Spill**: share of our render's opacity that lands outside the person in the generated views, i.e. ghosts and
  floaters (`lucid.clean_check`, every 4th frame x every 3rd camera). Lower is cleaner.
- **Real frame PSNR**: our render against the real clip frame, median over the frames whose chunk solved a camera.
  Old: from that solved camera, which the fit trained against. New: from the camera re-aligned to the views' person each
  frame, **lower by design**: the person now follows the generated views (a few cm off the real one) so they're whole
  from every side, never doubled. Through the original solved camera (`clean_check`) the jump shot goes 27.6 -> 14.6 dB.
- LeBron is over his 100 frames (the bundle is trimmed). Guitar never solved a real camera and wasn't redone.

| Dream | Views PSNR | Views SSIM | Spill in the views | Real frame PSNR | Seen by the camera |
| --- | --- | --- | --- | --- | --- |
| Tai chi (`taichi-01`) | 27.5 -> 29.6 dB | 0.965 -> 0.973 | 0.007 -> 0.003 | 46.6 -> 24.8 dB | 57% -> 54% |
| LeBron (`lebron-shot`, the one in the library, with his release) | 25.4 -> 26.0 dB | 0.968 -> 0.971 | 0.043 -> 0.033 | 43.3 -> 17.7 dB (66 of 100 frames) | 43% -> 43% |
| Dance (`dance-01`) | 30.3 -> 31.9 dB | 0.978 -> 0.982 | 0.011 -> 0.002 | 40.3 -> 23.9 dB | 53% -> 49% |
| Jump shot (`jump-shot-hq`) | 24.7 -> 26.7 dB | 0.960 -> 0.967 | 0.023 -> 0.004 | 35.1 -> 17.9 dB | 54% -> 48% |
| Golf (`golf-01`) | 25.8 -> 26.3 dB | 0.960 -> 0.963 | 0.016 -> 0.004 | 33.0 -> 20.2 dB (55 of 121 frames) | 49% -> 47% |
| Guitar (`guitar-01`, not redone) | 22.0 dB | 0.96 | not measured | (not solved) | 59% |

What's new since your draft, all in the library or on main:
- **Chess against the legends**: Bobby Fischer and Magnus Carlsen sit at the board as photoreal LHM++ avatars
  (many freely licensed photos each; Fischer's black-and-white photos colourised with DDColor), labelled "Stockfish
  at X's peak rating. Not affiliated.", silent; they open with their real repertoires, think, reach, press their
  clock. Credits: LHM++ (code Apache-2.0, weights CC BY-NC 4.0), DDColor, the photographers in `demo/credits.md`.
- **Hands only, locked down**: palm-up menu, everything pinned with anchors, no gesture acts on its own; chess pieces
  by pinch with a ring and a lit landing square; captures go into your hand and you hit the clock with them.
- **Golf**: a real 7-iron in your hands and a ball on a tee you can hit. **Basketball**: a ball you can shoot at the
  regulation hoop (landing now). The real ball moves in LeBron's and the jump shots' hands (tracked in 3D).
- **Five new full-quality people** (dance, golf, tai chi, guitar, LeBron) at 50-step 4DAnyone views.
New since 5:50 AM (Sat 8:35 AM), also on main:
- **The library is one of each**: LeBron (`lebron-shot`), Jump shot (`jump-shot-hq`), dance, golf, tai chi, guitar,
  Magnus, Bobby. Jump shot 2, the old LeBron and the older legend bodies are held.
- **Follow along** in every lesson: `joints.json` (the clip's 22 body joints, checked against the reconstruction)
  puts glowing targets where your head and wrists should be, mirrored when they face you; a match score on the step
  card and a chime when you hold the pose on your turn.
- **Basketball you can really play**: hold the ball naturally (one or two hands), dribble while walking, shoot with
  the release at the peak of your push (a natural shot usually goes in), pass to LeBron and he catches, shoots with
  his real release and passes back. The real ball in the jump shot is now tracked as one ball (it used to jump
  between his shins and his face).
- **Guitar**: steady at your waist, the left hand along the neck picks the lesson's chord, a strum is the right hand
  through a generous box. **Mirror** for dance and tai chi.
- **The legends' faces**: Bobby Fischer now has a UIKA head (likeness to his photos 0.34 -> 0.53, face sharpness
  10.6 -> 70.7); Magnus sits on his all-round LHM++ body with a UIKA head (0.68 front). An all-angle cleanup of both
  (hands, jacket, collar, hair, floaters, nothing passing through the pieces) is running now.
- **Coming, not in the library yet**: tennis against Roger Federer (`?mode=tennis`: serves, every stroke, full
  scoring), held until his likeness is right; a replay cleanup pass (floaters, ghost limbs) measured against the real
  frames.
- **Sharper and faster on the headset**: full resolution, no foveation; worlds start once a quarter of their frames
  is in.
- Yours: **Talk with them** (grandma, family consent, AI voice labelled).
Rules for the text: numbers only from the table above (or newer logs), "not yet measured on a Quest" where true, no
claims of real-time fps we haven't measured. Ojasva reviews by Sun 10 AM.

## TOP NOW (Sat 5:10 AM): lock the hands down (Ojasva tried it in the headset)

Ojasva played on a Quest 3S with hands only. His words: things "keep randomly moving", the UI "isn't super
intuitive", and "a person will do a lot with their hands so we need it to be locked". Copying a dance, a tai chi
form or a golf swing pinches by accident all the time, so **no gesture may change anything on its own**. The
WebXR viewer is being changed the same way right now (`apps/webxr/src/xr/menu.ts`, `xr/anchor.ts`; chess is done
in `chess/game.ts`); match it in the Quest app, in this order:

1. **Remove every gesture shortcut** from playback: quick pinch = pause, held pinch = re-place / bring here, the
   pinch-drag on the person, two-hand turn, long pinch re-place. In a lesson your hands are busy copying them.
2. **Palm-up menu replaces the floating rail.** Turn your left palm toward your face (palm normal vs the direction
   to your eyes > 0.6, held ~0.2 s; closes after ~0.45 s below 0.35) and the buttons appear just above the palm,
   turned to your eyes; only the right index fingertip presses them (hover highlight when it's within 4 cm in
   front). Same buttons as the rail (Play/Pause, speed or Back/Again/Next, Reality check, Bring here, Library).
   Nothing floats in front of your chest where a swing or a dance move goes. The step card stays (eye level,
   to the right, out of reach).
3. **Pin the person to the room**: an `OVRSpatialAnchor` (or OpenXR spatial anchor) where they're placed, re-read
   every frame, so a recenter or tracking drift never slides them. Re-anchor after Bring here.
4. **Pinches that do hold things**: they last through ~70 ms of finger jitter and ~300 ms of lost tracking, take
   hold only as the pinch starts (a held pinch never picks up what it passes over), and whatever is held stops
   following once the fingers start opening (it lands where you let go).
5. **Golf**: the WebXR viewer gives you a real 7-iron in your hands (two-hand grip from the joints, ball on a
   tee you can hit) when the dream is golf (`golf-01` is in the library). Copy `apps/webxr/src/club.ts` once it
   lands (sizes, grip maths, hit physics).

Then check on the real headset with your own hands, and log what you measured.


## IAN'S UPDATE (Sat 5:16 AM): where things stand, and what's next

**Done and pushed:** eye contact in the Quest app and WebXR (companion / play turn their head toward you);
passthrough only (Place button, places and panoramas gone, APK 45 MB). HandsCheck and HeadLookCheck pass.

**Grandma (moment 4), decided: the replay is her demo version.** `ian-grandma`, from the frontal home video:
121 frames, 1.69 m, views PSNR 28.5 dB / SSIM 0.98 (trained on, not held out), 58% seen; her own voice. Public since
Sat 4:46 PM with the family's yes to showing her and hearing her; never in git. Every avatar route was
tried and is held, not used, because none of the faces read as her yet:
- `ian-grandma-avatar-head`: DiGS body + LAM head. Colours fixed by Vishal's tone fix; still wide and messy at 3/4.
- `ian-grandma-lhm` / `ian-grandma-lhm2`: LHM++ from 16 photos, then 16 frames with no glasses (identity 0.36
  front, 0.42 at 45°). Holds together from every side, but the face is smooth and generic, and she comes out
  1.77 m tall (the replay measures 1.69 m).
- `ian-grandma-lhm2-head`: LAM's face on the LHM++ body. LAM's own render looks like her; after the swap the face
  is wider with rounder eyes, the same as on DiGS, so the loss is in the swap step (reported to Vishal).
- Still broken for everyone: blinks. `avatars/hpg/flame.sh` calls `huggingface-cli`, which no longer works on
  HiPerGator (`hf download` does).

**Now:** the hands lockdown above, steps 1 to 4 in order.

**Next, mine: talk with grandma.** You speak, she answers in her own voice from where she stands, with captions.
Her replies are written by Gemini and always labelled as AI, not her; her voice is a clone from recordings of her,
with the family's yes to both. The replay can't move its lips, so the voice comes from her position. Needs: a
minute or more of clean recordings of her speaking (I'm collecting voice messages), speech-to-text for the
language we talk in, Gemini on the bridge (Vishal's area now) and a GPU for the voice model (Ojasva). I'll post
the plan and any bundle field in the Status log before touching shared parts.


## NOW (Sat 4:20 AM): what changed, and what's yours

1. **Your grandma: use LHM++.** It builds one person from many photos at once and beat the one-photo route by far
   (Magnus's identity score 0.55 vs 0.23). Put 8-16 photos from one period in
   `$L/data/avatars/photos/ian-grandma/` (optional `crops.json` to cut other people out), then
   `sbatch --export=ALL,NAME=ian-grandma,TITLE="Grandma" avatars/hpg/lhmpp-avatar.sbatch` and
   `avatars/lhmpp_cleanup.py` on the bundle. Your existing `ian-grandma-avatar(-head)` bundles stay held. A home
   video is still the most real (a replay).
2. **The ball:** LeBron's full-quality export now finds the real ball in the reconstruction itself
   (`props.json` basketball, `"source": "reconstruction"`). Check that your props player shows it in his hands and
   in flight.
3. **Passthrough only** (from 3:30 AM), unchanged: no 360 places.

Chess (the legends, the clock, their animation) is not yours: Ojasva and his agents own it.

## DECIDED (Sat 3:30 AM): passthrough only, no 360 places

Ojasva watched the full-quality jump shot on the court place and called it: "the backgrounds are cooked; we only
keep the passthrough." Your own room reads as more real than any panorama.
- **Quest app:** remove the Place button from the rail and ignore `experience.environment`. The person is always
  in your real room.
- **WebXR:** done (`PLACES = false` in viewer.ts).
- **Unity:** drop the place textures from the APK (‑23 MB) when convenient.

Next: the real basketball renders as its own object (the tracked ball, `props.json`) for Jump shot 2, LeBron and
every later shooting clip; check that your props player shows it in the hands and in flight.

## UPDATE (Sat 2:35 AM): bring MANY photos of your grandma

1. **More photos beat one.** We're testing LHM++, which builds one 3D person from many photos at once (every angle
   comes from a real photo, not a guess). For your grandma, gather **as many photos as you can from one period**
   (same hair and age): the face from the front, 3/4 and side, at least one head-to-toe, sharp and well lit. Ten
   or more is great. Put them in `$L/data/avatars/faces/ian-grandma/` (or AirDrop them to Ojasva). A home video of
   her is still the best of all (a replay is her real footage).
2. **The bridge is up again** on Ojasva's Mac (:5170, runner mode); your Quest library should list the dreams now.

## FIRST NOW (Sat 2:20 AM): your grandma, the family moment

**Cleared (Sat 2:45 AM):** Ojasva confirmed your family's consent. `ian-grandma`, `ian-grandma-avatar` and
`ian-grandma-avatar-head` are in `dreams/.held` on his Mac, and `ian-grandma` is in `CONSENTED` in `head_swap.py`,
so the head swap will run for her. Submit when ready.

You're bringing your grandma into the room: demo moment 4, "Someone you've lost" (`demo/showcase.md`), and our
Best Social Impact entry. It has to be the most real and most careful thing we show. In order:

1. **Consent first, in writing.** Her yes, or the family member's who can give it if she can't. Use
   `demo/consent.md`; the record stays private (not in git). Agree two things separately: building her for us to
   see, and showing her to judges or in the video. Her voice is included only if the family says yes to that too.
   **Done:** the family said yes to all three (building her, showing her, her voice).
2. **What to bring, best first:**
   - **A home video** of her alone, whole body, camera still, 5+ seconds. It becomes a replay: her real footage, the
     most real result we can make. If she speaks in it, her own voice comes with it, separated from the room
     noise, with captions.
   - **Photos:** one close-up that is front-facing and sharp, with her face filling most of the frame (this makes
     the face; it's the difference between a person and a mannequin), plus one head-to-toe photo for the body. Two
     or three close-ups from slightly different angles help. Black-and-white is fine: it's colourised on the photo
     and labelled colourised.
3. **Where it goes.** Not through the drop folders: those name runs `ian-grandma-<date>-<time>`, and `dreams/.held`
   only matches exact ids, so she would land in the library, `/kiosk` and `/showcase`. Instead, from the repo on the
   Mac you submit from (with the shared HiPerGator connection up: `zsh pipeline/hpg/hpg-login.sh`):
   - **Hold first**, before anything is submitted: add these three ids, one per line, to `dreams/.held` on that Mac
     (and on Ojasva's, where the bridge runs): `ian-grandma`, `ian-grandma-avatar`, `ian-grandma-avatar-head`.
     Only on the Macs: the head swap refuses anyone in the `.held` beside the bundles on HiPerGator.
   - Video: `python3 pipeline/runner/lucid_runner.py submit <clip> --name "Grandma" --id ian-grandma --intent "I just want to sit with her"`
   - Photos: copy them to HiPerGator from the Mac (`H=hpg:/blue/iruchkin/vishalnaveen/lucid/data/avatars`,
     `S="ssh -o ControlPath=$HOME/.ssh/cm-hpg"`): `ssh -o ControlPath=~/.ssh/cm-hpg hpg mkdir -p /blue/iruchkin/vishalnaveen/lucid/data/avatars/{inputs,faces/ian-grandma}`
     (zsh won't split `$S` into a command, so spell it out here), then
     `rsync -e "$S" <body photo> $H/inputs/ian-grandma.jpg` and `rsync -e "$S" <close-ups>/*.jpg $H/faces/ian-grandma/`.
     Then on HiPerGator,
     `L=/blue/iruchkin/vishalnaveen/lucid; cd $L/repos/lucid_dreams/avatars/hpg` and:
     - body: `sbatch --export=ALL,IMAGE=$L/data/avatars/inputs/ian-grandma.jpg,ID=ian-grandma-avatar,NAME="Grandma" digs-sample.sbatch`
       (this, not the runner's `--kind avatar`: the head swap reads avatars from `data/avatars/dreams/`, where
       digs-sample writes them);
     - face: `sbatch --export=ALL,NAME=ian-grandma lam-head.sbatch` (an L4, about 5 min);
     - head swap, once both are done: `sbatch --export=ALL,NAME=ian-grandma,AVATAR=ian-grandma-avatar head-swap.sbatch`
       makes `ian-grandma-avatar-head`. It refuses anyone not in `CONSENTED` in `avatars/lucid_avatars/head_swap.py`:
       ask Vishal to add `ian-grandma` on your word that the family's written consent is in. Check the log for
       `HEAD_SWAP_OK` and look at its `compare.png`. Vishal's idle loop (breathing, blinks) keeps her from looking frozen.
   - These are GPU jobs: tell Ojasva before you submit (AGENTS.md: he runs the queue).
4. **Private by default:**
   - Held dreams never come home on their own (the autopilot skips them) and the bridge hides them from the Quest
     library. To see her: the replay with `python3 pipeline/runner/lucid_runner.py fetch ian-grandma`; the avatar with
     `rsync -a -e "$S" $H/dreams/ian-grandma-avatar-head dreams/`. Then
     `adb push dreams/<id> /sdcard/Android/data/com.luciddreams.quest/files/dreams/` and play her from device storage.
   - Once you say she's right: add `"private": true` to her `dream.json`, then take her ids out of `.held`. The Quest
     library then lists her, but the landing page, `/showcase`, `/kiosk` and share links still leave her out (Raami's
     Sat 2:35 AM entry). Drop `"private"` only if the family agreed to showing.
   - Never on the public site, the kiosk or `/showcase` unless the family agreed to showing. **They did (Sat 4:46
     PM):** her `dream.json` now says `"private": false`, so she shows like everyone else.
   - Never in git; HiPerGator copies are deleted after the event.
5. **The moment itself:** `companion` mode, `beside` you on a sofa or chair in your room, her voice from where she
   sits, captions, no buttons in view. Tune it in the headset until it feels quiet and right. That clip goes in the
   video.

## TOP PRIORITY (Sat 1 AM): make them read as real people in the headset

Ojasva's verdict: the people look "creepy, uncanny". Vishal is fixing faces and idle motion at the source; most of
the rest happens at render time, and that's yours. You have Ojasva's OK to edit `apps/webxr` for these as well as
the Unity app. Every item gets a before/after passthrough capture.

1. **Match the room's light.** A person brighter or bluer than your room reads as a sticker.
   - Use Meta's Passthrough Camera API (Quest 3 / 3S, Horizon OS v74+) in Unity: once a second, sample the room's
     average brightness and white point near the person, and apply a gentle gain and white balance in the splat
     shader (clamped to ±30%, eased over 1 s).
   - If the permission flow is too heavy for the demo, ship a "Light" button on the hands bar with three presets
     (warm room, daylight, dim) instead.
2. **Resolution where it counts.** Eye-buffer scale 1.3-1.5x (WebXR: `framebufferScaleFactor`), low fixed
   foveation, splats sorted every frame. Report the highest scale that holds 72 fps with `jump-shot` (121 frames)
   on the 3S.
3. **Feet that belong to the floor.** A contact shadow plus a faint ambient-occlusion ring. Then measure foot height
   across every frame of each replay and report the worst one: a floating or sliding foot is the fastest way to
   look fake.
4. **Eye contact.** For avatars in `companion` and `play` modes, the head (joint 15, with the neck, 12, taking 30%)
   turns toward the viewer's head: ±35° yaw, ±20° pitch, eased over 300 ms. In WebXR, `SkinnedAvatar.pose(t,
   edit)` in `apps/webxr/src/avatar.ts` lets you change a joint's local rotation before skinning.
5. **Blinks and breathing** once Vishal ships `expr` / `expr.bin`: apply the 10 expression offsets per head
   Gaussian on the GPU (one extra buffer, read in the splat vertex stage).

## MORE (Sat 1:20 AM): a lot more, in order, after the top items

1. **Real furniture hides them.** Use the Quest Depth API (environment depth, Quest 3 / 3S): someone walking
   behind your real couch or table is cut off by it, per pixel, with a soft edge. After the light match, this is
   the biggest single "they're really here" effect. Ship it in the Unity app; in WebXR use the `depth-sensing`
   feature if the Quest browser exposes it, else skip.
2. **72 fps with a full replay.** 121 frames x about 285k Gaussians. Do these, measuring after each:
   - distance-based LOD: past 3 m, draw a 50% subset chosen by opacity x size, precomputed per frame;
   - sort every other frame when nothing moved much;
   - SH 0 beyond 2 m;
   - a frame budget readout on the debug bar.

   Report fps and GPU ms in the Status log.
3. **They belong in the Place.** When a Place is up, tint the person by the panorama's ambient light (its first SH
   band, precomputed per Place) and cast their contact shadow on the Place's floor. No one should look pasted onto
   the court.
4. **Spatial audio that sounds like the room:** voice from the mouth with distance falloff and a short early
   reflection, plus a little reverb inside Places (more in the concert hall).
5. **The 3-minute demo, rehearsed hands-only.** Script the order (piano lesson, then a basketball lesson, chess,
   then the family moment), with no controller, no menus typed and no reload. Time it twice and write the run sheet
   in `demo/run-sheet.md`.

## TAKEN OVER FROM ATINA (Sat 12:35 AM): the submission is yours too

Atina's remaining work moves to you (she built the capture kit, captions, restoration and drafts; you already
built her headset UI). Her drafts are in `demo/`: start from them, don't redo them. Deadlines are hard: Devpost
**submitted by Sun 3 PM** (late entries aren't accepted). Do these between the Quest items below, in this order:

1. **Credits, complete** (`demo/credits.md`, then the README): every source with link and license. Jason Han's
   piano videos (Wikimedia Commons, CC BY-SA 4.0, "JMC, Han (Jason)"); Bobby Fischer (1966 AP portrait, public domain; 1972 Anefo / Nationaal
   Archief photos, CC0); Magnus Carlsen (Ralf Roletschek, 2015, CC BY-SA 3.0); LHM++ (code Apache-2.0, weights CC BY-NC 4.0); Juice WRLD (Lexiou WesCudi, CC BY-SA 2.0);
   the Pexels jump-shot clips (Pexels license); LeBron's clip (supplied for a non-commercial demo, not
   redistributed); Poly Haven places (CC0, `apps/webxr/public/places/CREDITS.md`) and chess set (CC0); every model
   and library (4DAnyone, DiGS-Avatar, gsplat, Spark, three.js, Unity Gaussian Splatting, NLF, rembg, GVHMR,
   BiRefNet, SMPL-X, DINOv3, Stockfish (GPL-3.0, separate file), Gemini, whisper.cpp, Real-ESRGAN, Demucs).
2. **Root `README.md`** (Sat 8 PM): turn `demo/README-draft.md` into the public README: one line of what it is, a
   GIF or still of a real person in a room, how it works (the five steps), the five showcase moments
   (`demo/showcase.md`), how to run each app, real numbers, credits, MIT license. MLH Open Source prize reads this.
3. **Devpost** (`demo/devpost.md`; draft by Sat noon, final Sun 1 PM): fill every blank with measured numbers from
   the Status log: held-out PSNR 26-28 dB and SSIM 0.96-0.97 on real clips, ~285k Gaussians per frame, 48 views
   per clip, 12 GPUs per person, minutes per dream, and Vishal's fine-tune table once it lands. Tracks: overall,
   Best AI Hack, Best Design, Best Social Impact, MLH Gemini, MLH Open Source (not Twinly). Say why the tech is
   recent (4DAnyone Aug 2026, DiGS-Avatar Jun 2026).
4. **The video** (3 min max, edited by Sun 1 PM): `demo/video.md` is the script. You're already capturing the
   passthrough clips (item 6 below), so you edit: the five moments ~30 s each, then how it works with the real
   numbers, then the team. Screen-record the WebXR viewer on a laptop for anything the headset can't capture.
5. **Slides** (Sat 8 PM, 6-8 slides): problem, the one sentence, the five moments, how it works, numbers, honesty
   (seen vs imagined, consent, public figures labelled), team.
6. **Judge Q&A** (`demo/judges.md`): add "Why are there public figures?" (demo only, from real footage or freely
   licensed photos, never their voice, always labelled, no endorsement implied), "What's real vs imagined?"
   (Reality check, % seen), "What runs where?" (HiPerGator for reconstruction, Mac bridge, Quest/WebXR to view).
7. **Family moment** (if a teammate's family agrees in writing): a photo or video in `~/Downloads/lucid-photos/`
   or `lucid-clips/` on Ojasva's Mac with a `.txt` "I just want to sit with her". Consent record in
   `demo/consent.md`. Skip it if there's no written yes; the demo works without it.

## BIG CHUNK (Sat 12:20 AM): real people land tonight; make the Quest app demo-ready

Avatar player, library, voice and captions, props: outstanding pace. Real bundles land in `dreams/` within the
hour: `jump-shot`, `jump-shot-2`, `lebron-jumper` (ball + hoop props), `piano-han` (seated, beside you), and
avatars `bobby-fischer`, `magnus-carlsen`, `juice-wrld`. In order:

1. **Real-bundle pass:** load each one as it lands and fix whatever breaks: scale (life size, never scaled), feet
   on the floor, facing, the hoop where `props.json` says, the seated tutor not floating. Log what you fixed.
2. **Frame rate on the Quest 3S with LeBron's real replay** (121 frames x ~285k Gaussians): report fps. If it's
   under 72, find the Gaussian count that holds 72 and tell Ojasva (he re-exports at that cap); try fixed foveation
   and a lower sort rate first.
3. **Places:** the six environments in `apps/webxr/public/places/` (CC0 equirects; ids and per-place rotation in
   `apps/webxr/src/places.ts`). Skybox swap with passthrough off, a floor at y = 0 for the contact shadow, and a
   fingertip button that cycles Your room -> places -> back. `experience.json`'s `environment` picks the start.
4. **Two people at once:** load a second dream next to the first (LeBron, and your own avatar doing his shot
   1.5 m to his left). The library gets a "Bring in another" action.
5. **Seated people:** `place: "beside"` with someone seated (piano) should put their hips at bench height, not
   their feet at the floor; read the bundle's lowest point per frame, and add a simple bench under them if the
   reconstruction has none.
6. **Demo capture:** record each showcase moment in passthrough (`demo/showcase.md`) as clean 30 s clips for
   Atina's video: the piano lesson, LeBron's lesson with the hoop, a legend at chess (WebXR, recorded on the Quest),
   Juice WRLD standing with you.
7. **Install story:** a signed APK, a one-command install (`adb install -r`), and a short "run it on the Quest"
   section in `apps/quest/README.md`.

## ADDED (Fri 11:40 PM): Places and the piano tutor

- **Places:** the WebXR viewer is getting a "Place" button that swaps your room for a 360-degree environment around
  the person (Poly Haven CC0 HDRIs in `apps/webxr/public/places/`, ids in AGENTS.md under Experience once pushed).
  In Unity it's a skybox swap with passthrough off; worth an hour after the avatar player.
- **Seated people:** the piano tutor sits at an upright. `place: "beside"` puts them 0.8 m to your right facing your
  way, so you sit next to them. Make sure your placement handles a seated person (feet on the floor, not the hips).

## ADDED (Fri 11 PM): props and seated opponents

- **Props (new contract, `props.json`, in AGENTS.md shortly):** the important objects around the person. For
  basketball: the real ball's path per frame (`kind: basketball`, radius 0.12, `track` of [x,y,z] or null per
  frame in bundle coordinates) and a regulation hoop (`kind: hoop`, rim at 3.05 m, `facing` toward the shooter).
  The WebXR viewer renders both procedurally. Do the same in Unity after the avatar player: ball sphere on the
  track (interpolate between frames), hoop at real size, both children of the person's root, so placement moves them.
- The chess legends will sit and move their own pieces in WebXR (procedural seated pose + arm IK), so chess stays
  WebXR-only; nothing for you there.

## NEXT (Fri 10:45 PM): you're ahead, here's the next big chunk

Teach mode, reality check, SPZ and hands in one evening: excellent. Real bundles start landing in `dreams/` tonight:
two Pexels jump shots and **LeBron's jump shot** (intent "teach me this jump shot"), then Buster Keaton (1920,
public domain). In order:

1. **Avatar player (GPU skinning).** Bobby Fischer, Magnus Carlsen and Vishal's avatars are queued (they start once
   Meta's DINOv3 weights arrive). Pose `avatar/avatar.ply` from `skin.bin` + `skeleton.json` + `motion.json` exactly as
   `apps/webxr/src/avatar.ts` does (identity rest per bone, the full skinning transform per bone per frame,
   dual-quaternion blend, slerp between motion frames). Test data now: `dreams/test-avatar/` on Ojasva's Mac (a waving
   SMPL-X body; derived from the licensed SMPL-X model, so AirDrop it, never commit it).
2. **Their voice and words:** `voice.m4a` (fall back to `audio.m4a`) as a spatial source at mouth height
   (`bounds.max.y - 0.13`, 8 cm in front of the face); `captions.vtt` as a quiet caption in front of them at chest height.
3. **Library in the headset:** `GET /api/dreams` from the bridge, a grid of thumbs you poke to open, newest first.
4. **Numbers:** fps on the Quest 3S with LeBron's real replay loaded (121 frames). If it's under 72, tell Ojasva the
   Gaussian count that holds 72 and he'll re-export at that cap.
5. **Capture:** once LeBron lands, record a clean passthrough clip of the lesson in a real room for Atina's video.

## NOW (Fri 10:10 PM): run experience.json, the main goal

Hands-only controls with a passing HandsCheck: excellent. The product is now one line (AGENTS.md, top): photo or
video + one sentence of intent -> the person in your room doing it with you, driven by `experience.json` (AGENTS.md,
Contracts, "Experience"). Your next item, before anything else in the backlog:

1. **Teach mode in the Quest app:** steps from `experience.json`. Each step plays at its `speed`, `repeat` times, then
   the person freezes in the step's last pose for your turn (the move's length at 1x + 1.5 s, with a thin progress
   bar), then the next step, wrapping after the last. A step panel at eye level, off to the right of the person
   (step n of N or "Your turn", title, tip), and Back / Again / Next added to your fingertip bar. Read tips aloud with
   Android TTS (never the person's voice). Reference behaviour: `apps/webxr/src/experience.ts` (`Lesson`).
2. **Placement by `place`:** `facing` (1.8 m in front, facing you), `beside` (0.8 m to your right, 0.5 m ahead,
   facing your way), `ahead` (1.5 m ahead, facing away).
3. Then the SPZ/avatar items as before.

## Your big chunk

| Piece | Done means |
| --- | --- |
| Unity project in `apps/quest/` | Builds to the Quest 3S in passthrough (OpenXR + Meta XR SDK), Unity 2022.3 LTS |
| Gaussian rendering | Start from MIT `ninjamode/Unity-VR-Gaussian-Splatting` (Aras Pranckevicius's renderer, VR fork). Reference `VU-RASL/GaussianAvatarRender` for depth-correct passthrough avatars (learn from it; it has no license yet, so don't copy its code) |
| Replay playback | Loads a dream bundle (`frames/%06d.ply`) and plays it at the clip's fps, looping; preloads ahead so it never stutters |
| Avatar playback | Loads `avatar/avatar.ply` + `avatar/motion.json` (SMPL-X) and animates it (coordinate with Vishal) |
| Placement | Person appears life size on the real floor (Scene API / floor plane), facing you; grab to move or rotate |
| Controls | Play/pause, freeze, 0.25x / 0.5x / 1x, scrub with a pinch-drag, "seen vs imagined" toggle, next person |
| Library | Pulls the dream list from the bridge (`GET /api/dreams`) and downloads bundles over Wi-Fi |
| Performance | Holds 72 fps; find the real Gaussian budget per frame on Quest 3S (expect around 300-400k) and report it to Ojasva |
| Max-fidelity mode | PC-streamed (Quest Link / Air Link with passthrough) from a Windows laptop with an RTX GPU, for the hero demo. Find out who on the team has one |

## Milestones

| When | Done |
| --- | --- |
| Fri 11 PM | A static Gaussian person (the sample bundle's first frame) standing in passthrough on the Quest |
| Sat 10 AM | Full replay playing from a real bundle, at frame rate |
| Sat 8 PM | Controls, library from the bridge, avatar playback, polished in-headset UI (Atina designs it, you build it) |
| Sun 10 AM | Frozen, demo-proof, works offline from cached bundles |

## Talk to

- Ojasva: bundle format, Gaussian counts, compression if files are too big.
- Vishal: avatar rig and motion format.
- Atina: in-headset UI design (she matches Raami's web app look).

## Next chunk (added after your first push: nice work on the project setup and the first-frame importer)

1. **Sequence playback.** Real bundles have about 121 frames (`frames/%06d.ply`, 25 fps). Extend `DreamBundleImport`
   to batch-import every frame into Gaussian assets, then a `DreamSequencePlayer` that swaps the active asset at the
   bundle's `fps` (loop, play/pause, 0.25x / 0.5x / 1x, scrub). Preload everything before play so it never stutters.
2. **Budget.** Frames are capped at 300k Gaussians. Measure fps on the Quest 3S with a full sequence loaded; if it
   drops under 72, tell Ojasva the number that holds 72 and he'll re-export at that cap.
3. **Sample bundles.** A synthetic test bundle is on HiPerGator now; real people (4DAnyone's sample clips) follow as
   soon as SMPL-X finishes downloading. Ojasva fetches them into `dreams/<id>/` on his Mac (`.ply` with `--with-ply`).
4. **Grounding.** Add a soft contact shadow under the feet (a blurred dark disc on the floor plane). It's the single
   biggest thing that makes a person read as standing on the floor rather than floating.
5. The WebXR viewer in `apps/webxr` already does placement 1.8 m in front, facing you, on `local-floor`: use it as the
   reference for how placement should feel.

## Heads-up from Vishal's side (avatars)

Avatar bundles (`kind: "avatar"`) will carry `avatar/avatar.ply` (SMPL-X rest pose), `avatar/motion.json`,
`avatar/skin.bin` (per Gaussian: 4 joint indices + 4 weights as uint8) and `avatar/skeleton.json` (rest joints +
parents). Plan an avatar player that skins Gaussians on the GPU (linear blend skinning of positions and rotations).

## Your backlog (ordered; decide everything inside apps/quest yourself)

Test data now: `samples/synthetic-test/` in the repo (frame 0 as PLY, frames 0-3 as SPZ). Real bundles land in
`dreams/` on Ojasva's Mac as they finish; ask anyone at the table to copy one to you.

1. **Sequence player:** import all frames, swap at `fps`, preload, loop; play/pause, 0.25/0.5/1x, scrub.
2. **Runtime loading (big win):** a C# SPZ reader so bundles load at runtime from the bridge, with no editor import.
   The format is tiny: gzip of a header + packed arrays; `pipeline/lucid/gaussians.py` `write_spz` is the exact
   spec we write (positions 24-bit fixed point, alpha u8, colour u8, log-scale u8, rotation xyz u8). Build Aras's
   `GaussianSplatAsset` data from it at runtime.
3. **Library from the bridge:** `GET http://<mac>:5170/api/dreams`, download with progress, cache to disk for offline.
4. **Placement and hands:** pinch to pause, grab to move or rotate, soft contact shadow, the person life size on the
   real floor (never scaled).
5. **Reality check:** a toggle that swaps to `frames.reality` (the blue imagined parts), with the seen % shown.
6. **In-headset UI:** build Atina's mockups (she's designing to match Raami's web app). Start with placeholders now.
7. **Avatar player:** GPU skinning from `avatar/skin.bin` + `skeleton.json` + `motion.json` (Vishal's format above).
8. **Performance report:** fps vs Gaussians on Quest 3S, so Ojasva sets the export cap; LOD if needed.
9. **Max-fidelity mode:** PC streaming over Quest Link if anyone has a Windows laptop with an RTX GPU.
10. **Capture:** record a clean passthrough video of a person in the room for Atina's demo video.

## Update (Fri ~9 PM): after your OpenXR + hand-tracking push

Nice: Android OpenXR settings, Meta hand tracking and the batch APK build are in. Still the order:
1. **Sequence player** (all frames, swap at `fps`, preload, loop) and 2. **runtime SPZ loading**: these are what
   the demo needs first. Real bundles start landing in `dreams/` on Ojasva's Mac tonight once HiPerGator is back.
3. **Hands-only, no controllers** (the WebXR app now works this way; copy the feel): pinch to grab, release to
   drop; buttons pressed by pushing an index fingertip through them, firing once per push (not repeatedly while the
   finger rests there); a long pinch (~0.9 s) on empty space re-places things. Reference: `apps/webxr/src/chess/game.ts`
   (`XrButton`, `handOccluder`).
4. **Real hands in front of virtual things:** in passthrough, render the tracked hand mesh depth-only (a material
   with colour writes off, drawn first) so your real fingers stay visible in front of a person or object you reach
   past. Meta's hand mesh + a `ColorMask 0` shader does it in Unity.

## Decisions (Ian, apps/quest)

- **Unity 6000.6.0f1**, not 2022.3: the VR Gaussian renderer needs Unity 6000.3 or later.
- **Replays load at runtime, not through editor import.** `DreamSequencePlayer` reads `frames/*.ply` from the
  headset's storage, StreamingAssets or the bridge, keeps every frame on the GPU in full float precision (72 B per
  Gaussian per frame at SH degree 1) and swaps frames through the renderer's deformation hook: no uploads while playing.
  SPZ (`SpzFrameReader`, the exact inverse of `write_spz`) uses the same path; `Auto` picks PLY when every frame is
  there, else SPZ. Verified against the sample's frame 0: identical up to SPZ quantization.
- **GPU budget:** 121 frames x 300k Gaussians is about 2.5 GB. The player refuses anything over its budget (3 GB for
  now) and logs the per-frame cap that fits; the real Quest 3S number comes from item 8.
- **Delivery size:** a 121-frame PLY replay at 300k is about 9 GB, too big for Wi-Fi to the headset, so real
  bundles reach the Quest as SPZ; PLY stays for development and editor checks.
- **For Ojasva (SPZ fidelity):** the export writes SPZ at SH degree 0, so the Quest loses view-dependent colour that
  the PLY has; `write_spz(..., sh_degree=1)` adds 9 bytes per Gaussian and the reader already handles it. On the
  sample, 0.3% of colour values sit outside SPZ's range and get clamped (very bright or saturated spots).
  Also, `gaussiansPerFrame` is the first frame's count, not the largest (sample: 13,527 vs 16,768); the player
  copes by reloading, but the true max saves a reload.

## Update (Fri 9:10 PM): sequence player in, next is SPZ

The sequence player is exactly right (runtime loading, everything resident, no uploads while playing). Your own
numbers make the next step obvious: **the runtime SPZ reader is now item 1.** A 121-frame PLY replay is about 9 GB;
the same replay as SPZ is about 2-3% of that and decodes into the same GPU buffers. Format: `write_spz` in
`pipeline/lucid/gaussians.py` (gzip, header, then positions as 24-bit fixed point, alpha u8, colour u8, log-scale u8,
rotation xyz u8). `samples/synthetic-test/frames/*.spz` is test data. After that: hands (pinch to pause, grab to
move) and the avatar player below.

### Avatars skin live in WebXR now: copy the maths

`apps/webxr/src/avatar.ts` plays avatar bundles with GPU skinning and matches Vishal's Python reference to 1e-6.
What makes it simple, and what to do the same way in Unity:
- Rest = identity for every bone. Each frame, hand each bone the whole skinning transform
  `M_j = G_j [I | -rest_j] + root_t` (`skinTransforms()`), so the shader is just "blend 4 bone transforms per Gaussian".
- Dual-quaternion blend (no candy-wrapper wrists); rotate each Gaussian's own rotation by the blended rotation.
- Blend between motion frames (slerp per joint) so 30 fps motion is smooth at 72-90 Hz.
- Until your skinning works, Vishal's `python -m lucid_avatars bake dreams/<id>` turns an avatar into a normal frame
  sequence your sequence player already plays.

## Decisions: hands (Ian, Fri night)

- Same feel as the WebXR app: pinch 1.8 cm on / 3 cm off; quick pinch = play/pause; long pinch (0.9 s) re-places,
  pointing along your eye ray to the floor (a person can't land at arm's length); fingertip buttons fire once per push.
- Grab = pinch on the person (within 45 cm of their axis): drag moves along the floor, two hands turn. A grab counts
  from where the pinch began, so nothing is lost while it decides between tap and drag.
- The control bar floats low in front of you (fingertip reach) rather than beside the person 1.5 m away; it follows
  lazily. Placeholder glass styling (`GlassUI`) until Atina's mockups.
- Hand occlusion: depth-only spheres and capsules on the tracked joints, drawn before the splats (which depth-test).
- `HandsCheck` (simulated hands, real scene) passes all gestures; not yet tried with real hands on the Quest.

## Decisions: reality check (Ian, Fri night)

- Loads `frames.reality` on the first push only (playback carries on meanwhile), into a second GPU sequence at the
  same Gaussian count; the player is the renderer's frame source, so on/off is instant and keeps the moment.
- Bar title while on: "N% seen by the camera · blue was imagined" from `metrics.seenFraction` (falls back to
  "Blue was imagined" when the bundle doesn't say). The button only appears for bundles that ship reality frames.
- Avatar bundles' `avatar.reality` is parsed; it gets used with the avatar player.

## Decisions: teach mode (Ian, Fri night)

- `Lesson` is a straight port of the WebXR one (same phases, turn = move length at 1x + 1.5 s, wraps after the last
  step) and owns the player's clock while it runs; steps outside the clip are trimmed.
- No `experience.json` yet: the plan is guessed from `intent` with the WebXR rules, so "teach me ..." still teaches.
- Step card at eye level, 0.95 m ahead and 0.42 m to your right, turned to your eyes; it moves when the person is
  placed in front of you. Back / Again / Next replace the speed button in a lesson; the bar sizes itself to its buttons.
- Tips are read by Android TextToSpeech (device voice; Again says the step again). Not yet heard on a real Quest.
- `place` sets placement once the plan loads; `facing` is now 1.8 m (the contract), was 1.5 m.
- Companion / watch / play modes: plain playback for now; chess stays in the WebXR app.

## Decisions: library (Ian, Fri night)

- Bridge address: `bridge.txt` in the app's storage (one adb line, see apps/quest/README.md) or the scene field.
  Ojasva / Raami: if the Mac's address changes, that file is the only thing to update.
- Downloads take SPZ + reality frames, plan, thumb, guide and audio (not PLY), into `<id>.part`, renamed when
  complete; `dream.json` is written last. Cached dreams play offline; launch replays the last one played.
- Checked against a static stand-in for the bridge (same paths as apps/web); not yet against the real bridge.

## Decisions: avatar player (Ian, Fri night)

- GPU skinning in a compute shader that writes straight into the renderer's float frame (one dispatch per display
  frame, no CPU readback); bone maths on the CPU in the bundle's right-handed space, exactly `skin_matrices`.
- Dual-quaternion blend like the WebXR viewer. Checked against a synthetic SMPL-X-layout avatar written with
  `lucid_avatars` itself: one-bone Gaussians match `skinning.py` to 0.001 mm; blended ones match a dual-quaternion
  blend of `skin_matrices` to 0.001 mm (linear blend differs by up to 3.5 cm at a bent elbow, by design).
- Avatars without skin.bin/skeleton.json show as "Soon" in the library (bake them into a replay meanwhile).
- Not yet run with a real DiGS avatar (dreams/test-avatar is on Ojasva's Mac) or on the Quest.

## Decisions: voice and captions (Ian, Fri night)

- Voice: Unity AudioSource (3D, log rolloff from 1.2 m) at mouth height, 8 cm in front of the face; resynced past
  0.12 s; quiet when paused, in your turn and below 1x. AAC decoded by Android MediaCodec (JNI) on the Quest:
  compiles and builds, but not yet heard on a real headset. No HRTF until Meta's XR Audio SDK is added.
- Captions: WebVTT parsed like captions.ts (tags stripped, HTML entities decoded, which the WebXR canvas doesn't
  do: Atina's captions.py escapes `&`), quiet pill at 60% height, 0.42 m toward you.

## Decisions: props (Ian, Fri night)

- Ball maths ported line for line from props.ts (sample, bounce rule, fade, jump fade, backspin, shadow). Opaque when
  whole, a transparent copy only while fading, so it sorts right against the person.
- Built under the person's transform, so props share its handedness mirror and every placement. Checked on a test
  track: exact on frames, on the curve between, fades across nulls, never under the floor, rim at 3.05 m.

## Decisions: Atina's in-headset UI (Ian, Sat early)

- Built to demo/quest-ui/README.md's tokens, sizes and copy. Left out: the optional search and the category chips
  from the concept board (no categories in the data yet). No hand haptics exist, so seeks confirm with an audio tick.
- Previous / Next step through a lesson, otherwise move to the previous / next person on the headset (the brief's
  "next person"). Again stays in lessons. All eight controls fit one 0.82 m row; it wraps only if they don't.
- Checked headless (every HandsCheck run passes with the new controls); not yet seen at headset distance on a Quest.

## Decisions: Places (Ian, Sat early)

- Same places, ids, order and "column straight ahead" as places.ts; the panoramas stay once in apps/webxr and are
  converted to textures by Set Up Project (Unity can't import WebP), so nothing is duplicated in git.
- Grounded sphere built like three.js's GroundedSkybox (30 m, floor flattened at 1.6 m below the panorama's camera).
- Passthrough (ARCameraManager) is off while a place is fully in, saving the camera feed's cost; the hand stand-ins are
  off too (with passthrough off they would cut holes showing the panorama instead of your hand).


## Decisions: seated people (Ian, Sat)

- Read from the Gaussians, not from a new contract field: each frame's lowest point, top, torso axis and seat (where
  the torso column ends going down) are measured on the decode thread, and the median over frames is used. A
  per-frame lift would make them bob whenever a foot moved.
- Seated only when the plan or sentence asks for it (`experience.objects` bench / chair / piano..., or sit / piano /
  cello / drums in the intent) and the shape agrees (under 1.45 m tall from the lowest point). A standing person
  asked to sit stays standing.
- No legs below the hips: hips go to 0.48 m (a piano bench). Legs there: the bundle's floor stays on yours and the
  bench goes at their own seat height. Bench only if the reconstruction has almost nothing under the seat.
- Not applied to avatars (their rest pose stands). A `bench` kind in props.json, if the pipeline adds one, would
  draw a second bench; we'd drop ours then.
- Checked headless on two synthetic pianists (legs, no legs) and every earlier check; not yet on a real seated
  reconstruction (piano-han) or on a Quest.

## Decisions: two people at once (Ian, Sat)

- A second, fixed person rig in the scene (its own renderer, player, props, bench, shadow) under the first person's
  root, 1.5 m to their left. One root means the existing placement, drag, turn and re-place move both, with no new
  gestures. Pinching either person grabs the pair.
- The second person follows the first one's clock instead of playing their own, so pause, speed, scrubbing and lesson
  steps hold them in step (the brief's case: your avatar doing LeBron's shot beside him). A shorter clip loops. Only
  the first runs a lesson; the Reality check follows the first.
- No second voice or captions: two people speaking at once is noise, and captions would collide.
- GPU budget is shared: each player counts the frames everyone else holds, so two full replays can't exceed 3 GB
  together. Two 121 x 285k replays won't both fit; a replay plus an avatar does.
- Seating moved into the player so the second person can sit at a bench too.
- Separate splat renderers, not a GaussiansGroup: 1.5 m apart they never interleave, and Unity's transparent queue
  draws the farther one first. If people ever overlap, a group sorts them together.
- Checked headless (library flow, both seated people, every earlier check); not yet on a Quest, so the frame-rate
  cost of two people is unmeasured.
