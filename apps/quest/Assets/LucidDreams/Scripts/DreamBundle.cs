using System;
using UnityEngine;

namespace LucidDreams
{
    // Mirrors dream.json from the shared bundle contract in AGENTS.md. Field names match the JSON exactly.
    [Serializable]
    public class DreamBundle
    {
        public string id;
        public string name;
        public string kind; // "replay" or "avatar"
        public float fps;
        public int frameCount;
        public float durationS;
        public string units;
        public string upAxis;
        public DreamBounds bounds;
        public DreamFrames frames;
        public DreamAvatar avatar;
        public string audio;
        public string voice; // the speaking voice alone; players prefer it over audio
        public string preview;
        public string thumb;
        public DreamSource source;
        public DreamMetrics metrics;
        public string createdAt;

        public bool IsReplay => kind == "replay";
        public bool IsAvatar => kind == "avatar";

        public static DreamBundle FromJson(string json) => JsonUtility.FromJson<DreamBundle>(json);

        // Path of a replay frame inside the bundle, relative to the bundle root, e.g. "frames/000000.ply".
        public string FramePath(int index) => FramePath(index, frames?.pattern);

        // Same, for another per-frame pattern such as frames.spz or frames.reality.
        public string FramePath(int index, string pattern)
        {
            if (frames == null || string.IsNullOrEmpty(frames.dir) || string.IsNullOrEmpty(pattern)) return null;
            return $"{frames.dir}/{FormatPattern(pattern, index)}";
        }

        // Supports the printf-style "%06d.ply" pattern the pipeline writes.
        static string FormatPattern(string pattern, int index)
        {
            if (string.IsNullOrEmpty(pattern)) pattern = "%06d.ply";
            int start = pattern.IndexOf('%');
            int end = pattern.IndexOf('d', start + 1);
            if (start < 0 || end < 0) return pattern;
            string width = pattern.Substring(start + 1, end - start - 1).TrimStart('0');
            int pad = string.IsNullOrEmpty(width) ? 0 : int.Parse(width);
            return pattern.Substring(0, start) + index.ToString().PadLeft(pad, '0') + pattern.Substring(end + 1);
        }
    }

    [Serializable]
    public class DreamBounds
    {
        public float[] min;
        public float[] max;

        public Vector3 Min => min != null && min.Length == 3 ? new Vector3(min[0], min[1], min[2]) : Vector3.zero;
        public Vector3 Max => max != null && max.Length == 3 ? new Vector3(max[0], max[1], max[2]) : Vector3.zero;
        public float Height => Max.y - Min.y;
    }

    [Serializable]
    public class DreamFrames
    {
        public string dir;
        public string pattern; // full-quality PLY, SH degree 1
        public string spz; // about 10x smaller, colour only
        public string reality; // SPZ with unseen Gaussians tinted blue, for "seen vs imagined"
        public int gaussiansPerFrame;
        public long spzBytesTotal;
    }

    [Serializable]
    public class DreamAvatar
    {
        public string file;
        public string rig;
        public string motion;
        public string skin;
        public string skeleton;
        public string reality; // same Gaussians, imagined ones tinted blue
    }

    [Serializable]
    public class DreamSource
    {
        public string clip;
        public int width;
        public int height;
    }

    [Serializable]
    public class DreamMetrics
    {
        public float psnr;
        public float ssim;
        public float lpips;
        public int views;
        public float seenFraction;
    }
}
