using UnityEngine;

namespace LucidDreams
{
    // Hands-only control of the person, matched to the WebXR app's feel:
    //   quick pinch anywhere: play / pause
    //   pinch on the person and drag: move them along the floor; with both hands, turn them
    //   pinch and hold ~0.9 s pointing at the floor: they stand there, facing you
    //   pinch the timeline and drag: scrub (fingertip buttons on the bar handle the rest)
    public class DreamHands : MonoBehaviour
    {
        const float TapMaxS = 0.35f;
        const float TapMaxMove = 0.025f;
        const float LongPinchS = 0.9f;
        const float PersonRadius = 0.45f;
        const float TogetherS = 0.4f; // two pinches this close in time are one two-handed grab

        public HandTracker hands;
        public DreamPlacer placer;
        [Tooltip("A second person counts as the person too: pinching either moves both.")]
        public DreamCompanion companion;
        public DreamSequencePlayer player;
        public DreamControlBar bar;
        public DreamLibraryPanel library;
        public Transform head;
        [Tooltip("Height of the person used for grabbing until the bundle says otherwise.")]
        public float personHeight = 1.9f;

        enum Mode { None, Bar, Scrub, PendingPerson, Grab, PendingRoom }

        class State
        {
            public Mode mode;
            public float since;
            public Vector3 start;
            public Vector3 rootAtStart;
            public float yawAtStart;
            public bool fresh; // grabbing, but its motion since the pinch began isn't applied yet
        }

        readonly State left = new(), right = new();
        Vector3 grabRootStart, grabPointStart;
        float grabYawStart, twoHandAngleStart;
        Vector3 twoHandMidStart;
        bool twoHanded;

        void Update()
        {
            Handle(hands.left, left);
            Handle(hands.right, right);
            ApplyGrab();
        }

        void Handle(HandTracker.Hand hand, State s)
        {
            var p = hand.pinchPoint;
            if (hand.pinchStarted)
            {
                s.since = Time.time;
                s.start = p;
                s.rootAtStart = placer.transform.position;
                s.yawAtStart = placer.transform.eulerAngles.y;
                if (bar != null && bar.TryTimeline(p, out _)) s.mode = Mode.Scrub;
                else if ((bar != null && bar.Contains(p)) || (library != null && library.Contains(p))) s.mode = Mode.Bar;
                else s.mode = OnPerson(p) ? Mode.PendingPerson : Mode.PendingRoom;
            }

            if (hand.pinching)
            {
                float held = Time.time - s.since;
                float moved = Vector3.Distance(p, s.start);
                switch (s.mode)
                {
                    case Mode.Scrub:
                        if (player != null && player.IsReady && bar.TryTimeline(p, out float t))
                        {
                            player.Pause();
                            player.Scrub(t);
                        }
                        break;
                    case Mode.PendingPerson:
                        if (moved > TapMaxMove || held > TapMaxS)
                        {
                            s.mode = Mode.Grab;
                            s.fresh = true;
                            BeginGrab();
                        }
                        break;
                    case Mode.PendingRoom:
                        if (moved > TapMaxMove * 2f) s.mode = Mode.None;
                        else if (held > LongPinchS)
                        {
                            placer.PlaceAt(FloorPointAlong(p));
                            s.mode = Mode.None;
                        }
                        break;
                }
            }

            if (hand.pinchEnded)
            {
                bool tap = (s.mode == Mode.PendingPerson || s.mode == Mode.PendingRoom) && Time.time - s.since <= TapMaxS;
                if (tap && player != null) player.TogglePlay();
                if (s.mode == Mode.Scrub && bar != null) bar.SeekLanded(); // a tick confirms where the seek landed
                bool wasGrabbing = s.mode == Mode.Grab;
                s.mode = Mode.None;
                if (wasGrabbing) BeginGrab(); // the other hand, if still holding, carries on from here
            }
            if (!hand.tracked && s.mode != Mode.None)
            {
                s.mode = Mode.None;
                BeginGrab();
            }
        }

        bool OnPerson(Vector3 p)
        {
            var root = placer.transform.position;
            float height = player != null && player.Dream?.bounds != null && player.Dream.bounds.Height > 0.5f
                ? player.Dream.bounds.Height : personHeight;
            height += placer.Lift;
            if (p.y < root.y - 0.1f || p.y > root.y + height + 0.15f) return false;
            var flat = new Vector2(p.x - root.x, p.z - root.z);
            if (flat.magnitude < PersonRadius) return true;
            if (companion == null || !companion.Present) return false;
            var second = companion.transform.position;
            return new Vector2(p.x - second.x, p.z - second.z).magnitude < PersonRadius;
        }

        // Captures the starting poses for however many hands are grabbing now. A hand that has just become a grab
        // counts from where its pinch began, so the first couple of centimetres of a drag or turn aren't lost.
        void BeginGrab()
        {
            bool l = left.mode == Mode.Grab, r = right.mode == Mode.Grab;
            twoHanded = l && r;
            grabRootStart = placer.transform.position;
            grabYawStart = placer.transform.eulerAngles.y;
            Vector3 lp = left.fresh ? left.start : hands.left.pinchPoint;
            Vector3 rp = right.fresh ? right.start : hands.right.pinchPoint;

            if (twoHanded)
            {
                if ((left.fresh || right.fresh) && Mathf.Abs(left.since - right.since) < TogetherS)
                {
                    // Both pinched together: undo any one-handed head start and treat it as two-handed from the beginning.
                    var first = left.since <= right.since ? left : right;
                    grabRootStart = first.rootAtStart;
                    grabYawStart = first.yawAtStart;
                    lp = left.start;
                    rp = right.start;
                }
                twoHandMidStart = (lp + rp) * 0.5f;
                twoHandAngleStart = FlatAngle(rp - lp);
            }
            else if (l || r)
            {
                var s = l ? left : right;
                if (s.fresh)
                {
                    grabRootStart = s.rootAtStart;
                    grabYawStart = s.yawAtStart;
                }
                grabPointStart = l ? lp : rp;
            }
            if (l) left.fresh = false;
            if (r) right.fresh = false;
        }

        void ApplyGrab()
        {
            bool l = left.mode == Mode.Grab, r = right.mode == Mode.Grab;
            if (!l && !r) return;
            if ((l && r) != twoHanded) BeginGrab();

            if (twoHanded)
            {
                var mid = (hands.left.pinchPoint + hands.right.pinchPoint) * 0.5f;
                float turn = Mathf.DeltaAngle(twoHandAngleStart, FlatAngle(hands.right.pinchPoint - hands.left.pinchPoint));
                placer.MoveTo(grabRootStart + Flat(mid - twoHandMidStart), grabYawStart + turn);
            }
            else
            {
                var point = l ? hands.left.pinchPoint : hands.right.pinchPoint;
                placer.MoveTo(grabRootStart + Flat(point - grabPointStart), grabYawStart);
            }
        }

        // Where the line from your eyes through the pinch meets the floor: point at a spot to send them there.
        Vector3 FloorPointAlong(Vector3 pinch)
        {
            var dir = pinch - head.position;
            float floor = placer.FloorY;
            if (dir.y < -0.05f)
            {
                float t = (floor - head.position.y) / dir.y;
                var hit = head.position + dir * t;
                if (Vector3.Distance(Flat(hit), Flat(head.position)) < 6f) return hit;
            }
            return head.position + Flat(dir).normalized * placer.distance;
        }

        static Vector3 Flat(Vector3 v) => new(v.x, 0f, v.z);
        static float FlatAngle(Vector3 v) => Mathf.Atan2(v.x, v.z) * Mathf.Rad2Deg;
    }
}
