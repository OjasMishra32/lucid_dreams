# The showcase: five moments

Each moment is one person, one sentence of intent, and what happens around you. Everything below runs on what's
built; "Status" says what's real tonight. Sources are all freely licensed or our own (see `demo/credits.md`).

| # | Moment | Person and source | Intent | Where | Around them |
| --- | --- | --- | --- | --- | --- |
| 1 | **Piano lesson, side by side** | Jason Han, piano teacher, at an upright (Wikimedia Commons, CC BY-SA 4.0) | "sit next to me and teach me this piece" | Your room, or the concert hall | Bench and piano, steps slowed down, your turn after each |
| 2 | **LeBron in your driveway** | LeBron's jump shot (clip supplied for this non-commercial demo, not redistributed) | "teach me this jump shot" | Your room, or the court | The real ball in his hands, a regulation hoop where he aims |
| 3 | **Chess with the legends** | Bobby Fischer (Nationaal Archief, CC0), Magnus Carlsen (Wikimedia, CC BY-SA 3.0) | "play chess with me" | Your table | Seated across a real-size board, moving their own pieces, a chess clock; Stockfish at their peak rating, labelled |
| 4 | **Someone you've lost** | A teammate's family photo or home video (written consent) | "I just want to sit with her" | Your living room | Her voice from where she sits, her words as captions |
| 5 | **You, perfected** | Your own photo + LeBron's motion | "show me doing it" | The court | Your body doing his shot |

## How each one is made

- **Clips** go through `pipeline/lucid/find_windows.py` when they're long (it finds 5 seconds with one person, whole
  body, still camera), then the normal replay pipeline at 12 GPUs.
- **Photos** become avatars (DiGS-Avatar, needs DINOv3) and can play any motion.
- **The plan** (`experience.json`) comes from Gemini (Raami) or, until then, from the sentence alone.
- **Props** (`props.json`): the ball and hoop for basketball now; piano and bench next.
- **Places**: one fingertip button swaps your room for a 360-degree environment (Poly Haven, CC0): concert hall,
  court, boxing ring, studio.

## What makes it read as real (check every one before filming)

- Feet on the floor, life size, never floating; a soft contact shadow.
- Hands and face hold up at 1.5 m: no smear while they move.
- Your real hands stay in front of them when you reach out.
- Reality check shows what was imagined, in blue, honestly.
- No public figure speaks or is shown endorsing anything.
