using System.Linq;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace LucidDreams
{
    // The library in the headset: a glass panel in reach, five dreams a page, each with its thumb, name, what it's for
    // and one fingertip action (Get, a download's progress, Play). Opens from the bar, or by itself when there's
    // nothing to play yet; closes when you pick a dream.
    public class DreamLibraryPanel : MonoBehaviour
    {
        const float W = 420f;
        const float Header = 52f;
        const float RowH = 58f;
        const int PerPage = 5;
        const float Footer = 40f;
        static float HeightFor(int rows, bool pager) => Header + RowH * Mathf.Max(rows, 2) + (pager ? Footer : 0f) + 12f;

        public DreamLibrary library;
        public DreamSequencePlayer player;
        public HandTracker hands;
        public Transform head;
        [Tooltip("Meters in front of the eyes, and below them.")]
        public float forward = 0.55f, below = 0.06f;

        public bool IsOpen => root != null && root.activeSelf;

        class Row
        {
            public GameObject go;
            public RawImage thumb;
            public TMP_Text name, detail;
            public FingertipButton action;
            public DreamLibrary.Entry entry;
        }

        GameObject root;
        RectTransform canvasRect, panelRect;
        RectTransform heading, refreshButton, closeButton;
        TMP_Text status, empty, pageLabel;
        float height;
        FingertipButton prev, next;
        readonly Row[] rows = new Row[PerPage];
        int page;
        bool openedForPick;

        void Start()
        {
            height = HeightFor(PerPage, false);
            var canvas = GlassUI.WorldCanvas(transform, "Library", new Vector2(W, height));
            root = canvas.gameObject;
            canvasRect = (RectTransform)canvas.transform;
            var box = GlassUI.Box(canvas.transform, "Panel", Vector2.zero, new Vector2(W, height), new Color(0.11f, 0.11f, 0.118f, 0.86f), 24f);
            panelRect = (RectTransform)box.transform;
            var panel = box.transform;

            heading = (RectTransform)GlassUI.Label(panel, "Heading", Vector2.zero, new Vector2(140f, 22f), "Library", 17f, GlassUI.Text,
                TextAlignmentOptions.Left).transform;
            status = GlassUI.Label(panel, "Status", Vector2.zero, new Vector2(170f, 14f), "", 8.5f,
                GlassUI.SecondaryText, TextAlignmentOptions.Left, FontWeight.Medium);
            var refresh = FingertipButton.Create(panel, hands, "Refresh", Vector2.zero, new Vector2(70f, 26f));
            var close = FingertipButton.Create(panel, hands, "Close", Vector2.zero, new Vector2(60f, 26f));
            refreshButton = (RectTransform)refresh.transform;
            closeButton = (RectTransform)close.transform;
            refresh.Pressed += () => library.Refresh();
            close.Pressed += Close;

            for (int i = 0; i < PerPage; i++) rows[i] = BuildRow(panel, 0f);
            empty = GlassUI.Label(panel, "Empty", Vector2.zero, new Vector2(W - 60f, 60f), "", 11f,
                GlassUI.SecondaryText, TextAlignmentOptions.Center, FontWeight.Regular);
            empty.textWrappingMode = TextWrappingModes.Normal;

            prev = FingertipButton.Create(panel, hands, "Previous", Vector2.zero, new Vector2(84f, 26f));
            next = FingertipButton.Create(panel, hands, "Next", Vector2.zero, new Vector2(84f, 26f));
            pageLabel = GlassUI.Label(panel, "Page", Vector2.zero, new Vector2(80f, 14f), "", 9f, GlassUI.SecondaryText,
                TextAlignmentOptions.Center, FontWeight.Medium);
            prev.Pressed += () => page--;
            next.Pressed += () => page++;

            Resize(PerPage, false);
            root.SetActive(false);
        }

        // Fits the panel to the rows on this page (at least two), keeping everything laid out from the top.
        void Resize(int rowCount, bool pager)
        {
            height = HeightFor(rowCount, pager);
            canvasRect.sizeDelta = panelRect.sizeDelta = new Vector2(W, height);
            float top = height / 2f;
            heading.anchoredPosition = new Vector2(-W / 2f + 24f + 70f, top - 26f);
            ((RectTransform)status.transform).anchoredPosition = new Vector2(-W / 2f + 24f + 160f, top - 27f);
            refreshButton.anchoredPosition = new Vector2(W / 2f - 24f - 104f, top - 26f);
            closeButton.anchoredPosition = new Vector2(W / 2f - 24f - 30f, top - 26f);
            for (int i = 0; i < PerPage; i++)
                ((RectTransform)rows[i].go.transform).anchoredPosition = new Vector2(0f, top - Header - RowH * (i + 0.5f));
            ((RectTransform)empty.transform).anchoredPosition = new Vector2(0f, top - Header - RowH);
            float footerY = -height / 2f + Footer / 2f + 6f;
            ((RectTransform)prev.transform).anchoredPosition = new Vector2(-90f, footerY);
            ((RectTransform)next.transform).anchoredPosition = new Vector2(90f, footerY);
            ((RectTransform)pageLabel.transform).anchoredPosition = new Vector2(0f, footerY);
        }

        Row BuildRow(Transform panel, float y)
        {
            var row = new Row();
            var go = new GameObject("Row", typeof(RectTransform));
            go.transform.SetParent(panel, false);
            ((RectTransform)go.transform).anchoredPosition = new Vector2(0f, y);
            row.go = go;

            // Rounded thumb: the rounded box masks the picture.
            var frame = GlassUI.Box(go.transform, "Thumb", new Vector2(-W / 2f + 24f + 23f, 0f), new Vector2(46f, 46f), new Color(1f, 1f, 1f, 0.08f), 10f);
            frame.gameObject.AddComponent<Mask>().showMaskGraphic = true;
            var pic = new GameObject("Picture", typeof(RectTransform), typeof(RawImage));
            pic.transform.SetParent(frame.transform, false);
            ((RectTransform)pic.transform).sizeDelta = new Vector2(46f, 46f);
            row.thumb = pic.GetComponent<RawImage>();
            row.thumb.raycastTarget = false;

            float textX = -W / 2f + 24f + 46f + 14f;
            float textW = W - 48f - 46f - 14f - 96f;
            row.name = GlassUI.Label(go.transform, "Name", new Vector2(textX + textW / 2f, 8f), new Vector2(textW, 16f), "", 12f, GlassUI.Text,
                TextAlignmentOptions.Left);
            row.detail = GlassUI.Label(go.transform, "Detail", new Vector2(textX + textW / 2f, -9f), new Vector2(textW, 13f), "", 9f,
                GlassUI.SecondaryText, TextAlignmentOptions.Left, FontWeight.Regular);
            row.action = FingertipButton.Create(go.transform, hands, "Get", new Vector2(W / 2f - 24f - 40f, 0f), new Vector2(80f, 28f));
            row.action.Pressed += () => Act(row.entry);
            return row;
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
                transform.SetPositionAndRotation(head.position + flat * forward + Vector3.down * below,
                    Quaternion.LookRotation(flat, Vector3.up) * Quaternion.Euler(12f, 0f, 0f));
            }
            root.SetActive(true);
        }

        public void Close()
        {
            if (root != null) root.SetActive(false);
        }

        void Act(DreamLibrary.Entry e)
        {
            if (e == null) return;
            if (e.cached && Playable(e.dream))
            {
                library.Play(e);
                Close();
            }
            else if (!e.cached) library.Download(e);
        }

        void LateUpdate()
        {
            // Opening by itself waits for the head pose, so the panel lands in front of you.
            if (root == null) return;
            if (library.WaitingForPick && !openedForPick && head != null && head.position != Vector3.zero)
            {
                openedForPick = true;
                Open();
            }
            if (!root.activeSelf) return;
            var entries = library.Entries;
            int pages = Mathf.Max(1, Mathf.CeilToInt(entries.Count / (float)PerPage));
            page = Mathf.Clamp(page, 0, pages - 1);

            status.text = library.Refreshing ? "Checking the bridge…"
                : library.Online ? $"Live from {Host(library.Bridge)}" : "Offline · showing what's on this headset";
            empty.gameObject.SetActive(entries.Count == 0 && !library.Refreshing);
            empty.text = library.Online
                ? "No dreams yet. Make one in the web app and it appears here."
                : "Nothing on this headset yet. Connect to the bridge (bridge.txt) to download dreams.";

            for (int i = 0; i < PerPage; i++)
            {
                int index = page * PerPage + i;
                var row = rows[i];
                row.entry = index < entries.Count ? entries[index] : null;
                row.go.SetActive(row.entry != null);
                if (row.entry != null) Fill(row, row.entry);
            }
            int shown = Mathf.Min(PerPage, entries.Count - page * PerPage);
            if (!Mathf.Approximately(height, HeightFor(shown, pages > 1))) Resize(shown, pages > 1);
            prev.gameObject.SetActive(pages > 1);
            next.gameObject.SetActive(pages > 1);
            prev.interactable = page > 0;
            next.interactable = page < pages - 1;
            pageLabel.text = pages > 1 ? $"{page + 1} of {pages}" : "";
        }

        void Fill(Row row, DreamLibrary.Entry e)
        {
            var d = e.dream;
            row.name.text = string.IsNullOrEmpty(d.name) ? e.id : d.name;
            row.thumb.texture = e.thumb;
            row.thumb.color = e.thumb != null ? Color.white : Color.clear;

            string what = d.IsAvatar ? "Avatar" : $"Replay · {d.frameCount / Mathf.Max(1f, d.fps):0.0} s";
            string detail = !string.IsNullOrEmpty(d.intent) ? $"“{d.intent}”" : what;
            if (e.cached) detail += " · on this headset";
            if (e.error != null) detail = $"Couldn't download: {e.error}";
            row.detail.text = detail;

            bool playing = e.cached && library.PlayingId == e.id && (player.IsReady || player.Error == null);
            row.action.on = playing;
            if (!Playable(d))
            {
                row.action.SetLabel("Soon");
                row.action.interactable = false; // an avatar without skinning data can't move yet
            }
            else if (e.downloading)
            {
                row.action.SetLabel($"{Mathf.RoundToInt(e.progress * 100f)}%");
                row.action.interactable = false;
            }
            else if (playing)
            {
                row.action.SetLabel("Playing");
                row.action.interactable = false;
            }
            else
            {
                row.action.SetLabel(e.cached ? "Play" : e.error != null ? "Retry" : "Get");
                row.action.interactable = e.cached || e.online;
            }
        }

        // Replays, and avatars that carry skinning (skin.bin, skeleton.json, motion.json).
        static bool Playable(DreamBundle d) =>
            d.IsReplay || (d.IsAvatar && d.avatar != null && !string.IsNullOrEmpty(d.avatar.skin)
                           && !string.IsNullOrEmpty(d.avatar.skeleton) && !string.IsNullOrEmpty(d.avatar.motion));

        static string Host(string url)
        {
            try { return new System.Uri(url).Host; }
            catch { return url; }
        }
    }
}
