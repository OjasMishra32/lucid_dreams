using System.Collections.Generic;
using System.Linq;
using TMPro;
using UnityEngine;

namespace LucidDreams
{
    // The controls, on your left palm, as in the WebXR viewer (apps/webxr/src/xr/menu.ts) and the Quest's own menus:
    // turn your left palm toward your face and the buttons appear just above it, turned to your eyes; press them with
    // your right index fingertip. Nothing floats in front of your chest where a dance move or a swing goes, and no
    // pinch or gesture changes anything by itself. Play / Pause, then Speed (in a lesson: Again, Back, Next), Reality
    // check (when the bundle has reality frames: it tints what the camera never saw blue, and says how much it saw),
    // Talk (with someone you're with, when a talk server is set up: DreamTalk), Bring here and Library, two to a row.
    public class DreamControlBar : MonoBehaviour
    {
        const float ButtonW = 92f, ButtonH = 34f, Gap = 8f, Pad = 10f, Note = 16f; // millimetres
        const float OpenDot = 0.6f, CloseDot = 0.35f; // palm normal · direction to your eyes
        const float OpenS = 0.22f, CloseS = 0.45f; // a hand swinging past never flashes it open or shut
        const float MaxReachM = 0.75f, AbovePalmM = 0.06f;

        public Transform head;
        public HandTracker hands;
        public DreamSequencePlayer player;
        public DreamPlacer placer;
        public DreamLibraryPanel library;
        public DreamLibrary dreams;
        public DreamTalk talk;

        public bool IsOpen { get; private set; }

        FingertipButton play, speed, again, back, next, reality, talkButton, bring, browse;
        readonly List<FingertipButton> all = new();
        RectTransform canvasRect, panel, shadow;
        TMP_Text seen;
        string layout;
        float flipFor;
        Vector3 palm, normal;

        void Start()
        {
            var canvas = GlassUI.WorldCanvas(transform, "Palm menu", new Vector2(2 * ButtonW + Gap + 2 * Pad, ButtonH + 2 * Pad));
            canvasRect = (RectTransform)canvas.transform;
            shadow = (RectTransform)GlassUI.Shadow(canvas.transform, Vector2.zero, canvasRect.sizeDelta, GlassUI.Corner).transform;
            panel = (RectTransform)GlassUI.Box(canvas.transform, "Menu surface", Vector2.zero, canvasRect.sizeDelta, GlassUI.Surface, GlassUI.Corner).transform;

            play = Button("Pause", () => player.TogglePlay());
            play.restColor = GlassUI.Accent;
            play.onColor = play.focusColor = GlassUI.Hex(0x0a84ff, 1f);
            speed = Button("1×", () => player.CycleSpeed());
            again = Button("Again", () => player.Lesson?.Again());
            back = Button("Back", () => player.Lesson?.Go(player.Lesson.Index - 1));
            next = Button("Next", () => player.Lesson?.Go(player.Lesson.Index + 1));
            reality = Button("Reality check", () => player.ToggleReality());
            talkButton = Button("Talk", () => talk?.Press());
            bring = Button("Bring here", () => placer.PlaceInFrontOfViewer());
            browse = Button("Library", () => library?.Toggle());
            seen = GlassUI.Label(panel, "Seen", Vector2.zero, new Vector2(2 * ButtonW + Gap, Note), "", 8f, GlassUI.SecondaryText,
                TextAlignmentOptions.Center, FontWeight.Medium);
            canvas.gameObject.SetActive(false);
        }

        FingertipButton Button(string label, System.Action pressed)
        {
            var b = FingertipButton.Create(panel, hands, label, Vector2.zero, new Vector2(ButtonW, ButtonH), ButtonH / 2f);
            b.label.fontSize = 11f;
            b.rightIndexOnly = true;
            b.pinchPress = false;
            b.Pressed += pressed;
            all.Add(b);
            return b;
        }

        // The button showing this label right now, for checks.
        public FingertipButton Find(string label) => all.FirstOrDefault(b => b.isActiveAndEnabled && b.label.text == label);

        void LateUpdate()
        {
            if (canvasRect == null) return;
            bool up = PalmUp();
            if (up != IsOpen)
            {
                flipFor += Time.deltaTime;
                if (flipFor > (up ? OpenS : CloseS))
                {
                    IsOpen = up;
                    flipFor = 0f;
                    if (up) transform.position = palm + normal * AbovePalmM; // opens right there, then follows smoothly
                }
            }
            else flipFor = 0f;
            canvasRect.gameObject.SetActive(IsOpen);
            if (!IsOpen) return;
            var target = palm + normal * AbovePalmM;
            transform.position = Vector3.Lerp(transform.position, target, Mathf.Min(1f, Time.deltaTime * 14f));
            var away = transform.position - head.position; // a world canvas reads from behind its forward
            if (away.sqrMagnitude > 1e-6f) transform.rotation = Quaternion.LookRotation(away, Vector3.up);
            Refresh();
        }

        // Your left palm turned toward your eyes, within reach; a looser test keeps it open once it is.
        bool PalmUp()
        {
            if (head == null || hands == null || !hands.left.TryPalm(out var p, out var n)) return false;
            var toEyes = head.position - p;
            if (toEyes.magnitude > MaxReachM) return false;
            palm = p;
            normal = n.normalized;
            return Vector3.Dot(normal, toEyes.normalized) > (IsOpen ? CloseDot : OpenDot);
        }

        void Layout(IReadOnlyList<FingertipButton> visible, bool note)
        {
            int rows = (visible.Count + 1) / 2;
            float w = 2 * ButtonW + Gap + 2 * Pad;
            float h = rows * ButtonH + (rows - 1) * Gap + 2 * Pad + (note ? Note : 0f);
            canvasRect.sizeDelta = panel.sizeDelta = new Vector2(w, h);
            shadow.sizeDelta = new Vector2(w + 20f, h + 20f);
            foreach (var b in all) b.gameObject.SetActive(visible.Contains(b));
            float top = h / 2f - Pad - ButtonH / 2f;
            for (int k = 0; k < visible.Count; k++)
            {
                int r = k / 2;
                bool alone = k == visible.Count - 1 && k % 2 == 0;
                float x = alone ? 0f : (k % 2 == 0 ? -1f : 1f) * (ButtonW + Gap) / 2f;
                ((RectTransform)visible[k].transform).anchoredPosition = new Vector2(x, top - r * (ButtonH + Gap));
            }
            seen.gameObject.SetActive(note);
            ((RectTransform)seen.transform).anchoredPosition = new Vector2(0f, -h / 2f + Pad / 2f + Note / 2f);
        }

        void Refresh()
        {
            if (player == null) return;
            bool ready = player.IsReady;
            var lesson = player.Lesson;

            var visible = new List<FingertipButton> { play };
            if (lesson != null) visible.AddRange(new[] { again, back, next });
            else visible.Add(speed);
            if (player.HasReality) visible.Add(reality);
            if (talk != null && talk.Available) visible.Add(talkButton);
            visible.Add(bring);
            if (library != null) visible.Add(browse);
            float seenFraction = player.SeenFraction;
            bool note = player.HasReality && seenFraction >= 0f;
            string signature = string.Join(",", visible.Select(b => b.name)) + note;
            if (signature != layout)
            {
                layout = signature;
                Layout(visible, note);
            }

            play.interactable = speed.interactable = again.interactable = back.interactable = next.interactable = ready;
            play.SetLabel(player.IsPlaying ? "Pause" : "Play");
            speed.SetLabel(player.Speed >= 1f ? "1×" : player.Speed >= 0.5f ? "0.5×" : "0.25×");
            reality.interactable = ready && !player.RealityLoading && player.RealityError == null;
            reality.on = player.ShowingReality;
            reality.SetLabel(player.RealityLoading ? $"Loading {Mathf.RoundToInt(player.RealityProgress * 100f)}%" : "Reality check");
            browse.on = library != null && library.IsOpen;
            if (talk != null)
            {
                talkButton.SetLabel(talk.Current switch { DreamTalk.State.Listening => "Send", DreamTalk.State.Thinking => "Thinking…", _ => "Talk" });
                talkButton.on = talk.Current == DreamTalk.State.Listening;
                talkButton.interactable = talk.Current != DreamTalk.State.Thinking;
            }
            if (note) seen.text = $"{Mathf.RoundToInt(seenFraction * 100f)}% seen by the camera · blue was imagined";
        }
    }
}
