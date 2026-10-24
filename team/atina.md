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
