# The film: 3:00, strict

The video is our whole presentation. It opens and closes on one true story (Ian hasn't been home in four years, and
his grandma stands in his room and answers him), shows everything you can do in between, then opens up the machine
with motion graphics made from our real data. Apple style: black, white, one blue, SF Pro, nothing fake.

## Who does what

| Who | What | By |
| --- | --- | --- |
| Ojasva | Films every scene (headset recordings + phone b-roll), records the voiceover, final polish in CapCut | footage 9 AM, voice 10 AM |
| Ian | On camera for the grandma scenes, says his own line (his words, his OK to tell it) | 9 AM |
| Claude | Renders the motion graphics from real data, picks the best takes, assembles the rough cut on the timeline below | rough cut 11:30 AM |
| Ojasva | CapCut: music, captions, final timing, export 1080p, upload to YouTube (unlisted), link on Devpost | upload 2 PM, Devpost 3 PM |

Drop everything in `~/Downloads/lucid-video/` on Ojasva's Mac: `quest/` (headset recordings), `phone/` (b-roll and
screen recordings), `voice/` (voiceover takes), `music/` (the track). Name files loosely (`chess-1.mp4`); more takes
are better, Claude picks.

## The timeline

Music: one bittersweet piano piece that grows (Act 1), lifts into a light beat (Act 2), thins out under the
graphics (Act 3) and comes back to the first theme for the ending (Act 4). Grandma's voice and Vishal's reply play
over a ducked bed.

### Act 1: Ian (0:00 to 0:32)

| # | Time | Picture | Sound | On screen |
| --- | --- | --- | --- | --- |
| 1 | 0:00-0:05 | Black, then Ian's phone in his hand at night: scrolling his camera roll to an old video of his grandma | Piano starts. Ian (voice): his line, e.g. "I haven't been home in four years." | |
| 2 | 0:05-0:09 | The phone video plays: his grandma talking, small on the screen | Her real voice, quiet, from the phone | |
| 3 | 0:09-0:13 | Ian puts on the Quest (phone b-roll, side view) | Piano | |
| 4 | 0:13-0:21 | Headset view: his room, and his grandma is there, life size. Hold on her. | Piano swells | |
| 5 | 0:21-0:28 | Ian asks her something in Vietnamese (Talk). She answers. | Her AI voice | Her words + English line + "AI voice" |
| 6 | 0:28-0:30 | Phone b-roll: Ian's face under the headset, his reaction | Silence for a beat | |
| 7 | 0:30-0:32 | Cut to black | | "Lucid Dreams" |

### Act 2: what it does (0:32 to 1:12)

| # | Time | Picture | Sound | On screen |
| --- | --- | --- | --- | --- |
| 8 | 0:32-0:37 | iPhone screen recording: pick a video from the camera roll on the site's Make one, type a sentence ("teach me this dance") | VO: "Give it any video and one sentence." | |
| 9 | 0:37-0:49 | Learn: the dancer in the room at full size, Lesson step card, "your turn", follow-along targets on your head and wrists; a golf swing with the club in your hands; a guitar chord | VO: "They show up in your room, life size. Every move slows down, then it's your turn." | step titles |
| 10 | 0:49-1:03 | Play: Magnus shakes your hand, you pinch a piece, he reaches and hits the clock. Federer at the net, handshake, your serve, a rally. You pass to LeBron, he catches and shoots. | VO: "Play chess against a legend. Rally with one. Pass and he takes the shot." | "Stockfish at Magnus Carlsen's peak rating. Not affiliated." / "Roger Federer's likeness. AI opponent, not affiliated." / "Demo footage. Not affiliated." |
| 11 | 1:03-1:12 | Talk: Vishal in your room, you ask him something, he answers out loud | His AI voice | "AI voice" + caption |

### Act 3: how it works (1:12 to 2:22), motion graphics from real data

| # | Time | Picture | VO |
| --- | --- | --- | --- |
| 12 | 1:12-1:22 | One phone clip of the dancer; 4DAnyone's 48 real cameras fly in around her in three rings | "One camera only sees one side of you. 4DAnyone, released this August, turns one video into 48." |
| 13 | 1:22-1:34 | 12 B200s light up, the frame counter runs to 121, the loss falls, 290,000 Gaussians pull together into her | "On UF's supercomputer, twelve GPUs fit 290,000 Gaussians to every frame." |
| 14 | 1:34-1:41 | The Reality check sweeps across her: what the real camera never saw turns blue, "54% seen" | "Whatever the camera never saw turns blue. We never pass it off as real." |
| 15 | 1:41-1:53 | Vishal: his 14 frames fly into a rigged body (55 joints), the face lands, he blinks | "For people who move on their own, LHM++ builds a body from photos, and UIKA gives it a face." |
| 16 | 1:53-2:07 | The Quest 3S assembles, its eyes beam out; the overdraw heat map drops from 115 to 82 to 34 million pixels | "Then it has to run on a headset. One person is 115 million pixels per eye, so we budget every splat." |
| 17 | 2:07-2:16 | Talk: mic, Whisper, the reply, his voice, a 3.1 s bar filling in three parts | "It hears you, answers as them, in their own voice. About three seconds." |
| 18 | 2:16-2:22 | Numbers, one at a time: Aug 2026 · 48 views · 290k Gaussians · 26-32 dB · 3.1 s | music only |

### Act 4: back to Ian (2:22 to 3:00)

| # | Time | Picture | Sound | On screen |
| --- | --- | --- | --- | --- |
| 19 | 2:22-2:30 | Fast wide shots: everyone standing in real rooms | Music returns to the first theme | |
| 20 | 2:30-2:47 | Ian and his grandma again: she says something warm, he answers, he sits with her | Her AI voice, then Ian | captions + "AI voice" |
| 21 | 2:47-2:53 | Ian lifts the headset off, sits for a second | Piano | |
| 22 | 2:53-3:00 | End card | Piano resolves | "Lucid Dreams. Anyone from any video, standing in your room." getluciddreams.vercel.app · team names · "AI voices are labeled. Public figures are likenesses, not affiliated." |

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

## Voiceover

Record in a quiet room on the iPhone (Voice Memos), 15 cm from the mouth, three takes of each line, calm and close:
the music does the emotion.

- "Give it any video and one sentence."
- "They show up in your room, life size. Every move slows down, then it's your turn."
- "Play chess against a legend. Rally with one. Pass and he takes the shot."
- "One camera only sees one side of you. 4DAnyone, released this August, turns one video into 48."
- "On UF's supercomputer, twelve GPUs fit 290,000 Gaussians to every frame."
- "Whatever the camera never saw turns blue. We never pass it off as real."
- "For people who move on their own, LHM++ builds a body from photos, and UIKA gives it a face."
- "Then it has to run on a headset. One person is 115 million pixels per eye, so we budget every splat."
- "It hears you, answers as them, in their own voice. About three seconds."

Ian: his own opening line, and anything he wants to say to her or about her. Nothing scripted for him.

## Music

Use a track we're allowed to publish: CapCut's library filtered to commercial use, or Pixabay Music, or the YouTube
Audio Library. Search "emotional piano", "bittersweet", "cinematic piano build". A popular song (like "deja vu")
gets the YouTube upload claimed or muted, and the Devpost video plays from YouTube.

## On screen, always

"AI voice" whenever grandma or Vishal speaks; the legends' and Federer's labels whenever they're in frame; the blue
Reality check explained once. Every number is a measured one (from `demo/devpost.md`).
