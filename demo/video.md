# The film: 3:00, strict

The video is our whole presentation: one continuous montage that opens and closes on one true story (Ian hasn't been
home in four years, and his grandma stands in his room and answers him) and, in between, grows from "oh" to "oh, this
is insane". The tech is never a separate section: every world gets an x-ray moment, a cut into the machine at the
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
| 0:00-0:28 | **Four years** | Black, grandma's real voice from her old video; Ian's phone glowing in the dark; "I haven't been home in four years" (his words); the headset on; she's in his room, life size; he asks her something in Vietnamese and she answers; his face | none: only "AI voice" and the English line under hers |
| 0:28-0:31 | **Title** | Black, "Lucid Dreams"; the song comes in | |
| 0:31-0:37 | **Put it on** | You lift the Quest to your face | match cut into the render: the Quest 3S assembling, its two eyes beaming out, and back into your view of the room |
| 0:37-0:52 | **She's here** | The dancer appears in your room, life size; you walk around her | freeze, cut into her render: her phone video, then 4DAnyone's 48 cameras landing around her, "1 phone video. 48 views."; back into the room as she moves again |
| 0:52-1:05 | **Learn** | Lesson: her step card, a step slowed, "your turn", targets on your wrists; golf off the tee; a guitar strum; tai chi with Mirror; fast cuts on the beat | "her 22 joints, from the video" over the follow-along targets |
| 1:05-1:10 | **Made of light** | Cut out of a lesson into the machine | the fit render: twelve B200s, frames to 121, 290,000 Gaussians pulling together into her; cut back into the room on the same pose |
| 1:10-1:38 | **Play** | Pass to LeBron, he catches and shoots; Magnus's handshake, your move, his reach and the clock; Federer's handshake at the net, your serve, a rally | the real ball's tracked path drawn over the shot; "Stockfish at Magnus Carlsen's peak rating. Not affiliated." and "his hands never pass through a piece"; the ball's flight traced over the rally with "240 Hz · drag · Magnus lift · grass" |
| 1:38-1:46 | **Honest** | You tap the Reality check on the dancer; she turns partly blue | her render sweeping blue: "never seen by the camera. 49% seen." |
| 1:46-2:02 | **Talk** | "What's up, Vishal?" and he answers out loud | before he answers, his 14 frames fly into his body (the avatar render); under his answer, the timing bar filling "hears 1.5 s · answers 1.0 s · speaks 0.5 s" |
| 2:02-2:08 | **On a headset** | You moving fast through a world, smooth | the heat map: "115 million pixels per eye" dropping to 34 |
| 2:08-2:26 | **Anyone** | The fastest cuts of every world, one or two beats each, building to the song's peak | quick numbers flashing on the cuts: Aug 2026 · 48 views · 290,000 · 3.1 s |
| 2:26-2:53 | **Home** | The song drops to the guitar. Ian and his grandma again: she says something warm, he answers, he sits with her; he lifts the headset off; the chair across from him is empty | none |
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

## Voiceover

Recorded last, over the finished cut, section by section, after Claude hands over the cut. Short, calm, close; it says
what the picture can't, and the numbers live on screen. Ian says only his own words.

## Music

"Lucid Dreams" plays from YouTube on Devpost, and it's copyrighted twice over (Juice WRLD, and the Sting sample). Upload
a 30-second unlisted test with it tonight: YouTube Studio shows "Copyright claim" and whether it's blocked anywhere.
Only claimed: use it. Blocked or muted: a licensed track (CapCut's commercial library, Pixabay Music, the YouTube Audio
Library). Put the audio file in `music/`.

## On screen, always

"AI voice" whenever grandma or Vishal speaks; the legends' and Federer's labels whenever they're in frame; the blue
Reality check explained once. Every number is a measured one (from `demo/devpost.md`).
