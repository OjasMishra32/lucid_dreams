"""The film's timeline, cut to the song: every cut is a downbeat (or a beat) of "Lucid Dreams" at 84 BPM, its sections
carry the acts, and the hook lands as Ian's story ends. Writes demo/film/timeline.json for cut2.py.

  python3 demo/film/timeline.py && avatars/.venv/bin/python demo/film/cut2.py demo/film/timeline.json --out film-v1.mp4

Song facts (scan/grid.json, demucs stems in music/stems): 84.000 BPM, a downbeat every 2.857 s from 0.14 s; 8-bar
phrases at 23.0, 45.85, 68.71, 91.57 (soft 68.7-91.6), 114.4, 137.3 (soft 137.3-160.1), 160.1; the hook's first line
starts 22.52 s. The song starts at film O seconds, so its downbeats in the film are bar(n).
"""

import json
from pathlib import Path

O = 5.1  # the song's 0 in film time: the hook (22.52) lands at 27.62, its downbeat (23.0) at 28.1
P = 60 / 84


def bar(n: float) -> float:
    return round(O + 0.14 + n * 4 * P, 3)


LENGTH = 180.0
ANATOMY_IN = 2.0  # where the anatomy render's modes start changing
V: list[dict] = []
T: list[dict] = []
A: list[dict] = []


def shot(src, start, x="cut", xd=0.0, inp=0.0, grade=None, speed=1.0, zoom=None, fit="cover", interp=False):
    """A piece from `start` to the next piece's start. Headset footage is graded; the film's own graphics are not."""
    if grade is None:
        grade = src.startswith(("selects/", "quest/", "phone/"))
    v = {"src": src, "in": inp, "start": round(start, 3), "x": x, "xd": xd, "grade": grade, "speed": speed, "fit": fit}
    if zoom:
        v["zoom"] = zoom
    if interp:
        v["interp"] = True
    V.append(v)


def say(text, at, dur, pos="lower", size=34, color="#f5f5f7", weight="semibold"):
    T.append({"text": text, "at": round(at, 3), "dur": dur, "pos": pos, "size": size, "color": color, "weight": weight})


def sound(src, at, dur, inp=0.0, gain=0.0, bus="bed", fadein=0.0, fadeout=0.0):
    A.append({"src": src, "in": inp, "at": round(at, 3), "dur": dur, "gain": gain, "bus": bus, "fadein": fadein,
              "fadeout": fadeout})


# ---- Four years: three plain lines say what's happening; the song's guitar comes in alone (vocals removed); he speaks,
# she answers, both in big English captions (the Vietnamese small under them); a breath; the hook, then the title ---
CAP = dict(size=42)                                                     # what they say, in English: the line you read
VI = dict(pos="lower2", size=24, color="#a1a1a6", weight="medium")     # their own words, under it
shot("black", 0.0)
say("Ian hasn't been home in four years.", 0.4, 3.0, pos="center", size=50)
shot("phone/open-2.mov", bar(-1), "dissolve", 1.0, inp=1.4, zoom=[1.0, 1.05])           # his phone, her video
say("He has a video of his grandmother.", bar(-1) + 0.5, 3.2, size=40)
shot("phone/open-1.mov", bar(0), "dissolve", 0.7, inp=3.0, zoom=[1.0, 1.04])            # his eye
shot("phone/open-3.mov", bar(1), "dissolve", 0.6, inp=5.0)                              # the headset goes on
say("So we brought her into his room.", bar(1) + 0.4, 2.4, size=40)
shot("motion/source-grandma.mp4", bar(2), "dissolve", 0.6)                              # her video -> her, here
shot("selects/grandma-ian.mp4", bar(3.25), "cut", inp=0.1)                              # he talks to her
say("“Grandma, I miss you so much. It's been four years since I've been home.”", bar(3.25) + 0.35, 4.7, **CAP)
say("Bà ơi, con nhớ bà nhiều lắm. 4 năm rồi con chưa về.", bar(3.25) + 0.35, 4.7, **VI)
shot("selects/grandma-reply.mp4", bar(5), "dissolve", 0.9, inp=0.05)                    # she answers (the wait, cut)
say("“I know, dear. I miss you every day. Tell me what you're doing!”", bar(5) + 0.4, 4.0, **CAP)
say("Bà biết, con. Bà nhớ con từng ngày. Hãy cho bà biết con đang làm gì nhé!", bar(5) + 0.4, 4.0, **VI)
say("AI voice, cloned with her family's consent", bar(5) + 0.4, 4.0, pos="upper", size=20, color="#a1a1a6", weight="medium")
shot("selects/grandma-stand.mp4", bar(6.5), "dissolve", 1.0, speed=0.7)                 # a breath: her, in his room

# ---- How a person is made: the whole Meta Quest 3S animation, one video -> 48 views, the fit, the Gaussians
# themselves (ellipses, centres, the skeleton), the honest blue, and the theme answered -------------------------------
shot("motion/title.mp4", bar(8), "dip", 0.8)
shot("motion/headset-full.mp4", bar(9), "dissolve", 0.5, inp=0.2)                      # parts -> headset -> its eyes -> her
shot("motion/cameras.mp4", bar(12), "cut", inp=2.0)
shot("motion/fit.mp4", bar(13.5), "cut", inp=3.5)
shot("motion/anatomy.mp4", bar(15), "cut", inp=5.0)
shot("motion/reality.mp4", bar(17), "cut", inp=0.6)
shot("motion/frontier.mp4", bar(18), "dissolve", 0.5)                                  # "Fresh off the frontier."

# ---- Learn: Gemma writes the lesson from one sentence; the guitar video becomes a teacher; golf, your hit ----------
shot("motion/gemma.mp4", bar(20), "dissolve", 0.4, inp=0.6)
shot("motion/source-guitar.mp4", bar(21.25), "dissolve", 0.5)
shot("selects/guitar-lesson.mp4", bar(23.75), "cut", inp=0.8)
shot("selects/golf-swing.mp4", bar(24.5), "cut", inp=0.1)                             # his swing beside you
shot("selects/golf-hit.mp4", bar(25.25), "cut", speed=0.62, interp=True)               # yours, through the ball

# ---- Bobby: his photos, him rebuilt, your move, his move, him -----------------------------------------------------
shot("motion/source-bobby.mp4", bar(26.25), "dip", 0.8)
say("Ojasva learned chess from Bobby Fischer's games.", bar(26.25) + 0.3, 1.6, pos="upper", size=30, color="#a1a1a6", weight="medium")
shot("motion/bobby.mp4", bar(28.25), "dissolve", 0.6, inp=2.0)                        # six photos -> a body
shot("selects/chess-you-bobby.mp4", bar(29.5), "dissolve", 0.5)                        # your move: lift, place, clock
shot("selects/bobby-reach1.mp4", bar(30.5), "cut", speed=0.95)                         # his move
shot("selects/bobby-steady.mp4", bar(31.5), "dissolve", 0.5, speed=0.8)
LEGEND = dict(pos="lower-right", size=20, color="#d2d2d7", weight="medium")
say("Stockfish at Fischer's peak rating. Not affiliated.", bar(29.5) + 0.3, bar(33) - bar(29.5) - 0.6, **LEGEND)

# ---- Play: Magnus, Federer, LeBron, Court Side ----------------------------------------------------------------------
shot("motion/magnus.mp4", bar(33), "cut", inp=2.0)                                     # fourteen photos -> Magnus
shot("selects/chess-you-magnus.mp4", bar(34), "cut")                                  # you take his piece
shot("selects/magnus-look.mp4", bar(35), "cut", speed=0.93)                           # he looks up at you
say("Stockfish at Carlsen's peak rating. Not affiliated.", bar(34) + 0.2, bar(35.75) - bar(34) - 0.4, **LEGEND)
shot("selects/tennis-shake.mp4", bar(35.75), "dissolve", 0.4)                         # Federer, at the net
shot("selects/tennis-face.mp4", bar(36.75), "cut", speed=0.8)
shot("selects/tennis-serve.mp4", bar(37.5), "cut")                                     # your serve
shot("selects/tennis-rally.mp4", bar(38), "cut", inp=2.6)                              # his return, your forehand
say("Roger Federer's likeness. AI opponent, not affiliated.", bar(35.75) + 0.2, bar(39) - bar(35.75) - 0.4, **LEGEND)
shot("selects/lebron-dribble.mp4", bar(39), "cut")                                    # LeBron, dribbling at you
shot("selects/lebron-catch.mp4", bar(40), "cut", inp=0.1)                              # his pass, your catch
shot("selects/lebron-score.mp4", bar(40.75), "cut")                                    # and you score
say("His likeness, from his footage. Not affiliated.", bar(39) + 0.2, bar(41.5) - bar(39) - 0.4, **LEGEND)
shot("selects/court-game.mp4", bar(41.5), "dissolve", 0.4)                             # the real play, on the screen
shot("selects/court-walk.mp4", bar(42.5), "cut")                                       # step in, walk around it
shot("selects/court-gobert.mp4", bar(44.25), "cut")                                    # round Gobert, frozen
shot("motion/court-orbit.mp4", bar(45), "dissolve", 0.4, inp=2.4)                      # the same moment, rebuilt
say("Real footage, rebuilt in 3D. Not affiliated with the NBA or the players.", bar(41.5) + 0.3, bar(46) - bar(41.5) - 0.6, **LEGEND)

# ---- Talk: 14 frames of his video -> Vishal, then a conversation --------------------------------------------------
shot("motion/avatar.mp4", bar(46), "dissolve", 0.4, inp=1.0)
shot("selects/vishal-ask-reply.mp4", bar(48), "cut")
say("“Hey Vishal, how are you doing?”", bar(48) + 0.9, 1.9, size=40)
say("“Hey! Not much, just excited to chat and share about Lucid Dreams. How about you?”", bar(48) + 4.3, 4.0, size=34)
say("AI voice · his own, cloned with his consent", bar(48) + 4.3, 4.0, pos="lower2", size=22, color="#a1a1a6", weight="medium")
shot("motion/headset-heat.mp4", bar(51), "dissolve", 0.5, inp=10.0)                   # and it runs on a headset

# ---- Home: the quiet section, the hook once more ---------------------------------------------------------------------
shot("selects/grandma-calm.mp4", bar(52), "dissolve", 1.0, speed=0.7)
shot("selects/bobby-face.mp4", bar(52.75), "dissolve", 0.8, inp=1.6, speed=0.7)
shot("phone/end-ian.mov", bar(53.75), "dissolve", 0.8, inp=0.3, zoom=[1.0, 1.03])
shot("phone/end-ojas.mov", bar(55.25), "dissolve", 0.6, inp=0.6, speed=0.8, zoom=[1.0, 1.03])
shot("motion/lineup.mp4", bar(56), "dip", 0.8)                                         # everyone we made
shot("motion/end.mp4", bar(58), "dip", 0.8)

# ---- sound: no room hiss; the music low under the voices (room for the voiceover); one gain, never squashed ------
M, I, VOC = "music/lucid-dreams.mp3", "music/stems/no_vocals.mp3", "music/stems/vocals.mp3"
sound(I, O, 22.5, inp=0.0, gain=-15, fadein=3.0)                                                   # the guitar, alone
sound(M, O + 22.5, bar(10) + 0.4 - (O + 22.5), inp=22.5, gain=-9, fadeout=0.8)                    # the hook
sound(I, bar(10) - 0.4, bar(48) - bar(10) + 0.4, inp=bar(10) - 0.4 - O, gain=-13, fadein=0.8)     # under the voiceover
sound(I, bar(48), bar(58) - bar(48), inp=bar(48) - O, gain=-14, fadeout=0.8)                      # the quiet section
sound(VOC, bar(53) - 0.48, 6.1, inp=22.52, gain=-12, fadein=0.2, fadeout=1.2)                     # the hook, once more
sound(M, bar(58), LENGTH - bar(58), inp=228.71, gain=-11, fadein=0.6, fadeout=2.5)                # the song's own end
sound("quest/grandma-1.mp4", bar(3.25), 5.1, inp=8.5, gain=9, bus="voice")                         # Ian
sound("quest/grandma-1.mp4", bar(5), 4.2, inp=18.95, gain=7, bus="voice")                          # Grandma
sound("selects/vishal-ask-reply.mp4", bar(48), 8.6, gain=2, bus="voice")                           # you, then Vishal
sound("selects/guitar-lesson.mp4", bar(23.75), bar(24.5) - bar(23.75), inp=0.8, gain=-12, fadein=0.2, fadeout=0.2)
sound("selects/tennis-serve.mp4", bar(37.5), bar(38) - bar(37.5), gain=-5, fadeout=0.1)
sound("selects/tennis-rally.mp4", bar(38), bar(39) - bar(38), inp=2.6, gain=-5, fadeout=0.3)
sound("selects/lebron-catch.mp4", bar(40), bar(40.75) - bar(40), inp=0.1, gain=-9)
sound("selects/lebron-score.mp4", bar(40.75), bar(41.5) - bar(40.75), gain=-9, fadeout=0.2)
sound("selects/golf-hit.mp4", bar(25.25), bar(26.25) - bar(25.25), gain=-6, fadeout=0.3)

out = {"fps": 30, "length": LENGTH, "video": V, "text": T, "audio": A}
for k, v in enumerate(V):
    v["end"] = V[k + 1]["start"] if k + 1 < len(V) else LENGTH
Path(__file__).with_name("timeline.json").write_text(json.dumps(out, indent=1))
print(f"{len(V)} pieces, {len(T)} lines of type, {len(A)} sounds; hook at {O + 22.52:.2f} s, downbeat {bar(8):.2f} s")
for v in V:
    print(f"  {v['start']:7.2f}-{v['end']:7.2f}  {v['x']:8s} {v['src']}")
