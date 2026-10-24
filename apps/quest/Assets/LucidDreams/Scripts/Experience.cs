using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using UnityEngine;

namespace LucidDreams
{
    // What you came to do with this person: the plan written from your intent ("teach me this strum") by the
    // experience step (Gemini on the bridge), stored as the bundle's experience.json. Contract: AGENTS.md, "Experience".
    [Serializable]
    public class Experience
    {
        public string intent;
        public string mode; // teach, watch, companion, play
        public string title;
        public string summary;
        public string place; // facing (default), beside, ahead
        public string environment; // a place around the person (concert-hall, court, gym, ring, studio, mountains) or "room"
        public List<string> objects = new(); // what matters for the intent ("piano", "bench"); props.json builds them
        public List<ExperienceStep> steps = new();
        public ExperiencePlay play;

        public bool IsTeach => mode == "teach" && steps.Count > 0;

        public static Experience FromJson(string json, float duration)
        {
            var e = JsonUtility.FromJson<Experience>(json);
            if (e == null || string.IsNullOrEmpty(e.mode)) return null;
            e.Clean(duration);
            return e;
        }

        // Steps in clip order, inside the clip, never empty.
        public void Clean(float duration)
        {
            steps = (steps ?? new List<ExperienceStep>())
                .Where(s => s != null && !float.IsNaN(s.start) && !float.IsNaN(s.end))
                .Select(s => { s.end = Mathf.Min(s.end, duration); return s; })
                .Where(s => s.end > s.start)
                .OrderBy(s => s.start)
                .ToList();
        }

        // Until the experience step has written a plan, the intent alone still shapes what happens (as in the WebXR
        // app): "teach me / show me / how to" becomes a lesson in equal parts, "chess" a game, "sit with / miss" a
        // companion. Generic on purpose; Gemini's plan replaces it.
        public static Experience Fallback(string intent, float duration)
        {
            intent = intent?.Trim();
            if (string.IsNullOrEmpty(intent)) return null;
            string said = intent.ToLowerInvariant();
            if (Regex.IsMatch(said, @"\bchess\b"))
                return new Experience { intent = intent, mode = "play", play = new ExperiencePlay { game = "chess", strength = "gm" } };
            if (Regex.IsMatch(said, @"\b(teach|learn|show me|how (do|to)|practi[cs]e|coach)\b"))
            {
                int parts = duration >= 3f ? 3 : 2;
                float len = duration / parts;
                var e = new Experience
                {
                    intent = intent,
                    mode = "teach",
                    title = char.ToUpperInvariant(intent[0]) + intent.Substring(1),
                    // an instrument is learned sitting next to the teacher; a movement by following them; else face to face
                    place = Regex.IsMatch(said, @"\b(piano|keyboard|guitar|violin|cello|drums|ukulele|instrument|play this song|play this piece)\b") ? "beside"
                        : Regex.IsMatch(said, @"\b(dance|move|shoot|swing|throw|kick|form|step)\b") ? "ahead" : "facing",
                };
                for (int i = 0; i < parts; i++)
                    e.steps.Add(new ExperienceStep
                    {
                        start = i * len, end = (i + 1) * len, title = $"Part {i + 1}",
                        tip = i == 0 ? "Watch it slowly, then copy it." : "Same again: watch, then your turn.",
                        speed = 0.5f, repeat = 2,
                    });
                return e;
            }
            if (Regex.IsMatch(said, @"\b(be with|sit with|stay with|miss|talk|hug|remember)\b"))
                return new Experience { intent = intent, mode = "companion", place = "facing" };
            return new Experience { intent = intent, mode = "watch" };
        }
    }

    [Serializable]
    public class ExperienceStep
    {
        public float start; // seconds in the bundle's clip time
        public float end;
        public string title;
        public string tip;
        public float speed; // playback speed while you watch (0 or missing: 0.5)
        public int repeat; // plays before your turn (0 or missing: 2)

        public float Speed => speed > 0f ? speed : 0.5f;
        public int Repeat => repeat > 0 ? repeat : 2;
    }

    [Serializable]
    public class ExperiencePlay
    {
        public string game;
        public string strength;
    }

    // A lesson, as in the WebXR app: each step plays slowed down a couple of times, then the person freezes in the
    // step's last pose for your turn (as long as the move takes at full speed, plus a breath), then the next step.
    // After the last step it starts over.
    public class Lesson
    {
        public const float TurnBreathS = 1.5f;

        public readonly IReadOnlyList<ExperienceStep> steps;
        public int Index { get; private set; }
        public int Rep { get; private set; }
        public bool YourTurn { get; private set; }
        public ExperienceStep Step => steps[Index];

        // Fires when the step or phase changes; true when the step should be said again even if unchanged.
        public event Action<bool> Changed;

        float turnEnds, turnLength;

        public Lesson(IReadOnlyList<ExperienceStep> steps) => this.steps = steps;

        public void Go(int index, bool again = false)
        {
            Index = ((index % steps.Count) + steps.Count) % steps.Count;
            Rep = 0;
            YourTurn = false;
            Changed?.Invoke(again);
        }

        public void Again() => Go(Index, true);

        // Called each frame with the clip time after this frame's advance; returns where playback should be.
        public float Update(float t, float now)
        {
            var s = Step;
            if (YourTurn)
            {
                if (now < turnEnds) return Frozen(s); // frozen in the last pose of the move
                Go(Index + 1);
                return Step.start;
            }
            if (t >= s.end)
            {
                Rep++;
                if (Rep >= s.Repeat)
                {
                    YourTurn = true;
                    turnLength = s.end - s.start + TurnBreathS;
                    turnEnds = now + turnLength;
                    Changed?.Invoke(false);
                    return Frozen(s);
                }
                return s.start;
            }
            return t < s.start ? s.start : t;
        }

        // 0 -> 1 through your turn.
        public float TurnProgress(float now) => YourTurn ? Mathf.Clamp01(1f - (turnEnds - now) / turnLength) : 0f;

        static float Frozen(ExperienceStep s) => s.end - 0.001f;
    }
}
