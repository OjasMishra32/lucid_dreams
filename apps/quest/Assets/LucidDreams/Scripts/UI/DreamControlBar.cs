using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace LucidDreams
{
    // The playback bar: floats low in front of you like a tablet held at chest height (within fingertip reach),
    // tilted toward your eyes, and follows lazily when you turn or walk away. The person stays where they stand.
    public class DreamControlBar : MonoBehaviour
    {
        static readonly Vector2 Size = new(364f, 92f);
        const float TrackWidth = 324f;
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

        FingertipButton play, speed, reality, bring;
        TMP_Text title, clock;
        RectTransform fill, knob;
        RectTransform canvasRect;
        bool following = true;

        void Start()
        {
            var canvas = GlassUI.WorldCanvas(transform, "Controls", Size);
            canvasRect = (RectTransform)canvas.transform;
            var panel = GlassUI.Box(canvas.transform, "Panel", Vector2.zero, Size, GlassUI.Panel, 24f).transform;

            title = GlassUI.Label(panel, "Title", new Vector2(-37f, 30f), new Vector2(270f, 14f), "", 9f, GlassUI.Text, TextAlignmentOptions.Left);
            clock = GlassUI.Label(panel, "Clock", new Vector2(132f, 30f), new Vector2(70f, 14f), "", 8f, GlassUI.SecondaryText,
                TextAlignmentOptions.Right, FontWeight.Medium);

            var button = new Vector2(80f, 28f);
            play = FingertipButton.Create(panel, hands, "Pause", new Vector2(-132f, 4f), button);
            speed = FingertipButton.Create(panel, hands, "1×", new Vector2(-44f, 4f), button);
            reality = FingertipButton.Create(panel, hands, "Reality check", new Vector2(44f, 4f), button);
            bring = FingertipButton.Create(panel, hands, "Bring here", new Vector2(132f, 4f), button);
            play.Pressed += () => player.TogglePlay();
            speed.Pressed += () => player.CycleSpeed();
            reality.Pressed += () => player.ToggleReality();
            bring.Pressed += () => placer.PlaceInFrontOfViewer();

            GlassUI.Box(panel, "Track", new Vector2(0f, TrackY), new Vector2(TrackWidth, 6f), GlassUI.Track, 3f);
            fill = (RectTransform)GlassUI.Box(panel, "Played", new Vector2(-TrackWidth / 2f, TrackY), new Vector2(0f, 6f), GlassUI.Text, 3f).transform;
            fill.pivot = new Vector2(0f, 0.5f);
            knob = (RectTransform)GlassUI.Box(panel, "Knob", new Vector2(-TrackWidth / 2f, TrackY), new Vector2(14f, 14f), GlassUI.Text, 7f).transform;
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
            normalized = Mathf.Clamp01((local.x + TrackWidth / 2f) / TrackWidth);
            return Mathf.Abs(local.x) < TrackWidth / 2f + 15f && Mathf.Abs(local.y - TrackY) < 16f && Mathf.Abs(local.z) < 40f;
        }

        // World position of a point along the timeline (0-1), on the bar's face.
        public Vector3 TimelinePoint(float normalized) =>
            canvasRect.TransformPoint(new Vector3(-TrackWidth / 2f + TrackWidth * Mathf.Clamp01(normalized), TrackY, 0f));

        // True when the point is on or just in front of the bar: pinches there belong to the bar, not the room.
        public bool Contains(Vector3 world)
        {
            if (canvasRect == null) return false;
            var local = canvasRect.InverseTransformPoint(world);
            return Mathf.Abs(local.x) < Size.x / 2f + 20f && Mathf.Abs(local.y) < Size.y / 2f + 20f && local.z > -60f && local.z < 40f;
        }

        void Refresh()
        {
            bool ready = player != null && player.IsReady;
            play.interactable = speed.interactable = ready;
            if (player == null) return;

            if (player.Error != null) title.text = "Couldn't load this dream";
            else if (!ready) title.text = $"Loading {Mathf.RoundToInt(player.LoadProgress * 100f)}%";
            else if (player.ShowingReality)
                title.text = player.SeenFraction >= 0f
                    ? $"{Mathf.RoundToInt(player.SeenFraction * 100f)}% seen by the camera · blue was imagined"
                    : "Blue was imagined";
            else title.text = player.Dream.name;

            // Only bundles that ship reality frames get the toggle.
            reality.gameObject.SetActive(player.HasReality);
            reality.interactable = player.HasReality && !player.RealityLoading && player.RealityError == null;
            reality.on = player.ShowingReality;
            reality.SetLabel(player.RealityLoading ? $"Loading {Mathf.RoundToInt(player.RealityProgress * 100f)}%"
                : player.RealityError != null ? "Unavailable" : "Reality check");

            play.SetLabel(player.IsPlaying ? "Pause" : "Play");
            speed.SetLabel(player.Speed >= 1f ? "1×" : player.Speed >= 0.5f ? "0.5×" : "0.25×");
            speed.on = player.Speed < 1f;

            float t = ready ? player.NormalizedTime : 0f;
            fill.sizeDelta = new Vector2(TrackWidth * t, 6f);
            knob.anchoredPosition = new Vector2(-TrackWidth / 2f + TrackWidth * t, TrackY);
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
