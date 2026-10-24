using System.Collections.Generic;
using System.Linq;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace LucidDreams
{
    // The playback rail from Atina's handoff (demo/quest-ui): 0.82 x 0.11 m, 0.65 m in front of you and 0.65 m below
    // your eyes, following lazily but holding still while a hand is near. Speed, Previous, a 72 mm blue Play/Pause,
    // Next (in a lesson: Again too), Reality check, Bring here and Library, then a labelled timeline you pinch-drag
    // (32 mm touch corridor, a tick when the seek lands). Wraps to two rows when the controls don't fit.
    public class DreamControlBar : MonoBehaviour
    {
        const float Width = 820f;
        const float RowHeight = 110f;
        const float SecondRow = 72f;
        const float Edge = 20f;
        const float Gap = 18f;
        const float Target = 64f;
        const float PlaySize = 72f;
        const float TimeLabel = 64f;

        public Transform head;
        public HandTracker hands;
        public DreamSequencePlayer player;
        public DreamPlacer placer;
        public DreamLibraryPanel library;
        public DreamLibrary dreams;

        [Tooltip("Meters in front of the eyes, and below them.")]
        public float forward = 0.65f, below = 0.65f;
        [Tooltip("Degrees the rail leans back so it faces your eyes.")]
        public float tilt = 40f;
        public float followAngle = 35f, followDistance = 0.3f;
        [Tooltip("Seconds the Play button keeps its text label after a dream loads (first use).")]
        public float labelSeconds = 20f;

        FingertipButton play, speed, previous, next, again, reality, bring, browse;
        readonly List<FingertipButton> all = new();
        Image playIcon, pauseLeft, pauseRight;
        TMP_Text playLabel, speedHint, elapsed, total;
        string layout;
        float height = RowHeight, trackWidth, rowY;
        RectTransform panel, shadow, track, fill, knob;
        RectTransform canvasRect;
        RealityPopover popover;
        AudioSource tick;
        bool following = true;
        float labelUntil;
        DreamBundle labelledFor;

        void Start()
        {
            var canvas = GlassUI.WorldCanvas(transform, "Rail", new Vector2(Width, RowHeight));
            canvasRect = (RectTransform)canvas.transform;
            shadow = (RectTransform)GlassUI.Shadow(canvas.transform, Vector2.zero, new Vector2(Width, RowHeight), GlassUI.Corner).transform;
            panel = (RectTransform)GlassUI.Box(canvas.transform, "Rail surface", Vector2.zero, new Vector2(Width, RowHeight), GlassUI.Surface, GlassUI.Corner).transform;

            speed = Button("Speed", () => player.CycleSpeed());
            speedHint = GlassUI.Label(speed.transform, "Hint", new Vector2(0f, -19f), new Vector2(Target, 10f), "Speed", 7.5f, GlassUI.SecondaryText,
                TextAlignmentOptions.Center, FontWeight.Medium);
            speed.label.fontSize = 15f;
            ((RectTransform)speed.label.transform).anchoredPosition = new Vector2(0f, 5f);

            previous = IconButton("Previous", false, () => Step(-1));
            play = Button("Pause", () => player.TogglePlay(), PlaySize, PlaySize / 2f);
            play.restColor = GlassUI.Accent;
            play.onColor = play.focusColor = GlassUI.Hex(0x0a84ff, 1f);
            playIcon = GlassUI.Shape(play.transform, "Play icon", GlassUI.Triangle, new Vector2(3f, 6f), new Vector2(26f, 26f), Color.white);
            pauseLeft = GlassUI.Shape(play.transform, "Pause left", GlassUI.Rounded, new Vector2(-6f, 6f), new Vector2(7f, 24f), Color.white);
            pauseRight = GlassUI.Shape(play.transform, "Pause right", GlassUI.Rounded, new Vector2(6f, 6f), new Vector2(7f, 24f), Color.white);
            playLabel = play.label;
            playLabel.fontSize = 9f;
            ((RectTransform)playLabel.transform).anchoredPosition = new Vector2(0f, -20f);
            next = IconButton("Next", true, () => Step(+1));
            again = Button("Again", () => player.Lesson?.Again());
            reality = Button("Reality check", () => popover.Toggle());
            bring = Button("Bring here", () => placer.PlaceInFrontOfViewer());
            browse = Button("Library", () => library?.Toggle());

            track = (RectTransform)GlassUI.Box(panel, "Track", Vector2.zero, new Vector2(100f, 5f), GlassUI.Track, 2.5f).transform;
            fill = (RectTransform)GlassUI.Box(panel, "Played", Vector2.zero, new Vector2(0f, 5f), GlassUI.Text, 2.5f).transform;
            fill.pivot = new Vector2(0f, 0.5f);
            knob = (RectTransform)GlassUI.Box(panel, "Knob", Vector2.zero, new Vector2(13f, 13f), GlassUI.Text, 6.5f).transform;
            elapsed = GlassUI.Label(panel, "Elapsed", Vector2.zero, new Vector2(TimeLabel, 12f), "", 8.5f, GlassUI.SecondaryText, TextAlignmentOptions.Left, FontWeight.Medium);
            total = GlassUI.Label(panel, "Duration", Vector2.zero, new Vector2(TimeLabel, 12f), "", 8.5f, GlassUI.SecondaryText, TextAlignmentOptions.Right, FontWeight.Medium);

            popover = new RealityPopover(panel, hands, player);

            tick = gameObject.AddComponent<AudioSource>();
            tick.playOnAwake = false;
            tick.spatialBlend = 0f;
            tick.volume = 0.35f;
            tick.clip = TickClip();
            Layout(new List<FingertipButton> { speed, previous, play, next, reality, bring, browse });
        }

        FingertipButton Button(string label, System.Action pressed, float width = Target, float corner = GlassUI.Corner)
        {
            var b = FingertipButton.Create(panel, hands, label, Vector2.zero, new Vector2(width, Target), corner);
            b.label.fontSize = 11f;
            b.label.textWrappingMode = TextWrappingModes.Normal;
            b.Pressed += pressed;
            all.Add(b);
            return b;
        }

        // Previous / Next: a bar and a triangle, with the word under it.
        FingertipButton IconButton(string label, bool forwardArrow, System.Action pressed)
        {
            var b = Button(label, pressed);
            b.label.fontSize = 8f;
            ((RectTransform)b.label.transform).anchoredPosition = new Vector2(0f, -19f);
            float s = forwardArrow ? 1f : -1f;
            GlassUI.Shape(b.transform, "Arrow", GlassUI.Triangle, new Vector2(-3f * s, 6f), new Vector2(20f, 20f), GlassUI.Text, forwardArrow ? 0f : 180f);
            GlassUI.Shape(b.transform, "Bar", GlassUI.Rounded, new Vector2(8f * s, 6f), new Vector2(4f, 18f), GlassUI.Text);
            return b;
        }

        // In a lesson: the previous or next step. Otherwise the previous or next person on this headset.
        void Step(int direction)
        {
            if (player.Lesson != null) player.Lesson.Go(player.Lesson.Index + direction);
            else dreams?.PlayAdjacent(direction);
        }

        // A pinch-drag seek just landed: a short tick confirms it.
        public void SeekLanded() => tick.Play();

        void LateUpdate()
        {
            Follow();
            Refresh();
        }

        // Pinches in the timeline's 32 mm corridor scrub; the result is 0-1 along the track.
        public bool TryTimeline(Vector3 world, out float normalized)
        {
            normalized = 0f;
            if (canvasRect == null) return false;
            var local = canvasRect.InverseTransformPoint(world);
            float y = TrackY;
            normalized = Mathf.Clamp01((local.x + trackWidth / 2f) / trackWidth);
            return Mathf.Abs(local.x) < trackWidth / 2f + 15f && Mathf.Abs(local.y - y) < 16f && Mathf.Abs(local.z) < 40f;
        }

        // World position of a point along the timeline (0-1), on the rail's face.
        public Vector3 TimelinePoint(float normalized) =>
            canvasRect.TransformPoint(new Vector3(-trackWidth / 2f + trackWidth * Mathf.Clamp01(normalized), TrackY, 0f));

        float TrackY => -height / 2f + 17f;

        // True when the point is on or just in front of the rail or its popover: pinches there belong to them.
        public bool Contains(Vector3 world)
        {
            if (canvasRect == null) return false;
            var local = canvasRect.InverseTransformPoint(world);
            bool rail = Mathf.Abs(local.x) < Width / 2f + 20f && Mathf.Abs(local.y) < height / 2f + 20f && local.z > -60f && local.z < 40f;
            return rail || popover.Contains(local);
        }

        bool Playback(FingertipButton b) => b == speed || b == previous || b == play || b == next || b == again;

        IEnumerable<List<FingertipButton>> Rows(IReadOnlyList<FingertipButton> visible)
        {
            float row = visible.Sum(ButtonWidth) + Gap * (visible.Count - 1);
            if (row <= Width - 2 * Edge) { yield return visible.ToList(); yield break; }
            yield return visible.Where(Playback).ToList();
            yield return visible.Where(b => !Playback(b)).ToList();
        }

        float ButtonWidth(FingertipButton b) =>
            b == play ? PlaySize : b == speed || b == previous || b == next ? Target
            : Mathf.Max(Target, b.label.GetPreferredValues(b == reality ? "Reality check" : b.label.text).x + 28f);

        void Layout(IReadOnlyList<FingertipButton> visible)
        {
            var rows = Rows(visible).ToList();
            height = RowHeight + SecondRow * (rows.Count - 1);
            canvasRect.sizeDelta = panel.sizeDelta = new Vector2(Width, height);
            shadow.sizeDelta = new Vector2(Width + 20f, height + 20f);
            foreach (var b in all) b.gameObject.SetActive(visible.Contains(b));

            rowY = height / 2f - 8f - Target / 2f;
            float y = rowY;
            foreach (var row in rows)
            {
                float rowWidth = row.Sum(ButtonWidth) + Gap * (row.Count - 1);
                float x = -rowWidth / 2f;
                foreach (var b in row)
                {
                    float w = ButtonWidth(b);
                    b.Resize(new Vector2(w, b == play ? PlaySize : Target));
                    ((RectTransform)b.transform).anchoredPosition = new Vector2(x + w / 2f, y);
                    x += w + Gap;
                }
                y -= SecondRow;
            }
            // The words that sit under icons keep their place after a resize.
            ((RectTransform)speed.label.transform).anchoredPosition = new Vector2(0f, 5f);
            ((RectTransform)previous.label.transform).anchoredPosition = new Vector2(0f, -19f);
            ((RectTransform)next.label.transform).anchoredPosition = new Vector2(0f, -19f);
            ((RectTransform)playLabel.transform).anchoredPosition = new Vector2(0f, -20f);

            trackWidth = Width - 2 * Edge - 2 * (TimeLabel + 8f);
            float ty = TrackY;
            track.sizeDelta = new Vector2(trackWidth, 5f);
            track.anchoredPosition = new Vector2(0f, ty);
            fill.anchoredPosition = new Vector2(-trackWidth / 2f, ty);
            ((RectTransform)elapsed.transform).anchoredPosition = new Vector2(-Width / 2f + Edge + TimeLabel / 2f, ty);
            ((RectTransform)total.transform).anchoredPosition = new Vector2(Width / 2f - Edge - TimeLabel / 2f, ty);
            popover.Anchor(((RectTransform)reality.transform).anchoredPosition.x, height / 2f);
        }

        void Refresh()
        {
            if (player == null) return;
            bool ready = player.IsReady;
            var lesson = player.Lesson;

            var visible = new List<FingertipButton> { speed, previous, play, next };
            if (lesson != null) visible.Add(again);
            visible.AddRange(new[] { reality, bring });
            if (library != null) visible.Add(browse);
            string signature = string.Join(",", visible.Select(b => b.name));
            if (signature != layout)
            {
                layout = signature;
                Layout(visible);
            }

            play.interactable = speed.interactable = again.interactable = ready;
            previous.interactable = next.interactable = ready && (lesson != null || (dreams != null && dreams.PlayableCount > 1));
            previous.SetLabel(lesson != null ? "Previous step" : "Previous");
            next.SetLabel(lesson != null ? "Next step" : "Next");

            // Play / Pause: the icon always, the word on first use (the first seconds of each dream).
            if (player.Dream != labelledFor && ready)
            {
                labelledFor = player.Dream;
                labelUntil = Time.unscaledTime + labelSeconds;
            }
            play.SetLabel(player.IsPlaying ? "Pause" : "Play");
            playLabel.alpha = Time.unscaledTime < labelUntil ? 1f : 0f;
            playIcon.enabled = !player.IsPlaying;
            pauseLeft.enabled = pauseRight.enabled = player.IsPlaying;
            float iconY = Time.unscaledTime < labelUntil ? 6f : 0f;
            playIcon.rectTransform.anchoredPosition = new Vector2(3f, iconY);
            pauseLeft.rectTransform.anchoredPosition = new Vector2(-6f, iconY);
            pauseRight.rectTransform.anchoredPosition = new Vector2(6f, iconY);

            speed.SetLabel(player.Speed >= 1f ? "1×" : player.Speed >= 0.5f ? "0.5×" : "0.25×");
            speed.on = false;
            reality.on = popover.IsOpen;
            browse.on = library != null && library.IsOpen;

            float t = ready ? player.NormalizedTime : 0f;
            fill.sizeDelta = new Vector2(trackWidth * t, 5f);
            knob.anchoredPosition = new Vector2(-trackWidth / 2f + trackWidth * t, TrackY);
            elapsed.text = ready ? Clock(player.NormalizedTime * player.Duration) : "";
            total.text = ready ? Clock(player.Duration) : "";
            popover.Refresh();
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

            // Hold still while a hand is at the rail, so it never runs away from a fingertip.
            bool touching = false;
            foreach (var hand in hands.Hands)
                touching |= (hand.Has(UnityEngine.XR.Hands.XRHandJointID.IndexTip) && Contains(hand.IndexTip)) || (hand.tracked && Contains(hand.pinchPoint));
            Vector3 railFlat = Vector3.ProjectOnPlane(transform.forward, Vector3.up);
            if (!following && !touching &&
                (Vector3.Angle(railFlat, flat) > followAngle || Vector3.Distance(transform.position, targetPos) > followDistance))
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

        // 18 ms of a soft click: the seek landed.
        static AudioClip TickClip()
        {
            const int rate = 44100, n = rate * 18 / 1000;
            var data = new float[n];
            for (int i = 0; i < n; i++)
            {
                float t = (float)i / rate;
                data[i] = Mathf.Sin(2f * Mathf.PI * 2400f * t) * Mathf.Exp(-t * 320f) * 0.6f;
            }
            var clip = AudioClip.Create("Seek tick", n, 1, rate, false);
            clip.SetData(data, 0);
            return clip;
        }
    }

    // Reality check, as Atina specified: a 0.36 m card above the rail (never over the person's face) that always says
    // how much the camera saw, with one toggle, "Show imagined detail", that tints only the bundle's source-unseen
    // representation blue. Without reality data it hides the toggle and says so.
    public class RealityPopover
    {
        const float W = 360f;
        const float H = 196f;
        const float Pad = 22f;

        public bool IsOpen => root.activeSelf;

        readonly GameObject root;
        readonly RectTransform rect;
        readonly TMP_Text title, line, unavailable;
        readonly FingertipButton toggle;
        readonly Image switchTrack, switchKnob;
        readonly DreamSequencePlayer player;

        public RealityPopover(Transform rail, HandTracker hands, DreamSequencePlayer player)
        {
            this.player = player;
            var go = new GameObject("Reality check", typeof(RectTransform));
            go.transform.SetParent(rail, false);
            rect = (RectTransform)go.transform;
            rect.sizeDelta = new Vector2(W, H);
            root = go;
            GlassUI.Shadow(go.transform, Vector2.zero, new Vector2(W, H), GlassUI.Corner);
            GlassUI.Box(go.transform, "Card", Vector2.zero, new Vector2(W, H), GlassUI.Hex(0x161617, 0.88f), GlassUI.Corner);
            float w = W - 2 * Pad;
            title = GlassUI.Label(go.transform, "Title", new Vector2(0f, H / 2f - Pad - 10f), new Vector2(w, 20f), "Reality check", 16f, GlassUI.Text,
                TextAlignmentOptions.Left);
            line = GlassUI.Label(go.transform, "Seen", new Vector2(0f, H / 2f - Pad - 40f), new Vector2(w, 30f), "", 11f, GlassUI.Text,
                TextAlignmentOptions.TopLeft, FontWeight.Regular);
            line.textWrappingMode = TextWrappingModes.Normal;
            unavailable = GlassUI.Label(go.transform, "Unavailable", new Vector2(0f, -H / 2f + Pad + 32f), new Vector2(w, 40f),
                "Reality data is unavailable for this dream.", 11f, GlassUI.SecondaryText, TextAlignmentOptions.Left, FontWeight.Regular);
            unavailable.textWrappingMode = TextWrappingModes.Normal;

            toggle = FingertipButton.Create(go.transform, hands, "Show imagined detail", new Vector2(0f, -H / 2f + Pad + 32f), new Vector2(w, 64f), GlassUI.Corner);
            toggle.label.alignment = TextAlignmentOptions.Left;
            toggle.label.fontSize = 12f;
            toggle.label.margin = new Vector4(18f, 0f, 70f, 0f);
            toggle.onColor = GlassUI.Raised; // the switch shows the state; the row stays calm
            toggle.Pressed += () => player.ToggleReality();
            switchTrack = GlassUI.Shape(toggle.transform, "Switch", GlassUI.Rounded, new Vector2(w / 2f - 40f, 0f), new Vector2(46f, 26f), GlassUI.Track);
            switchTrack.type = Image.Type.Sliced;
            switchTrack.pixelsPerUnitMultiplier = 32f / 13f;
            switchKnob = GlassUI.Shape(toggle.transform, "Knob", GlassUI.Rounded, new Vector2(w / 2f - 50f, 0f), new Vector2(22f, 22f), Color.white);
            go.SetActive(false);
        }

        public void Anchor(float x, float railTop)
        {
            // above the rail, over the Reality check control, and inside the rail's width
            float cx = Mathf.Clamp(x, -410f + W / 2f, 410f - W / 2f);
            rect.anchoredPosition = new Vector2(cx, railTop + 14f + H / 2f);
        }

        public void Toggle() => root.SetActive(!root.activeSelf);

        public bool Contains(Vector3 railLocal)
        {
            if (!root.activeSelf) return false;
            var p = (Vector2)railLocal - rect.anchoredPosition;
            return Mathf.Abs(p.x) < W / 2f + 15f && Mathf.Abs(p.y) < H / 2f + 15f && railLocal.z > -60f && railLocal.z < 40f;
        }

        public void Refresh()
        {
            if (!root.activeSelf || player == null) return;
            bool has = player.HasReality;
            float seen = player.SeenFraction;
            line.text = seen >= 0f ? $"{Mathf.RoundToInt(seen * 100f)}% seen by the camera · blue was imagined"
                : has ? "Blue was imagined" : "";
            toggle.gameObject.SetActive(has);
            unavailable.gameObject.SetActive(!has);
            if (!has) return;

            bool on = player.ShowingReality;
            toggle.interactable = !player.RealityLoading && player.RealityError == null;
            toggle.SetLabel(player.RealityLoading ? $"Loading imagined detail… {Mathf.RoundToInt(player.RealityProgress * 100f)}%"
                : player.RealityError != null ? "Imagined detail couldn't load" : "Show imagined detail");
            toggle.on = on;
            switchTrack.color = on ? GlassUI.Accent : GlassUI.Track;
            switchKnob.rectTransform.anchoredPosition = new Vector2((W - 2 * Pad) / 2f - (on ? 30f : 50f), 0f);
        }
    }
}
