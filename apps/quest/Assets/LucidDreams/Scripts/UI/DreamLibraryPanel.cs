using System.Linq;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace LucidDreams
{
    // The Dream Library from Atina's handoff (demo/quest-ui): a 1.20 x 0.70 m panel centred 0.95 m in front of you, its
    // bottom edge about 0.85 m above the floor, three 0.31 x 0.42 m cards across, newest first. A card opens with a
    // fingertip push or a pinch: a dream on the headset plays, one on the bridge downloads (you keep browsing).
    // Focus and selected states show a 2 mm blue ring; selected adds a check; states always have words, not just colour.
    // The footer holds the caption settings (Captions on / off, Standard / Large).
    public class DreamLibraryPanel : MonoBehaviour
    {
        const float W = 1200f, H = 700f;
        const float CardW = 310f, CardH = 420f, CardGap = 18f;
        const float Pad = 14f;
        const int PerPage = 3;
        static readonly Vector2 Thumb = new(CardW - 2 * Pad, (CardW - 2 * Pad) * 9f / 16f);

        public DreamLibrary library;
        public DreamSequencePlayer player;
        public DreamPlacer placer;
        public DreamSpeech speech;
        public HandTracker hands;
        public Transform head;
        [Tooltip("Meters in front of you, and the height of the panel's bottom edge above the floor.")]
        public float forward = 0.95f, bottom = 0.85f;

        public bool IsOpen => root != null && root.activeSelf;

        class Card
        {
            public FingertipButton button;
            public RawImage thumb;
            public Image check;
            public TMP_Text name, detail, status, duration, kind;
            public Image dot, durationChip, lessonChip;
            public DreamLibrary.Entry entry;
        }

        GameObject root;
        CanvasGroup fade;
        RectTransform canvasRect;
        TMP_Text connection, emptyTitle, emptyBody, pageLabel;
        FingertipButton make, prev, next, captions, textSize;
        readonly Card[] cards = new Card[PerPage];
        int page;
        bool openedForPick;
        float openedAt = -1f;

        void Start()
        {
            var canvas = GlassUI.WorldCanvas(transform, "Dream Library", new Vector2(W, H));
            root = canvas.gameObject;
            canvasRect = (RectTransform)canvas.transform;
            fade = root.AddComponent<CanvasGroup>();
            var t = canvas.transform;
            GlassUI.Shadow(t, Vector2.zero, new Vector2(W, H), GlassUI.LibraryCorner);
            GlassUI.Box(t, "Surface", Vector2.zero, new Vector2(W, H), GlassUI.Surface, GlassUI.LibraryCorner);

            float left = -W / 2f + 48f, top = H / 2f;
            GlassUI.Label(t, "Title", new Vector2(left + 300f, top - 62f), new Vector2(600f, 50f), "Dream Library", 42f, GlassUI.Text, TextAlignmentOptions.Left);
            GlassUI.Label(t, "Metadata", new Vector2(left + 300f, top - 104f), new Vector2(600f, 32f), "Your people, moments, and lessons.", 26f,
                GlassUI.SecondaryText, TextAlignmentOptions.Left, FontWeight.Regular);
            connection = GlassUI.Label(t, "Connection", new Vector2(W / 2f - 48f - 110f - 200f, top - 62f), new Vector2(400f, 20f), "", 14f,
                GlassUI.SecondaryText, TextAlignmentOptions.Right, FontWeight.Medium);
            var close = FingertipButton.Create(t, hands, "Close", new Vector2(W / 2f - 48f - 44f, top - 62f), new Vector2(88f, 64f), GlassUI.Corner);
            close.label.fontSize = 15f;
            close.Pressed += Close;

            float cardsY = top - 140f - CardH / 2f;
            for (int i = 0; i < PerPage; i++)
                cards[i] = BuildCard(t, new Vector2((i - 1) * (CardW + CardGap), cardsY));

            emptyTitle = GlassUI.Label(t, "Empty", new Vector2(0f, cardsY + 50f), new Vector2(800f, 40f), "No dreams yet", 30f, GlassUI.Text);
            emptyBody = GlassUI.Label(t, "Empty detail", new Vector2(0f, cardsY), new Vector2(800f, 60f), "", 17f, GlassUI.SecondaryText,
                TextAlignmentOptions.Center, FontWeight.Regular);
            emptyBody.textWrappingMode = TextWrappingModes.Normal;
            make = FingertipButton.Create(t, hands, "Make a dream", new Vector2(0f, cardsY - 80f), new Vector2(200f, 64f), GlassUI.Corner);
            make.label.fontSize = 16f;
            make.restColor = GlassUI.Accent;
            make.focusColor = make.onColor = GlassUI.Hex(0x0a84ff, 1f);
            make.Pressed += () => { if (!string.IsNullOrEmpty(library.Bridge)) Application.OpenURL($"{library.Bridge}/new"); };

            float footY = -H / 2f + 26f + 32f;
            captions = Footer(t, "Captions: On", new Vector2(left + 120f, footY), 240f, () => speech.CaptionsOn = !speech.CaptionsOn);
            textSize = Footer(t, "Text size: Standard", new Vector2(left + 240f + 18f + 120f, footY), 240f, () => speech.LargeCaptions = !speech.LargeCaptions);
            next = Footer(t, "Next", new Vector2(W / 2f - 48f - 60f, footY), 120f, () => page++);
            prev = Footer(t, "Previous", new Vector2(W / 2f - 48f - 120f - 18f - 60f, footY), 120f, () => page--);
            pageLabel = GlassUI.Label(t, "Page", new Vector2(W / 2f - 48f - 2 * 120f - 2 * 18f - 50f, footY), new Vector2(100f, 20f), "", 14f,
                GlassUI.SecondaryText, TextAlignmentOptions.Center, FontWeight.Medium);
            root.SetActive(false);
        }

        FingertipButton Footer(Transform t, string label, Vector2 at, float width, System.Action pressed)
        {
            var b = FingertipButton.Create(t, hands, label, at, new Vector2(width, 64f), GlassUI.Corner);
            b.label.fontSize = 15f;
            b.Pressed += pressed;
            return b;
        }

        Card BuildCard(Transform parent, Vector2 at)
        {
            var c = new Card();
            c.button = FingertipButton.Create(parent, hands, "Card", at, new Vector2(CardW, CardH), GlassUI.Corner);
            c.button.growOnFocus = true;
            c.button.label.text = "";
            c.button.Pressed += () => Act(c.entry);
            var t = c.button.transform;
            float top = CardH / 2f;

            // 16:9 thumbnail with rounded corners (the rounded box masks the picture), its length in a pill on it
            var frame = GlassUI.Box(t, "Thumb", new Vector2(0f, top - Pad - Thumb.y / 2f), Thumb, new Color(1f, 1f, 1f, 0.06f), 12f);
            frame.gameObject.AddComponent<Mask>().showMaskGraphic = true;
            var pic = new GameObject("Picture", typeof(RectTransform), typeof(RawImage));
            pic.transform.SetParent(frame.transform, false);
            ((RectTransform)pic.transform).sizeDelta = Thumb;
            c.thumb = pic.GetComponent<RawImage>();
            c.thumb.raycastTarget = false;
            c.durationChip = GlassUI.Box(frame.transform, "Length", new Vector2(Thumb.x / 2f - 40f, -Thumb.y / 2f + 20f), new Vector2(64f, 24f), new Color(0f, 0f, 0f, 0.55f), 12f);
            c.duration = GlassUI.Label(c.durationChip.transform, "Length", Vector2.zero, new Vector2(64f, 24f), "", 12f, Color.white, TextAlignmentOptions.Center, FontWeight.Medium);
            c.check = GlassUI.Box(frame.transform, "Selected", new Vector2(-Thumb.x / 2f + 24f, Thumb.y / 2f - 24f), new Vector2(32f, 32f), GlassUI.Accent, 16f);
            // the check mark: two bars, so the state reads without colour
            GlassUI.Shape(c.check.transform, "Tick short", GlassUI.Rounded, new Vector2(-5f, -2f), new Vector2(4f, 11f), Color.white, 45f);
            GlassUI.Shape(c.check.transform, "Tick long", GlassUI.Rounded, new Vector2(3f, 1f), new Vector2(4f, 19f), Color.white, -40f);

            float textW = CardW - 2 * Pad, y = top - Pad - Thumb.y - 14f;
            c.name = GlassUI.Label(t, "Name", new Vector2(0f, y - 14f), new Vector2(textW, 28f), "", 21f, GlassUI.Text, TextAlignmentOptions.Left);
            var kindChip = GlassUI.Box(t, "Kind", new Vector2(-textW / 2f + 40f, y - 50f), new Vector2(80f, 26f), GlassUI.Divider, 13f);
            c.kind = GlassUI.Label(kindChip.transform, "Kind", Vector2.zero, new Vector2(80f, 26f), "", 12f, GlassUI.Text, TextAlignmentOptions.Center, FontWeight.Medium);
            c.lessonChip = GlassUI.Box(t, "Lesson", new Vector2(-textW / 2f + 80f + 8f + 40f, y - 50f), new Vector2(80f, 26f), GlassUI.Divider, 13f);
            GlassUI.Label(c.lessonChip.transform, "Lesson", Vector2.zero, new Vector2(80f, 26f), "Lesson", 12f, GlassUI.Text, TextAlignmentOptions.Center, FontWeight.Medium);
            c.detail = GlassUI.Label(t, "Detail", new Vector2(0f, y - 96f), new Vector2(textW, 44f), "", 14f, GlassUI.SecondaryText, TextAlignmentOptions.TopLeft, FontWeight.Regular);
            c.detail.textWrappingMode = TextWrappingModes.Normal;
            c.detail.maxVisibleLines = 2;
            c.dot = GlassUI.Box(t, "Status dot", new Vector2(-textW / 2f + 6f, -CardH / 2f + Pad + 18f), new Vector2(12f, 12f), GlassUI.Success, 6f);
            c.status = GlassUI.Label(t, "Status", new Vector2(10f, -CardH / 2f + Pad + 18f), new Vector2(textW - 20f, 24f), "", 14f, GlassUI.Text,
                TextAlignmentOptions.Left, FontWeight.Medium);
            return c;
        }

        // A card's control, for tests and anything that opens a dream by id.
        public FingertipButton CardFor(string id) => cards.FirstOrDefault(c => c.entry?.id == id && c.button.gameObject.activeSelf)?.button;
        public string CardStatus(string id) => cards.FirstOrDefault(c => c.entry?.id == id)?.status.text;

        // Pinches on the panel belong to it (cards, buttons), never to the room behind.
        public bool Contains(Vector3 world)
        {
            if (!IsOpen) return false;
            var local = canvasRect.InverseTransformPoint(world);
            return Mathf.Abs(local.x) < W / 2f + 20f && Mathf.Abs(local.y) < H / 2f + 20f && local.z > -80f && local.z < 40f;
        }

        public void Toggle()
        {
            if (IsOpen) Close();
            else Open();
        }

        public void Open()
        {
            if (root == null) return;
            library.Refresh();
            if (head != null && head.position != Vector3.zero)
            {
                var flat = Vector3.ProjectOnPlane(head.forward, Vector3.up);
                if (flat.sqrMagnitude < 1e-4f) flat = Vector3.forward;
                flat.Normalize();
                float floor = placer != null ? placer.FloorY : 0f;
                var at = head.position + flat * forward;
                at.y = floor + bottom + H / 2000f;
                transform.SetPositionAndRotation(at, Quaternion.LookRotation(flat, Vector3.up));
            }
            // Open on the page with the dream that's playing.
            int playing = library.Entries.ToList().FindIndex(e => e.id == library.PlayingId);
            if (playing >= 0) page = playing / PerPage;
            openedAt = Time.unscaledTime;
            root.SetActive(true);
        }

        public void Close()
        {
            if (root != null) root.SetActive(false);
        }

        void Act(DreamLibrary.Entry e)
        {
            if (e == null || e.downloading) return;
            if (e.cached && DreamLibrary.Playable(e.dream))
            {
                library.Play(e);
                Close();
            }
            else if (!e.cached) library.Download(e);
        }

        void LateUpdate()
        {
            if (root == null) return;
            // With nothing to play yet, it opens by itself as soon as it knows where you're looking.
            if (library.WaitingForPick && !openedForPick && head != null && head.position != Vector3.zero)
            {
                openedForPick = true;
                Open();
            }
            if (!root.activeSelf) return;

            // Opening: a short rise and fade on the one ease.
            float k = GlassUI.Ease((Time.unscaledTime - openedAt) / 0.32f);
            fade.alpha = k;
            canvasRect.localScale = Vector3.one * 0.001f * Mathf.Lerp(0.97f, 1f, k);

            var entries = library.Entries;
            int pages = Mathf.Max(1, Mathf.CeilToInt(entries.Count / (float)PerPage));
            page = Mathf.Clamp(page, 0, pages - 1);

            connection.text = library.Refreshing ? "Checking for new dreams…"
                : library.Online ? $"Live from {Host(library.Bridge)}" : "Offline · showing what's on this headset";
            bool empty = entries.Count == 0 && !library.Refreshing;
            emptyTitle.gameObject.SetActive(empty);
            emptyBody.gameObject.SetActive(empty);
            make.gameObject.SetActive(empty && library.Online);
            emptyTitle.text = library.Online ? "No dreams yet" : "Nothing on this headset yet";
            emptyBody.text = library.Online
                ? "Make one from any video or photo in the web app, and it appears here."
                : "Connect to the bridge to download dreams (set its address in bridge.txt).";

            int onPage = Mathf.Min(PerPage, entries.Count - page * PerPage);
            for (int i = 0; i < PerPage; i++)
            {
                int index = page * PerPage + i;
                var card = cards[i];
                var at = ((RectTransform)card.button.transform).anchoredPosition;
                ((RectTransform)card.button.transform).anchoredPosition = new Vector2((i - (onPage - 1) / 2f) * (CardW + CardGap), at.y); // a short page sits centred
                card.entry = index < entries.Count ? entries[index] : null;
                card.button.gameObject.SetActive(card.entry != null);
                if (card.entry != null) Fill(card, card.entry);
            }

            prev.gameObject.SetActive(pages > 1);
            next.gameObject.SetActive(pages > 1);
            prev.interactable = page > 0;
            next.interactable = page < pages - 1;
            pageLabel.text = pages > 1 ? $"{page + 1} of {pages}" : "";

            bool loaded = player != null && player.IsReady;
            bool hasCaptions = loaded && !string.IsNullOrEmpty(player.Dream.captions);
            captions.SetLabel(!loaded || hasCaptions ? $"Captions: {(speech.CaptionsOn ? "On" : "Off")}" : "No captions in this dream");
            captions.on = speech.CaptionsOn && hasCaptions;
            captions.interactable = hasCaptions;
            textSize.SetLabel($"Text size: {(speech.LargeCaptions ? "Large" : "Standard")}");
            textSize.interactable = hasCaptions && speech.CaptionsOn;
        }

        void LateFocusRing(Card c, bool selected)
        {
            // FingertipButton draws the ring for focus; selected keeps it on too (with the check, never colour alone).
            if (selected) c.button.ring.enabled = true;
        }

        void Fill(Card c, DreamLibrary.Entry e)
        {
            var d = e.dream;
            c.name.text = string.IsNullOrEmpty(d.name) ? e.id : d.name;
            c.thumb.texture = e.thumb;
            c.thumb.color = e.thumb != null ? Color.white : Color.clear;
            if (e.thumb != null) c.thumb.uvRect = Cover(e.thumb.width, e.thumb.height);

            float seconds = d.frameCount / Mathf.Max(1f, d.fps);
            c.duration.text = $"{(int)seconds / 60}:{(int)seconds % 60:00}";
            c.durationChip.gameObject.SetActive(d.frameCount > 0);
            c.kind.text = d.IsAvatar ? "Avatar" : "Replay";
            c.lessonChip.gameObject.SetActive(Experience.Fallback(d.intent, seconds)?.mode == "teach");
            c.detail.text = !string.IsNullOrEmpty(d.intent) ? $"“{d.intent}”"
                : d.IsAvatar ? "Moves any way you ask." : "Exactly as it happened, from every side.";

            bool playable = DreamLibrary.Playable(d);
            bool selected = e.cached && library.PlayingId == e.id;
            c.check.gameObject.SetActive(selected);
            LateFocusRing(c, selected);
            c.button.interactable = !e.downloading && (playable || !e.cached) && (e.cached || e.online);

            if (!playable) Status(c, GlassUI.Warning, "Unavailable · this avatar can't move yet");
            else if (e.downloading) Status(c, GlassUI.Link, $"Downloading {Mathf.RoundToInt(e.progress * 100f)}% · Keep browsing");
            else if (e.error != null) Status(c, GlassUI.Warning, "Couldn't download · Try again");
            else if (selected) Status(c, GlassUI.Accent, player.IsReady ? "Playing now" : "Opening…");
            else if (e.cached) Status(c, GlassUI.Success, "On this headset · Play");
            else if (e.online) Status(c, GlassUI.SecondaryText, "Download to play");
            else Status(c, GlassUI.Warning, "Unavailable offline");
        }

        static void Status(Card c, Color dot, string text)
        {
            c.dot.color = dot;
            c.status.text = text;
        }

        // Crop to 16:9, keeping more of the top (faces) when a portrait thumb is cut down.
        static Rect Cover(int w, int h)
        {
            float target = 16f / 9f, aspect = (float)w / h;
            if (aspect > target)
            {
                float u = target / aspect;
                return new Rect((1f - u) / 2f, 0f, u, 1f);
            }
            float v = aspect / target;
            return new Rect(0f, (1f - v) * 0.95f, 1f, v); // head and shoulders
        }

        static string Host(string url)
        {
            try { return new System.Uri(url).Host; }
            catch { return url; }
        }
    }
}
