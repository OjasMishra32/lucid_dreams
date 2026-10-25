# The film: 3:00, strict

The video is our whole presentation: one continuous montage built on two true stories that mirror each other. Ian
hasn't been home in four years, and his grandma stands in his room and answers him. Ojasva grew up reading Bobby
Fischer's games in chess books, and Bobby sits across a real table from him and plays. Someone far away, and someone
he never got to meet. In between, it grows from "oh" to "oh, this is insane". The tech is never a separate section: every world gets an x-ray moment, a cut into the machine at the
exact second you're seeing it (the headset assembling as it goes on, the 48 cameras landing around the dancer, the
ball's tracked path, the Talk timing under Vishal's answer). Apple style: black, white, one blue, SF Pro, nothing
fake, every number measured.

## Who does what

| Who | What | By |
| --- | --- | --- |
| Ojasva | Films every VR world (checklist below) and the phone b-roll | 9 AM |
| Ian | On camera for the grandma scenes, his own words (his OK to tell it) | 9 AM |
| Claude | Picks the best moments of every clip, cuts the montage to the song, builds the x-ray inserts and the overlays drawn onto the footage | cut 11 AM |
| Ojasva | Voiceover over the finished cut, section by section; CapCut polish; export; YouTube (unlisted); Devpost link | 2 PM |

Drop everything in `~/Downloads/lucid-video/` on Ojasva's Mac: `quest/` (headset recordings), `phone/` (b-roll and
screen recordings), `voice/` (voiceover takes), `music/` (the track). Name files loosely (`chess-1.mp4`); more takes
are better, Claude picks.

## The flow

One song under everything (Juice WRLD's "Lucid Dreams" if a 30-second unlisted YouTube test shows it's only claimed,
not blocked or muted; else a licensed track). Its opening guitar for the story, its build for the montage, the guitar
alone again for the ending, and nothing under grandma's, Ian's or Vishal's words. Cuts land on the beat. X-ray
inserts are 2 to 4 s, enter and leave on a match cut (same person, same pose, same framing), and carry one big line
of type; the voiceover is recorded last, over the finished cut, and only says what the picture can't.

| Time | Beat | Picture | X-ray (the tech, woven in) |
| --- | --- | --- | --- |
| 0:00-0:24 | **Four years** | Black, grandma's real voice from her old video; Ian's phone glowing in the dark; "I haven't been home in four years" (his words); she's in his room, life size; he asks her something in Vietnamese and she answers; his face | none: only "AI voice" and the English line under hers |
| 0:24-0:27 | **Title** | Black, "Lucid Dreams"; the song comes in | |
| 0:27-0:36 | **Any video** | A phone scrolling: a guitar lesson, a golf swing, a jump shot, an old photo of Fischer | |
| 0:36-0:39 | **Put it on** | Your view coming up into the room | the Quest 3S assembling, its eyes beaming out |
| 0:39-0:48 | **Learn guitar** | The guitarist beside you; your left hand on the neck; a strum; Lesson slowing it down | |
| 0:48-0:56 | **How** | Cut into the machine | 4DAnyone's 48 cameras landing around a person ("1 phone video. 48 views."), then twelve B200s and 290,000 Gaussians pulling together |
| 0:56-1:02 | **A pro's swing** | The golfer swinging beside you; you swing with him, then hit off the tee | |
| 1:02-1:12 | **Learn from LeBron** | His shot slowed down, then you pass, he catches and shoots | the real ball's tracked path over his shot; "Demo footage. Not affiliated." |
| 1:12-1:24 | **Play a legend** | Magnus's handshake, his reach, his clock press; Federer's serve and a rally | "Stockfish at Magnus Carlsen's peak rating. Not affiliated."; Magnus's x-ray, "14 public photos"; the tennis ball traced, "240 Hz · drag · Magnus lift" |
| 1:24-1:50 | **Bobby** | Your chess book open to a Fischer game, your line; Bobby at the table, his hand out, you shake it; his x-ray "6 photos, 1966 and 1972"; the game, quiet: he thinks, reaches, hits the clock, looks up at you | "Stockfish at Bobby Fischer's peak rating. Not affiliated." the whole time |
| 1:50-2:04 | **Talk** | "What's up, Vishal?" and he answers out loud | his 14 frames flying into his body; the timing bar under his answer |
| 2:04-2:10 | **Honest** | A person turning partly blue | the Reality check render: "never seen by the camera. 49% seen." |
| 2:10-2:14 | **On a headset** | You moving through a world, smooth | the heat map, 115 million pixels per eye dropping to 34 |
| 2:14-2:26 | **Anyone** | The fastest cuts of every world, a beat each | numbers flashing: Aug 2026 · 48 views · 290,000 · 3.1 s |
| 2:26-2:53 | **Home** | The song drops to the guitar. Ian and his grandma: she says something warm, he answers. Bobby holds his hand out again as your game ends; you shake it. Both headsets come off. Two empty chairs. | none |
| 2:53-3:00 | **End** | "Lucid Dreams. Anyone from any video, standing in your room." · link · team · labels | |

## What to film (checklist)

**Every headset take:** Meta button, Camera, Record video. Start recording, wait 2 s, do the thing, hold 2 s after.
15 to 30 s a take, 3 takes of each. Move your head slowly and keep the person in the middle, 1.5 to 2 m away. Room
lights on, room tidy, nothing private in view. Turn the microphone on for the Talk takes (Settings, Camera). Copy the
recordings to `~/Downloads/lucid-video/quest/` (OpenMTP over USB), named loosely (`chess-2.mp4`).

**Ian and his grandma** (the most important shots; Ian in the room, his OK; 5 takes of each)
- [ ] Phone b-roll: Ian on his bed at night, scrolling his camera roll to an old video of her, close on the phone
- [ ] Phone b-roll: Ian putting the headset on
- [ ] Headset (`/xr/?dream=ian-grandma`): she appears in his room, life size; hold on her 10 s, no talking
- [ ] Headset, mic on: Ian presses Talk and asks her something in Vietnamese; her answer plays with the Vietnamese,
      the English line and "AI voice" in frame
- [ ] A second, warmer exchange for the ending (Ian chooses what to say)
- [ ] Phone b-roll: Ian's face from the side while she answers
- [ ] Phone b-roll: Ian lifting the headset off, sitting for a moment

**Make one** (iPhone screen recording)
- [ ] On https://getluciddreams.vercel.app scroll to Make one, pick a dance clip from the camera roll, type "teach
      me this dance". Stop before tapping Make.

**Learn**
- [ ] Dance (`/xr/?dream=dance-01`): she dances at full size in the room, wide, her feet on your floor
- [ ] Dance with Lesson on (palm menu): the step card, a step slowed down, "your turn"
- [ ] Follow along: the glowing targets on your head and wrists while you copy her
- [ ] Tai chi (`/xr/?dream=taichi-01`) with Mirror, you moving with him
- [ ] Golf (`/xr/?dream=golf-01`): his swing, then you with the club, hitting the ball off the tee
- [ ] Guitar (`/xr/?dream=guitar-01`): the guitar at your waist, your left hand on the neck, a strum

**Play**
- [ ] Chess (`/xr/?mode=chess&strength=carlsen`): Magnus offers his hand, you shake it (label in frame)
- [ ] Chess: you pinch a piece and move it; he thinks, reaches, moves his piece, presses the clock
- [ ] Chess (`strength=fischer`): one take of Bobby reaching across the board
- [ ] Tennis (`/xr/?mode=tennis`): Federer walks to the net, the handshake (label in frame)
- [ ] Tennis: your toss and serve, then a rally of 3+ shots
- [ ] Basketball (`/xr/?dream=lebron-shot`): you pass, he catches and shoots; then you shoot at the hoop

**Talk**
- [ ] Vishal (`/xr/?dream=vishal`), mic on: ask him something short ("What's up, Vishal?"); his full answer with the
      caption and "AI voice" in frame

**The tech, in the headset**
- [ ] Reality check on the dancer: tap it, she turns partly blue, the "% seen" note; walk halfway round her
- [ ] Pause the jump shot mid-air and walk all the way around him
- [ ] The palm menu opening on your left hand, pressing a button with your right finger

**Wide b-roll** (phone, someone else filming, 4K, from behind and the side)
- [ ] You shaking Magnus's hand in empty air; you serving; you passing the ball; you copying the dancer
- [ ] Ian sitting with his grandma (her side of the room empty in real life)

**Don't film**
- The library list, loading spinners, the browser's address bar, an "Enter AR" button, notifications
- Anything that stutters: if the person drops frames, stop and retake
- Faces up close on the legends or Federer (soft close up): keep 1 m or more
- Held or test people (Federer's library entry, test bundles, old LeBron); anything not in the list above
- Music playing in the room, other people's faces without their OK, private screens
- Grandma without Ian in the room saying yes to the take

## Voiceover (the narration)

Recorded last, over the finished cut. Calm, close, a little slower than feels natural. Numbers live on screen; the voice
says what the picture can't. Ian and Ojasva each say their own lines in their own words.

| Time | Over | Line |
| --- | --- | --- |
| 0:27 | the phone scrolling videos | "Everyone you want to learn from, everyone you look up to, everyone you miss. They're already on your phone." |
| 0:32 | | "Lucid Dreams takes any video, or any photo, and stands that person in your room. Real size. And then they do things with you." |
| 0:40 | the guitarist beside you | "Always wanted to play guitar? Pick anyone on YouTube. They sit next to you, and slow down until your hands catch up." |
| 0:49 | the cameras landing | "One phone only ever sees one side of someone. 4DAnyone, from this August, imagines the other forty-seven views." |
| 0:53 | the Gaussians forming | "Twelve GPUs turn them into two hundred ninety thousand 3D Gaussians, every frame." |
| 0:57 | the golfer beside you | "Take a pro's swing, and swing right next to it." |
| 1:03 | LeBron | "Learn a jump shot from LeBron. Then pass him the ball." |
| 1:13 | Magnus | "Sit across the board from the best player in the world." |
| 1:25 | your chess book | **Ojasva, his own words:** what Bobby's games meant to him, and that he never got to play him |
| 1:51 | Vishal | "Or just talk. They answer in their own voice." |
| 2:05 | the blue sweep | "Anything the camera never saw shows up blue. We never pretend it's real." |
| 2:11 | the heat map | "And all of it runs on a three-hundred-dollar headset." |
| 2:50 | the end card coming up | "Anyone, from any video, standing in your room." |

Don't name a real person the footage isn't: the golf clip isn't Rory McIlroy, so the line says "a pro's swing" (any
pro's video works the same way).

## Music

"Lucid Dreams" plays from YouTube on Devpost, and it's copyrighted twice over (Juice WRLD, and the Sting sample). Upload
a 30-second unlisted test with it tonight: YouTube Studio shows "Copyright claim" and whether it's blocked anywhere.
Only claimed: use it. Blocked or muted: a licensed track (CapCut's commercial library, Pixabay Music, the YouTube Audio
Library). Put the audio file in `music/`.

## On screen, always

"AI voice" whenever grandma or Vishal speaks; the legends' and Federer's labels whenever they're in frame; the blue
Reality check explained once. Every number is a measured one (from `demo/devpost.md`).
