using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace LucidDreams
{
    // The in-headset look, matched to the web app: dark translucent glass, SF-style white text, Apple blue for "on".
    // World-space canvases use 1 unit = 1 mm. Placeholder styling until Atina's mockups land.
    public static class GlassUI
    {
        public static readonly Color Panel = new(0.11f, 0.11f, 0.118f, 0.74f);
        public static readonly Color Fill = new(0.173f, 0.173f, 0.18f, 0.84f);
        public static readonly Color Hover = new(0.25f, 0.25f, 0.26f, 0.9f);
        public static readonly Color Accent = new(0f, 0.443f, 0.89f, 0.95f);
        public static readonly Color Text = new(0.96f, 0.96f, 0.97f, 1f);
        public static readonly Color SecondaryText = new(0.96f, 0.96f, 0.97f, 0.6f);
        public static readonly Color Track = new(1f, 1f, 1f, 0.22f);

        const int SpriteRadius = 32;
        static Sprite rounded;

        // A circle sprite sliced at its centre: any rect becomes a pill or rounded rectangle with crisp edges.
        public static Sprite Rounded
        {
            get
            {
                if (rounded != null) return rounded;
                int size = SpriteRadius * 2;
                var tex = new Texture2D(size, size, TextureFormat.RGBA32, false) { wrapMode = TextureWrapMode.Clamp, name = "Glass rounded" };
                var px = new Color32[size * size];
                for (int y = 0; y < size; y++)
                for (int x = 0; x < size; x++)
                {
                    float d = Vector2.Distance(new Vector2(x + 0.5f, y + 0.5f), new Vector2(SpriteRadius, SpriteRadius));
                    byte a = (byte)(Mathf.Clamp01(SpriteRadius - d) * 255);
                    px[y * size + x] = new Color32(255, 255, 255, a);
                }
                tex.SetPixels32(px);
                tex.Apply(false, true);
                rounded = Sprite.Create(tex, new Rect(0, 0, size, size), new Vector2(0.5f, 0.5f), 100f, 0,
                    SpriteMeshType.FullRect, new Vector4(SpriteRadius - 1, SpriteRadius - 1, SpriteRadius - 1, SpriteRadius - 1));
                return rounded;
            }
        }

        public static Canvas WorldCanvas(Transform parent, string name, Vector2 sizeMm)
        {
            var go = new GameObject(name, typeof(RectTransform), typeof(Canvas));
            go.transform.SetParent(parent, false);
            var canvas = go.GetComponent<Canvas>();
            canvas.renderMode = RenderMode.WorldSpace;
            var rt = (RectTransform)go.transform;
            rt.sizeDelta = sizeMm;
            rt.localScale = Vector3.one * 0.001f;
            return canvas;
        }

        public static Image Box(Transform parent, string name, Vector2 position, Vector2 size, Color color, float cornerRadius)
        {
            var go = new GameObject(name, typeof(RectTransform), typeof(Image));
            go.transform.SetParent(parent, false);
            var rt = (RectTransform)go.transform;
            rt.anchoredPosition = position;
            rt.sizeDelta = size;
            var image = go.GetComponent<Image>();
            image.sprite = Rounded;
            image.type = Image.Type.Sliced;
            image.pixelsPerUnitMultiplier = SpriteRadius / Mathf.Max(0.5f, cornerRadius);
            image.color = color;
            image.raycastTarget = false;
            return image;
        }

        public static TMP_Text Label(Transform parent, string name, Vector2 position, Vector2 size, string text, float sizeMm,
            Color color, TextAlignmentOptions align = TextAlignmentOptions.Center, FontWeight weight = FontWeight.SemiBold)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var rt = (RectTransform)go.transform;
            rt.anchoredPosition = position;
            rt.sizeDelta = size;
            var label = go.AddComponent<TextMeshProUGUI>();
            label.text = text;
            label.fontSize = sizeMm;
            label.fontWeight = weight;
            label.color = color;
            label.alignment = align;
            label.textWrappingMode = TextWrappingModes.NoWrap;
            label.overflowMode = TextOverflowModes.Ellipsis;
            label.raycastTarget = false;
            return label;
        }
    }
}
