# Atina: story, data and demo (light on AI compute)

You own what the judges see and read, and the footage everything is built from. Most of this needs a phone, good
judgment and writing, not heavy AI use, so it fits a small Codex plan: use Codex for the README and Devpost polish,
not for long coding sessions. Read `AGENTS.md` first.

## Your big chunk

| Piece | Done means |
| --- | --- |
| Capture guide + clips | Shoot the test and hero clips to the rules in `AGENTS.md`: 4K if possible, portrait 9:16, 5-10 s, one person, tripod, bright even light, fast shutter, plain background. Teammates doing moves (a jumper, a dance, a boxing combo). Name them clearly and hand them to Ojasva |
| Steph Curry clips | Find the cleanest full-body, still-camera workout clips; crop to portrait; note the source |
| Family moment | One teammate's family photo or video (an old photo of a grandparent works). **Get the family's consent in writing**, even a text message, and keep it in `demo/consent.md` |
| Devpost | Title, tagline, description (what it does, how we built it, the new tech and why it's recent, challenges, what's next), built-with list, tracks: overall, Best AI Hack, Best Design, Best Social Impact, MLH Gemini, MLH Open Source |
| README + LICENSE | Public-repo README: what it is, demo GIF, how it works, credits to every open-source model, MIT license |
| Demo video (3 min max) | Script, shot list, edit. Open on the family moment, then the wow (a person appearing in the room), then how it works with real numbers, then the team |
| In-headset UI design | Design the Quest panels to match Raami's web app: playback controls (play, freeze, 0.25x/0.5x/1x, scrub), the library of dreams, the "seen vs imagined" toggle, coaching captions. Big, calm, readable at arm's length. Mockups in Figma (or even clean slides) with exact sizes and colours; Ian builds them |
| Slides + judge prep | A short deck with the fidelity numbers; a list of likely judge questions with answers (theme, consent, what's generated vs real, limits) |

## Milestones

| When | Done |
| --- | --- |
| Fri 10 PM | 3 test clips shot and handed to Ojasva; family photo picked and consent asked |
| Sat 10 AM | In-headset UI mockups handed to Ian |
| Sat noon | Hero clips shot; Devpost draft; video script |
| Sat 8 PM | README done; slides drafted |
| Sun 1 PM | Video edited; Devpost final. **Submit by 3 PM** |

## Talk to

- Ojasva: which clips work best (he'll tell you what the pipeline needs more of).
- Raami: screenshots, copy, and the web app's look so the headset UI matches it.
- Ian: what the Quest can show (panel sizes, text sizes) before you design.
- Everyone: two lines each about what they built, for Devpost.

## Work without waiting

- **Clips:** shoot to the capture guide (landscape is fine now: the pipeline frames the person automatically) and
  AirDrop them to Ojasva's Mac into `~/Downloads/lucid-clips/`. That's all: they process by themselves.
- **Design tokens** for the headset UI are at the top of `apps/web/app/globals.css` (Raami's). Match them exactly.
- Most of your list is writing and design, so it fits your Codex plan: use Codex to polish text, not to generate it.

## Your backlog (ordered)

1. Shoot 3-5 clips tonight (teammates doing moves) and AirDrop them in.
2. Family moment: pick the photo or video, get consent in writing, save it in `demo/consent.md`.
3. In-headset UI mockups for Ian (controls, library, reality toggle, captions), with exact sizes.
4. Devpost draft in `demo/devpost.md`: what it does, how we built it, the new tech and why it's recent
   (4DAnyone Aug 2026, DiGS-Avatar 2026), challenges, what's next. Leave blanks for numbers.
5. README draft in `demo/README-draft.md` with the credits list (4DAnyone, DiGS-Avatar, gsplat, Spark, three.js,
   Unity Gaussian Splatting, NLF, rembg, GVHMR, BiRefNet, SMPL-X and their licenses).
6. Video: script + shot list in `demo/video.md` (family moment first, then the wow, then how it works, then the team).
7. Judge Q&A in `demo/judges.md`: theme fit, consent, what's real vs imagined, limits, what's next.
8. Slides with placeholders for the numbers (PSNR, % seen, Gaussians, time per dream).

## Working decisions — Friday, October 23

- First-milestone preparation lives in `demo/README.md`, `demo/capture-guide.md`, `demo/clips.md` and
  `demo/consent.md`. Prioritize three simple, sharply recorded teammate movements; this batch does not need
  public-figure footage or GPU work from Atina.
- Keep clip capture, consent, transfer and processing as separate states. Planned shots are not delivered clips.
  The Friday milestone remains open until three handoffs, a family asset selection and a sent consent request
  are confirmed. A pending consent request does not authorize processing or display.
- Store private media and written consent evidence outside this public repository. `demo/consent.md` holds
  anonymous record IDs, permission scope, status and private evidence labels; it does not expose family messages.
- No app code, shared contracts or pipeline settings are changed by this preparation work. Ian receives UI
  designs later; Ojasva remains the contact for automatic intake and processing results.

## Update (Fri ~9 PM): kit looks great, now the real things

The capture and consent kit is exactly right. The Friday milestone now is the physical part: three clips AirDropped
into `~/Downloads/lucid-clips/` on Ojasva's Mac, and the family consent request actually sent.

New thing for the story: `?mode=chess` in the WebXR app (`https://<mac>:5180/?mode=chess` on the Quest) is a
side mode: a real-size chess board on your table, pieces moved with your bare hands, an engine opponent from club
level up to Fischer's and Carlsen's peak ratings (labelled "Stockfish at X's peak rating. Not affiliated." Keep that
wording anywhere it appears). In the video it's a 5-10 second "and it's not just people" beat after the main demo;
in Devpost, one line under "what's next / also built". Never say or imply we have the real players.

## Your new big chunk (Fri 9 PM): two pieces of the product nobody else owns

The milestone clips still come first (30 minutes tonight). After that these two are yours end to end. Both run on
your Mac with no GPU account and very little code, and both are things the demo really needs.

### 1. Their words, floating beside them (captions)

When someone appears in the room and speaks, their words should appear beside them as quiet captions. It's the most
emotional detail in the family moment, and it makes the product work for deaf and hard-of-hearing people (Best
Social Impact).

- Tool: [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`brew install whisper-cpp`; model `ggml-large-v3-turbo`,
  runs on the Mac GPU through Metal). Input: a bundle's `voice.m4a` (Demucs-separated voice) or `audio.m4a`.
- Write `pipeline/lucid/captions.py`: `python -m lucid.captions dreams/<id>` converts the voice to 16 kHz mono WAV with
  ffmpeg, runs whisper with word timestamps, then cleans the result:
  - at most 2 lines of 42 characters per cue, and 1-6 s on screen;
  - drop non-speech tags (`[Music]`, `(laughs)`);
  - drop any cue over near-silence (whisper invents "Thank you." on silence; check the audio level under each cue).
  It writes `captions.vtt` (WebVTT, times in the clip's own time) into the bundle and adds `"captions": "captions.vtt"`
  to `dream.json`. That field is in the contract now (AGENTS.md).
- Test on 3 clips that have real speech (a teammate talking to camera works). Read every caption against the audio
  and fix the cleaning rules until none are wrong.
- Ojasva wires the WebXR viewer to show them; Raami shows them on the dream page.
- Done means: `captions.py` plus a short test with a tiny WAV in `pipeline/tests/`, three bundles with correct captions,
  and two lines in `demo/README.md` on how to run it.

### 2. Old footage, restored before it goes in

The pitch is "an old video of someone you love". Real old home video is 480p, interlaced, noisy and 4:3, and the
pipeline wants a sharp 1080p portrait clip. Find out how much a restoration pass helps, and ship it if it does.

- Write `pipeline/lucid/restore.py`: `python -m lucid.restore in.mp4 out.mp4`. It runs:
  1. ffmpeg deinterlace (`bwdif`) and a light denoise (`hqdn3d=2:1:3:3`);
  2. a 4x upscale with [Real-ESRGAN ncnn](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan) (macOS binary, Metal via
     MoltenVK; model `realesrgan-x4plus`), frame by frame;
  3. reassemble at the original fps with the original audio.
  **No face-restoration models** (GFPGAN, CodeFormer): they change who the person looks like, and for this product
  that's the one thing we can't do.
- Test footage: a public-domain home movie from the Prelinger Archives on archive.org (note the item URL in
  `demo/clips.md`), plus a teammate filmed on purpose at 480p.
- A/B test: put the plain and the restored version of the same clip through the pipeline (drop both into
  `~/Downloads/lucid-clips/` on Ojasva's Mac). Compare the two dreams side by side in the viewer, and compare the
  sharpness and PSNR numbers in each `recon-*.json`.
- Done means: `restore.py`, a side-by-side image for the slides, and a recommendation: should `prep_clip.py` call it
  automatically for inputs under 720p? If yes, add that call yourself.

### Then, Saturday, as before

Devpost draft (noon), video script (noon), README with credits (8 PM; add whisper.cpp and Real-ESRGAN, both MIT/BSD),
slides, judge Q&A. Use Codex for the two scripts above; they're each well under 200 lines.
