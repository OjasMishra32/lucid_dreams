using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Text.RegularExpressions;

namespace LucidDreams
{
    // What the person says, from the bundle's captions.vtt (WebVTT, in the clip's own time), as in apps/webxr's captions.ts.
    public static class Captions
    {
        public readonly struct Cue
        {
            public readonly float start, end;
            public readonly string text;
            public Cue(float start, float end, string text) { this.start = start; this.end = end; this.text = text; }
        }

        static readonly Regex Tags = new("<[^>]+>");

        public static List<Cue> Parse(string vtt)
        {
            var cues = new List<Cue>();
            foreach (var block in Regex.Split(vtt.Replace("\r", ""), @"\n{2,}"))
            {
                var lines = block.Split('\n');
                int at = Array.FindIndex(lines, l => l.Contains("-->"));
                if (at < 0) continue;
                var parts = lines[at].Split(new[] { "-->" }, StringSplitOptions.None);
                string text = WebUtility.HtmlDecode(Tags.Replace(string.Join("\n", lines.Skip(at + 1)), "")).Trim();
                string end = parts[1].Trim().Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries)[0];
                if (text.Length > 0) cues.Add(new Cue(Seconds(parts[0]), Seconds(end), text));
            }
            return cues.OrderBy(c => c.start).ToList();
        }

        public static string At(List<Cue> cues, float t)
        {
            foreach (var c in cues)
                if (t >= c.start && t < c.end) return c.text;
            return null;
        }

        // "01:02.345" or "00:01:02.345"
        static float Seconds(string stamp) =>
            stamp.Trim().Split(':').Aggregate(0f, (acc, part) => acc * 60f + float.Parse(part, CultureInfo.InvariantCulture));
    }
}
