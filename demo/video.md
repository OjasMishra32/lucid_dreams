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

## Second by second

The film has one story and one argument. The story: Ian hasn't been home in four years, and his grandma is in his
room. The argument: that is now possible from one phone video, here is everything else it does, and here is exactly
how the machine does it. Emotion at the start and end, wonder in the middle, depth after. The voiceover is Ojasva,
calm and close; Ian's lines are his own words. Files in `motion/` are the rendered graphics; everything else is
footage from the checklist below.

**Sound arc:** a solo piano (0:00), one sustained low note under the title (0:35), a light pulse joins for the
gameplay (0:37 to 1:19), the pulse drops out and soft synth pads carry the graphics (1:21 to 2:28), the opening
piano returns alone for the ending (2:30). Real sound always sits on top: grandma's voice, the chess clock, the
tennis ball, Vishal's answer.

### Act 1: four years (0:00 to 0:36)

| Time | Picture | Voice | Sound | On screen |
| --- | --- | --- | --- | --- |
| 0:00-0:03 | Black | | Grandma's real voice from her old video, Vietnamese, quiet, no music | |
| 0:03-0:08 | Ian's phone in his hand in a dark room, her old video playing on it, the screen lighting his face | | Her voice continues; first piano notes | |
| 0:08-0:12 | Close on Ian's face, the phone glow; his thumb pauses the video | **Ian:** "I haven't been home in four years." (his words) | Piano | |
| 0:12-0:16 | Ian puts the phone down and puts the Quest on (side b-roll) | | Piano, a breath of room tone | |
| 0:16-0:24 | Headset view: his room, lamp light. She is standing there, life size. Hold. | | Piano rises slowly | |
| 0:24-0:31 | Headset view: Ian presses Talk, asks her something in Vietnamese; she answers | **Ian**, then **grandma (AI voice)** | Music ducks under the voices | her words, the English line under it, "AI voice" |
| 0:31-0:34 | Side b-roll: Ian's face under the headset as she answers | | One held piano chord | |
| 0:34-0:36 | Cut to black, then `motion/title.mp4` | | Low note under the title | "Lucid Dreams" |

### Act 2: anyone, from any video (0:36 to 1:20)

| Time | Picture | Voice | Sound | On screen |
| --- | --- | --- | --- | --- |
| 0:36-0:41 | iPhone screen recording: the camera roll, picking the dance clip on Make one, typing "teach me this dance" | "Lucid Dreams turns any video into a person, standing in your room." | Pulse comes in | |
| 0:41-0:46 | Headset, wide: the dancer at full size on the floor; you step to the side and she's solid from there too | "Real size. Real motion. Walk all the way around them." | | |
| 0:46-0:52 | Lesson on: the step card, a step slowed down, "your turn", the glowing follow-along targets on your wrists | "Ask it to teach you, and every move slows down and waits for you." | | step title |
| 0:52-0:56 | Two fast cuts: golf (you hit off the tee), guitar (your strum) | | Ball strike, a strum | |
| 0:56-1:03 | Chess: Magnus offers his hand, you shake; you move a piece by pinch; he reaches, moves, hits the clock | "Sit across the board from a legend." | The clock's click | "Stockfish at Magnus Carlsen's peak rating. Not affiliated." |
| 1:03-1:09 | Tennis: Federer's handshake at the net, your toss and serve, a rally | "Rally with one." | Ball off the strings | "Roger Federer's likeness. AI opponent, not affiliated." |
| 1:09-1:13 | Basketball: you pass, LeBron catches and shoots | "Pass, and he takes the shot." | Swish | "Demo footage. Not affiliated." |
| 1:13-1:20 | Talk: Vishal in your room; you ask "What's up, Vishal?", he answers out loud | "Or just talk. Vishal gave it sixteen seconds of video." | His answer over a ducked bed | caption, "AI voice" |

### Act 3: how it works (1:20 to 2:30)

| Time | Picture | Voice | Sound | On screen |
| --- | --- | --- | --- | --- |
| 1:20-1:22 | Black | "Here's the hard part." | The pulse stops; a pad comes in | |
| 1:22-1:32 | `motion/cameras.mp4`: her phone video, then 4DAnyone's 48 real cameras landing around her | "A camera only sees one side of you. 4DAnyone, published at SIGGRAPH Asia this August, turns one video into forty-eight views, all the way around." | Soft whoosh per ring | in the graphic |
| 1:32-1:44 | `motion/fit.mp4`: twelve B200s working, the frame counter to 121, 290,000 Gaussians pulling together into her | "On UF's HiPerGator, twelve B200 GPUs fit two hundred ninety thousand 3D Gaussians to every frame." | | in the graphic |
| 1:44-1:51 | `motion/reality.mp4`: the Reality check sweeps her blue | "Anything the camera never saw, we paint blue. Nothing imagined gets passed off as real." | | in the graphic |
| 1:51-2:03 | `motion/avatar.mp4`: Vishal's 14 frames fly into a rigged body, his face lands | "From a handful of frames, LHM++ builds a body we can move, and UIKA gives it his face." | | in the graphic |
| 2:03-2:12 | `motion/headset.mp4`, first part: the Quest 3S assembling, its eyes beaming out, the dancer appearing | "Then it all has to run on a headset." | Parts clicking together | |
| 2:12-2:18 | `motion/headset.mp4`, the heat map: 115 to 82 to 34 million | "One person is a hundred and fifteen million pixels per eye, every frame. So we budget every splat." | | in the graphic |
| 2:18-2:25 | `motion/talk.mp4`: his voice, then hears you, answers as him, in his voice, 3.1 s | "When you talk, it listens, answers as them, and speaks in their voice. About three seconds." | | in the graphic |
| 2:25-2:30 | `motion/numbers.mp4` (first three): Aug 2026, 48, 290,000 | | Pad swells, then drops away | in the graphic |

### Act 4: home (2:30 to 3:00)

| Time | Picture | Voice | Sound | On screen |
| --- | --- | --- | --- | --- |
| 2:30-2:34 | Four wide b-roll cuts, one second each: the dancer, Magnus, Federer, Vishal, each life size in a real room | | Opening piano returns, alone | |
| 2:34-2:48 | Ian and his grandma again: she says something warm, he answers; the side b-roll of him sitting with her | **Grandma (AI voice)**, then **Ian** | Piano under the voices | her words, English line, "AI voice" |
| 2:48-2:53 | Ian lifts the headset off. The chair across from him is empty. He sits a second. | | One last chord, held | |
| 2:53-3:00 | `motion/end.mp4` | | Piano resolves, silence at 3:00 | "Lucid Dreams. Anyone from any video, standing in your room." · getluciddreams.vercel.app · team · "AI voices are labeled. Public figures are likenesses, not affiliated." |

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

## Voiceover (record list)

Quiet room, iPhone Voice Memos 15 cm from your mouth, 3 takes of each line, calm and close, slower than feels
natural. Save to `~/Downloads/lucid-video/voice/`.

1. "Lucid Dreams turns any video into a person, standing in your room."
2. "Real size. Real motion. Walk all the way around them."
3. "Ask it to teach you, and every move slows down and waits for you."
4. "Sit across the board from a legend."
5. "Rally with one."
6. "Pass, and he takes the shot."
7. "Or just talk. Vishal gave it sixteen seconds of video."
8. "Here's the hard part."
9. "A camera only sees one side of you. 4DAnyone, published at SIGGRAPH Asia this August, turns one video into
   forty-eight views, all the way around."
10. "On UF's HiPerGator, twelve B200 GPUs fit two hundred ninety thousand 3D Gaussians to every frame."
11. "Anything the camera never saw, we paint blue. Nothing imagined gets passed off as real."
12. "From a handful of frames, LHM++ builds a body we can move, and UIKA gives it his face."
13. "Then it all has to run on a headset."
14. "One person is a hundred and fifteen million pixels per eye, every frame. So we budget every splat."
15. "When you talk, it listens, answers as them, and speaks in their voice. About three seconds."

Ian, in his own words: the opening line about how long he's been away, what he asks her, and what he says to her at
the end. Nothing scripted for him; if a line isn't true for him, it isn't in the film.

## Music

Use a track we're allowed to publish: CapCut's library filtered to commercial use, or Pixabay Music, or the YouTube
Audio Library. Search "emotional piano", "bittersweet", "cinematic piano build". A popular song (like "deja vu")
gets the YouTube upload claimed or muted, and the Devpost video plays from YouTube.

## On screen, always

"AI voice" whenever grandma or Vishal speaks; the legends' and Federer's labels whenever they're in frame; the blue
Reality check explained once. Every number is a measured one (from `demo/devpost.md`).
