using System.Linq;
using System.Text.RegularExpressions;
using UnityEngine;

namespace LucidDreams
{
    // Someone who sits to do what you came for (the piano teacher next to you) sits at a real bench height, not on the
    // floor. The reconstruction puts its lowest point on the floor: for a pianist whose legs the camera never saw (they
    // were behind the piano) that's their hips, so they're raised until their hips are at bench height; when their legs
    // are there, their feet stay on the floor and the bench goes under their hips. Either way a simple piano bench is
    // built under them unless the reconstruction kept one.
    public readonly struct Seating
    {
        public const float BenchHeight = 0.48f; // a piano bench, top of the cushion
        public const float BenchWidth = 0.76f, BenchDepth = 0.36f;
        const float StandingHeight = 1.45f; // taller than this from the lowest point to the top, they're standing
        const float NoLegs = 0.3f; // less than this from the lowest point up to the seat: no legs under the hips
        const float HighestSeat = 0.65f;
        const float OnTheFloor = 0.05f; // a lowest point this close to the bundle's floor is their feet on it
        const float BenchKept = 0.02f; // this share of the person under the seat is a bench the camera kept

        public readonly bool seated;
        public readonly bool legs; // their legs are in the reconstruction, feet on the floor
        public readonly float lift; // how far the person is raised above their bundle's floor (negative: lowered)
        public readonly float benchTop; // above your floor
        public readonly bool needsBench;
        public readonly Vector2 benchAt; // x, z of the bench's centre, bundle space

        public Seating(bool legs, float lift, float benchTop, bool needsBench, Vector2 benchAt)
        {
            seated = true;
            this.legs = legs;
            this.lift = lift;
            this.benchTop = benchTop;
            this.needsBench = needsBench;
            this.benchAt = benchAt;
        }

        // The plan or the sentence says they sit (a bench in the plan's objects, a piano, "sit"), and their shape agrees.
        public static Seating For(BodyShape body, Experience experience, string intent)
        {
            if (!body.Valid || !WantsSeat(experience, intent) || body.Height > StandingHeight) return default;
            float hips = body.seat - body.low;
            bool legs = hips >= NoLegs;
            float lift;
            if (!legs) lift = BenchHeight - body.seat;
            else if (hips <= HighestSeat) lift = Mathf.Abs(body.low) < OnTheFloor ? 0f : -body.low; // their own feet on the floor
            else return default;
            // the back of the bench just behind their hips: people sit on the front of a piano bench
            var at = new Vector2(body.axis.x, body.seatBack + 0.04f - BenchDepth / 2f);
            return new Seating(legs, lift, body.seat + lift, body.underSeat < BenchKept, at);
        }

        static readonly Regex SeatWords = new(@"\b(bench|chair|stool|seat|sofa|couch|piano|organ|harp|cello|drums?)\b");
        static readonly Regex SitsToDoIt = new(@"\b(sit|sits|sitting|seated|piano|pianist|keyboard|organ|harp|cello|drums?)\b");

        public static bool WantsSeat(Experience experience, string intent)
        {
            if (experience?.objects != null && experience.objects.Any(o => o != null && SeatWords.IsMatch(o.ToLowerInvariant()))) return true;
            string said = (experience?.intent ?? intent)?.ToLowerInvariant();
            return said != null && SitsToDoIt.IsMatch(said);
        }
    }
}
