using System.Collections.Generic;
using System.Linq;
using TMPro;
using UnityEngine;

namespace LucidDreams
{
    // The playback bar: floats low in front of you like a tablet held at chest height (within fingertip reach),
    // tilted toward your eyes, and follows lazily when you turn or walk away. The person stays where they stand.
    // In a lesson, Back / Again / Next take the speed button's place; Reality check appears for bundles that have it.
    public class DreamControlBar : MonoBehaviour
    {
        const float Height = 92f;
        const float MinWidth = 364f;
        const float Edge = 20f; // panel padding left and right
        const float Gap = 8f;
        const float ButtonHeight = 28f;
        const float TrackY = -30f;

        public Transform head;
        public HandTracker hands;
        public DreamSequencePlayer player;
        public DreamPlacer placer;

        [Tooltip("Meters in front of the eyes, and below them.")]
        public float forward = 0.45f, below = 0.32f;
        [Tooltip("Degrees the bar leans back so it faces your eyes.")]
        public float tilt = 35f;
        public float followAngle = 35f, followDistance = 0.3f;

        FingertipButton play, speed, back, again, next, reality, bring;
        readonly List<FingertipButton> all = new();
        string layout;
        float width, trackWidth;
        TMP_Text title, clock;
        RectTransform panel, track, fill, knob;
        RectTransform canvasRect;
        bool following = true;

        void Start()
        {
            var canvas = GlassUI.WorldCanvas(transform, "Controls", new Vector2(MinWidth, Height));
            canvasRect = (RectTransform)canvas.transform;
            panel = (RectTransform)GlassUI.Box(canvas.transform, "Panel", Vector2.zero, new Vector2(MinWidth, Height), GlassUI.Panel, 24f).transform;

            title = GlassUI.Label(panel, "Title", Vector2.zero, new Vector2(200f, 14f), "", 9f, GlassUI.Text, TextAlignmentOptions.Left);
            clock = GlassUI.Label(panel, "Clock", Vector2.zero, new Vector2(70f, 14f), "", 8f, GlassUI.SecondaryText,
                TextAlignmentOptions.Right, FontWeight.Medium);

            play = Button("Pause", () => player.TogglePlay());
            speed = Button("1×", () => player.CycleSpeed());
            back = Button("Back", () => player.Lesson?.Go(player.Lesson.Index - 1));
            again = Button("Again", () => player.Lesson?.Again());
            next = Button("Next", () => player.Lesson?.Go(player.Lesson.Index + 1));
            reality = Button("Reality check", () => player.ToggleReality());
            bring = Button("Bring here", () => placer.PlaceInFrontOfViewer());

            track = (RectTransform)GlassUI.Box(panel, "Track", Vector2.zero, new Vector2(100f, 6f), GlassUI.Track, 3f).transform;
            fill = (RectTransform)GlassUI.Box(panel, "Played", Vector2.zero, new Vector2(0f, 6f), GlassUI.Text, 3f).transform;
            fill.pivot = new Vector2(0f, 0.5f);
            knob = (RectTransform)GlassUI.Box(panel, "Knob", Vector2.zero, new Vector2(14f, 14f), GlassUI.Text, 7f).transform;
            Layout(new[] { play, speed, bring });
        }

        FingertipButton Button(string label, System.Action pressed)
        {
            var b = FingertipButton.Create(panel, hands, label, Vector2.zero, new Vector2(80f, ButtonHeight));
            b.Pressed += pressed;
            all.Add(b);
            return b;
        }

        void LateUpdate()
        {
            Follow();
            Refresh();
        }

        // Pinches near the timeline scrub; the result is 0-1 along the track.
        public bool TryTimeline(Vector3 world, out float normalized)
        {
            normalized = 0f;
            if (canvasRect == null) return false;
            var local = canvasRect.InverseTransformPoint(world);
            normalized = Mathf.Clamp01((local.x + trackWidth / 2f) / trackWidth);
            return Mathf.Abs(local.x) < trackWidth / 2f + 15f && Mathf.Abs(local.y - TrackY) < 16f && Mathf.Abs(local.z) < 40f;
        }

        // World position of a point along the timeline (0-1), on the bar's face.
        public Vector3 TimelinePoint(float normalized) =>
            canvasRect.TransformPoint(new Vector3(-trackWidth / 2f + trackWidth * Mathf.Clamp01(normalized), TrackY, 0f));

        // True when the point is on or just in front of the bar: pinches there belong to the bar, not the room.
        public bool Contains(Vector3 world)
        {
            if (canvasRect == null) return false;
            var local = canvasRect.InverseTransformPoint(world);
            return Mathf.Abs(local.x) < width / 2f + 20f && Mathf.Abs(local.y) < Height / 2f + 20f && local.z > -60f && local.z < 40f;
        }

        // Lays the visible buttons out in one row, each sized to its label, and sizes the panel and timeline to fit.
        void Layout(IReadOnlyList<FingertipButton> visible)
        {
            var widths = visible.Select(b => Mathf.Max(58f, b.label.GetPreferredValues(Widest(b)).x + 26f)).ToArray();
            float row = widths.Sum() + Gap * (visible.Count - 1);
            width = Mathf.Max(MinWidth, row + 2 * Edge);
            trackWidth = width - 2 * Edge;
            canvasRect.sizeDelta = panel.sizeDelta = new Vector2(width, Height);

            foreach (var b in all) b.gameObject.SetActive(visible.Contains(b));
            float x = -row / 2f;
            for (int i = 0; i < visible.Count; i++)
            {
                var rt = (RectTransform)visible[i].transform;
                rt.sizeDelta = new Vector2(widths[i], ButtonHeight);
                ((RectTransform)visible[i].label.transform).sizeDelta = rt.sizeDelta;
                rt.anchoredPosition = new Vector2(x + widths[i] / 2f, 4f);
                x += widths[i] + Gap;
            }

            float textWidth = width - 2 * Edge;
            ((RectTransform)title.transform).sizeDelta = new Vector2(textWidth - 76f, 14f);
            ((RectTransform)title.transform).anchoredPosition = new Vector2(-38f, 30f);
            ((RectTransform)clock.transform).anchoredPosition = new Vector2(textWidth / 2f - 35f, 30f);
            track.sizeDelta = new Vector2(trackWidth, 6f);
            track.anchoredPosition = new Vector2(0f, TrackY);
            fill.anchoredPosition = new Vector2(-trackWidth / 2f, TrackY);
        }

        // Buttons whose label changes are sized for their longest label, so the row never jumps.
        string Widest(FingertipButton b) =>
            b == play ? "Pause" : b == speed ? "0.25×" : b == reality ? "Reality check" : b.label.text;

        void Refresh()
        {
            bool ready = player != null && player.IsReady;
            if (player == null) return;
            var lesson = player.Lesson;

            var visible = new List<FingertipButton> { play };
            if (lesson != null) visible.AddRange(new[] { back, again, next });
            else visible.Add(speed);
            if (player.HasReality) visible.Add(reality);
            visible.Add(bring);
            string signature = string.Join(",", visible.Select(b => b.name));
            if (signature != layout)
            {
                layout = signature;
                Layout(visible);
            }

            play.interactable = speed.interactable = back.interactable = again.interactable = next.interactable = ready;
            if (player.Error != null) title.text = "Couldn't load this dream";
            else if (!ready) title.text = $"Loading {Mathf.RoundToInt(player.LoadProgress * 100f)}%";
            else if (player.ShowingReality)
                title.text = player.SeenFraction >= 0f
                    ? $"{Mathf.RoundToInt(player.SeenFraction * 100f)}% seen by the camera · blue was imagined"
                    : "Blue was imagined";
            else title.text = !string.IsNullOrEmpty(player.Experience?.title) ? player.Experience.title : player.Dream.name;

            reality.interactable = player.HasReality && !player.RealityLoading && player.RealityError == null;
            reality.on = player.ShowingReality;
            reality.SetLabel(player.RealityLoading ? $"Loading {Mathf.RoundToInt(player.RealityProgress * 100f)}%"
                : player.RealityError != null ? "Unavailable" : "Reality check");

            play.SetLabel(player.IsPlaying ? "Pause" : "Play");
            speed.SetLabel(player.Speed >= 1f ? "1×" : player.Speed >= 0.5f ? "0.5×" : "0.25×");
            speed.on = player.Speed < 1f;

            float t = ready ? player.NormalizedTime : 0f;
            fill.sizeDelta = new Vector2(trackWidth * t, 6f);
            knob.anchoredPosition = new Vector2(-trackWidth / 2f + trackWidth * t, TrackY);
            clock.text = ready ? $"{Clock(player.NormalizedTime * player.Duration)} / {Clock(player.Duration)}" : "";
        }

        static string Clock(float seconds) => $"{(int)seconds / 60}:{seconds % 60f:00.0}";

        void Follow()
        {
            if (head == null || head.position == Vector3.zero) return;
            Vector3 flat = Vector3.ProjectOnPlane(head.forward, Vector3.up);
            if (flat.sqrMagnitude < 1e-4f) return;
            flat.Normalize();
            var targetPos = head.position + flat * forward + Vector3.down * below;
            var targetRot = Quaternion.LookRotation(flat, Vector3.up) * Quaternion.Euler(tilt, 0f, 0f);

            // Hold still while a finger is at the bar; otherwise drift back once you've turned or walked away.
            bool touching = false;
            foreach (var hand in hands.Hands)
                touching |= hand.Has(UnityEngine.XR.Hands.XRHandJointID.IndexTip) && Contains(hand.IndexTip);
            Vector3 barFlat = Vector3.ProjectOnPlane(transform.forward, Vector3.up);
            if (!following && !touching &&
                (Vector3.Angle(barFlat, flat) > followAngle || Vector3.Distance(transform.position, targetPos) > followDistance))
                following = true;
            if (touching) following = false;

            if (transform.position == Vector3.zero) transform.SetPositionAndRotation(targetPos, targetRot);
            else if (following)
            {
                float k = 1f - Mathf.Exp(-6f * Time.deltaTime);
                transform.SetPositionAndRotation(Vector3.Lerp(transform.position, targetPos, k), Quaternion.Slerp(transform.rotation, targetRot, k));
                if (Vector3.Distance(transform.position, targetPos) < 0.01f && Quaternion.Angle(transform.rotation, targetRot) < 1f) following = false;
            }
        }
    }
}
