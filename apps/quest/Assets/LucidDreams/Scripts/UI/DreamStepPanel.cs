using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace LucidDreams
{
    // The lesson's step card, as in the WebXR app: at eye level, off to the right so it never hides the person,
    // turned to face you. "Step n of N" or "Your turn", the step's title and tip, and a bar through your turn.
    // Steps are said aloud in the device's voice.
    public class DreamStepPanel : MonoBehaviour
    {
        static readonly Vector2 Size = new(370f, 185f);
        const float Pad = 23f;
        static readonly Color TurnBlue = new(0.04f, 0.52f, 1f, 1f);

        public DreamSequencePlayer player;
        public DreamPlacer placer;
        public DeviceVoice voice;
        public Transform head;
        [Tooltip("Meters ahead of you, to your right, and below your eyes.")]
        public float ahead = 0.95f, right = 0.42f, below = 0.08f;

        TMP_Text count, title, tip;
        RectTransform progress;
        GameObject card, bar;
        Lesson lesson;

        void Start()
        {
            var canvas = GlassUI.WorldCanvas(transform, "Step card", Size);
            card = canvas.gameObject;
            var panel = GlassUI.Box(canvas.transform, "Panel", Vector2.zero, Size, new Color(0.114f, 0.114f, 0.122f, 0.8f), 20f).transform;
            float w = Size.x - 2 * Pad;
            count = GlassUI.Label(panel, "Count", new Vector2(0f, 63f), new Vector2(w, 16f), "", 13f, GlassUI.SecondaryText,
                TextAlignmentOptions.Left, FontWeight.Medium);
            title = GlassUI.Label(panel, "Step", new Vector2(0f, 36f), new Vector2(w, 28f), "", 23f, GlassUI.Text, TextAlignmentOptions.Left);
            tip = GlassUI.Label(panel, "Tip", new Vector2(0f, -22f), new Vector2(w, 62f), "", 14.5f, new Color(0.82f, 0.82f, 0.84f, 1f),
                TextAlignmentOptions.TopLeft, FontWeight.Regular);
            tip.textWrappingMode = TextWrappingModes.Normal;
            tip.maxVisibleLines = 3;
            tip.lineSpacing = 8f;

            bar = GlassUI.Box(panel, "Turn track", new Vector2(0f, -Size.y / 2f + 26f), new Vector2(w, 3.6f), new Color(1f, 1f, 1f, 0.14f), 1.8f).gameObject;
            progress = (RectTransform)GlassUI.Box(bar.transform, "Turn", new Vector2(-w / 2f, 0f), new Vector2(0f, 3.6f), TurnBlue, 1.8f).transform;
            progress.pivot = new Vector2(0f, 0.5f);
            progress.anchoredPosition = new Vector2(-w / 2f, 0f);

            if (placer != null) placer.PlacedForViewer += PlaceBeside;
            card.SetActive(false);
        }

        void OnDestroy()
        {
            if (placer != null) placer.PlacedForViewer -= PlaceBeside;
            if (lesson != null) lesson.Changed -= Say;
        }

        // Follows the person's placement: in front of your right shoulder, its face turned toward your eyes.
        void PlaceBeside(Vector3 forward)
        {
            if (head == null) return;
            var r = Vector3.Cross(Vector3.up, forward);
            var at = head.position + forward * ahead + r * right + Vector3.down * below;
            transform.SetPositionAndRotation(at, Quaternion.LookRotation(Vector3.ProjectOnPlane(at - head.position, Vector3.up), Vector3.up));
        }

        void LateUpdate()
        {
            if (player == null || card == null) return;
            if (player.Lesson != lesson) Attach(player.Lesson);
            card.SetActive(lesson != null);
            if (lesson == null) return;

            var s = lesson.Step;
            count.text = lesson.YourTurn ? "Your turn" : $"Step {lesson.Index + 1} of {lesson.steps.Count}";
            title.text = s.title;
            tip.text = s.tip ?? "";
            bar.SetActive(lesson.YourTurn);
            progress.sizeDelta = new Vector2((Size.x - 2 * Pad) * lesson.TurnProgress(Time.time), 3.6f);
        }

        void Attach(Lesson next)
        {
            if (lesson != null) lesson.Changed -= Say;
            lesson = next;
            if (lesson == null) return;
            lesson.Changed += Say;
            if (transform.position == Vector3.zero && head != null) PlaceBeside(Vector3.ProjectOnPlane(head.forward, Vector3.up).normalized);
            Say(false);
        }

        void Say(bool again)
        {
            if (voice == null || lesson == null) return;
            var s = lesson.Step;
            voice.Say(lesson.YourTurn ? "Your turn." : string.IsNullOrEmpty(s.tip) ? $"{s.title}." : $"{s.title}. {s.tip}", again);
        }
    }
}
