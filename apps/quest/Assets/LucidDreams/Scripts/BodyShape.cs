using System;
using UnityEngine;

namespace LucidDreams
{
    // Where a person's body actually is in one frame, read from its Gaussians (bundle space: meters, +Y up, floor y = 0):
    // the lowest and highest points (robust percentiles, so a few stray Gaussians don't count), the torso's vertical axis
    // (the centre of the chest band) and where the torso column ends at the bottom, which for a seated person is the
    // seat. Pure maths on the decoded frame, so it runs on the loader's worker threads.
    public readonly struct BodyShape
    {
        public readonly float low, top;
        public readonly Vector2 axis; // x, z of the torso's vertical axis
        public readonly float seat; // bottom of the torso column
        public readonly float seatBack; // z of the back of the hips at the seat (the back is +Z; the front faces -Z)
        public readonly float underSeat; // share of the Gaussians right under the seat (a bench in the reconstruction)
        public float Height => top - low;
        public bool Valid => top > low;

        public BodyShape(float low, float top, Vector2 axis, float seat, float seatBack, float underSeat)
        {
            this.low = low;
            this.top = top;
            this.axis = axis;
            this.seat = seat;
            this.seatBack = seatBack;
            this.underSeat = underSeat;
        }

        const float MinOpacity = 0.3f; // faint Gaussians aren't body
        const float AxisRadius = 0.13f; // the torso column, around the chest's centre
        const float UnderRadius = 0.2f;

        public static BodyShape Measure(GaussianFrame f)
        {
            int n = f.count;
            if (n == 0) return default;
            var a = f.attributes;
            const int stride = GaussianFrame.FloatsPerGaussian;

            // Height percentiles from a 1 cm histogram over -1..3 m.
            const float lo = -1f, cm = 0.01f;
            var bins = new int[400];
            int solid = 0;
            for (int i = 0; i < n; i++)
            {
                if (a[i * stride + 3] < MinOpacity) continue;
                int b = Mathf.Clamp((int)((a[i * stride + 1] - lo) / cm), 0, bins.Length - 1);
                bins[b]++;
                solid++;
            }
            if (solid < 50) return default;
            float Percentile(float p)
            {
                int want = Mathf.Max(1, (int)(solid * p)), seen = 0;
                for (int b = 0; b < bins.Length; b++)
                    if ((seen += bins[b]) >= want) return lo + (b + 0.5f) * cm;
                return lo + bins.Length * cm;
            }
            float low = Percentile(0.003f), top = Percentile(0.997f);

            // The chest band (a little below the shoulders) gives the torso's axis.
            float bandHi = top - 0.3f, bandLo = top - 0.55f;
            double sx = 0, sz = 0;
            int inBand = 0;
            for (int i = 0; i < n; i++)
            {
                int o = i * stride;
                float y = a[o + 1];
                if (a[o + 3] < MinOpacity || y < bandLo || y > bandHi) continue;
                sx += a[o];
                sz += a[o + 2];
                inBand++;
            }
            if (inBand == 0) return new BodyShape(low, top, Vector2.zero, low, 0f, 0f);
            var axis = new Vector2((float)(sx / inBand), (float)(sz / inBand));

            // Down the torso column: its lowest dense level is the seat (or, standing, the crotch / between the feet).
            var column = new int[bins.Length];
            int inColumn = 0;
            for (int i = 0; i < n; i++)
            {
                int o = i * stride;
                if (a[o + 3] < MinOpacity) continue;
                float dx = a[o] - axis.x, dz = a[o + 2] - axis.y;
                if (dx * dx + dz * dz > AxisRadius * AxisRadius) continue;
                column[Mathf.Clamp((int)((a[o + 1] - lo) / cm), 0, bins.Length - 1)]++;
                inColumn++;
            }
            // The seat: scanning down from the chest, the first 4 cm with almost nothing in the column.
            int chest = Mathf.Clamp((int)((bandLo - lo) / cm), 0, bins.Length - 1);
            float seat = low;
            float perCm = inColumn / Mathf.Max(1f, (top - low) / cm);
            for (int b = chest; b >= 4; b--)
            {
                int gap = column[b] + column[b - 1] + column[b - 2] + column[b - 3];
                if (gap < perCm * 0.15f * 4) { seat = lo + (b + 1) * cm; break; }
            }

            // The back of the hips: the rearmost few percent of what sits just above the seat.
            var behind = new System.Collections.Generic.List<float>();
            for (int i = 0; i < n; i++)
            {
                int o = i * stride;
                float y = a[o + 1];
                if (a[o + 3] < MinOpacity || y < seat || y > seat + 0.1f) continue;
                if (Mathf.Abs(a[o] - axis.x) > 0.25f || Mathf.Abs(a[o + 2] - axis.y) > 0.4f) continue;
                behind.Add(a[o + 2]);
            }
            behind.Sort();
            float seatBack = behind.Count > 0 ? behind[(int)(behind.Count * 0.97f)] : axis.y;

            // What's right under the seat, between it and the floor: a bench, if the camera kept one.
            int under = 0;
            for (int i = 0; i < n; i++)
            {
                int o = i * stride;
                float y = a[o + 1];
                if (a[o + 3] < MinOpacity || y < low + 0.08f || y > seat - 0.06f) continue;
                float dx = a[o] - axis.x, dz = a[o + 2] - axis.y;
                if (dx * dx + dz * dz <= UnderRadius * UnderRadius) under++;
            }
            return new BodyShape(low, top, axis, seat, seatBack, (float)under / solid);
        }

        // The middle value of each measure over all frames: steady, whatever a single frame does.
        public static BodyShape Median(BodyShape[] shapes)
        {
            var valid = Array.FindAll(shapes, s => s.Valid);
            if (valid.Length == 0) return default;
            float Mid(Func<BodyShape, float> f)
            {
                var v = Array.ConvertAll(valid, s => f(s));
                Array.Sort(v);
                return v[v.Length / 2];
            }
            return new BodyShape(Mid(s => s.low), Mid(s => s.top), new Vector2(Mid(s => s.axis.x), Mid(s => s.axis.y)),
                Mid(s => s.seat), Mid(s => s.seatBack), Mid(s => s.underSeat));
        }
    }
}
