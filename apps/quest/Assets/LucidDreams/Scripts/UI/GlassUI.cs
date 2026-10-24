using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace LucidDreams
{
    // The in-headset look from Atina's handoff (demo/quest-ui), matched to Raami's web tokens: calm frosted surfaces,
    // one blue for action and focus, hairlines only, 18 mm corners, soft 6-10 mm shadows, one ease.
    // World-space canvases use 1 unit = 1 mm.
    public static class GlassUI
    {
        public static readonly Color Surface = Hex(0x161617, 0.72f); // room-facing panels and the rail
        public static readonly Color Raised = Hex(0x1d1d1f, 0.82f); // buttons, cards
        public static readonly Color RaisedFocus = Hex(0x2c2c2e, 0.9f);
        public static readonly Color Text = Hex(0xf5f5f7, 1f);
        public static readonly Color SecondaryText = Hex(0x86868b, 1f);
        public static readonly Color Divider = new(1f, 1f, 1f, 0.12f);
        public static readonly Color Accent = Hex(0x0071e3, 1f); // action, focus, selected
        public static readonly Color Link = Hex(0x2997ff, 1f);
        public static readonly Color Success = Hex(0x30d158, 1f);
        public static readonly Color Warning = Hex(0xff9f0a, 1f);
        public static readonly Color Track = new(1f, 1f, 1f, 0.22f);
        public const float Corner = 18f;
        public const float LibraryCorner = 28f;

        // Older names kept for the panels that use them.
        public static Color Panel => Surface;
        public static Color Fill => Raised;
        public static Color Hover => RaisedFocus;

        public static Color Hex(int rgb, float alpha) =>
            new(((rgb >> 16) & 255) / 255f, ((rgb >> 8) & 255) / 255f, (rgb & 255) / 255f, alpha);

        // cubic-bezier(.2, .8, .2, 1): the one ease every motion uses.
        public static float Ease(float t)
        {
            t = Mathf.Clamp01(t);
            float u = t;
            for (int i = 0; i < 6; i++) // solve x(u) = t by Newton's method
            {
                float x = Bezier(u, 0.2f, 0.2f) - t;
                float dx = BezierSlope(u, 0.2f, 0.2f);
                if (Mathf.Abs(dx) < 1e-5f) break;
                u = Mathf.Clamp01(u - x / dx);
            }
            return Bezier(u, 0.8f, 1f);
        }

        static float Bezier(float u, float p1, float p2) => 3f * (1 - u) * (1 - u) * u * p1 + 3f * (1 - u) * u * u * p2 + u * u * u;
        static float BezierSlope(float u, float p1, float p2) => 3f * (1 - u) * (1 - u) * p1 + 6f * (1 - u) * u * (p2 - p1) + 3f * u * u * (1 - p2);

        const int SpriteRadius = 32;
        static Sprite rounded, soft, triangle;

        // A circle sprite sliced at its centre: any rect becomes a pill or rounded rectangle with crisp edges.
        public static Sprite Rounded => rounded ??= MakeRounded();

        // The same, with a wide feathered edge: a soft shadow.
        static Sprite Soft => soft ??= MakeSoft();

        // A right-pointing triangle (play, previous / next).
        public static Sprite Triangle => triangle ??= MakeTriangle();

        static Sprite MakeRounded()
        {
            int size = SpriteRadius * 2;
            var tex = new Texture2D(size, size, TextureFormat.RGBA32, false) { wrapMode = TextureWrapMode.Clamp, name = "Glass rounded" };
            var px = new Color32[size * size];
            for (int y = 0; y < size; y++)
            for (int x = 0; x < size; x++)
            {
                float d = Vector2.Distance(new Vector2(x + 0.5f, y + 0.5f), new Vector2(SpriteRadius, SpriteRadius));
                px[y * size + x] = new Color32(255, 255, 255, (byte)(Mathf.Clamp01(SpriteRadius - d) * 255));
            }
            tex.SetPixels32(px);
            tex.Apply(false, true);
            float b = SpriteRadius - 1;
            return Sprite.Create(tex, new Rect(0, 0, size, size), new Vector2(0.5f, 0.5f), 100f, 0, SpriteMeshType.FullRect, new Vector4(b, b, b, b));
        }

        static Sprite MakeSoft()
        {
            int size = SpriteRadius * 2;
            var tex = new Texture2D(size, size, TextureFormat.RGBA32, false) { wrapMode = TextureWrapMode.Clamp, name = "Glass shadow" };
            var px = new Color32[size * size];
            for (int y = 0; y < size; y++)
            for (int x = 0; x < size; x++)
            {
                float d = Vector2.Distance(new Vector2(x + 0.5f, y + 0.5f), new Vector2(SpriteRadius, SpriteRadius)) / SpriteRadius;
                float a = Mathf.Clamp01(1f - d);
                px[y * size + x] = new Color32(0, 0, 0, (byte)(a * a * 255));
            }
            tex.SetPixels32(px);
            tex.Apply(false, true);
            float b = SpriteRadius - 1;
            return Sprite.Create(tex, new Rect(0, 0, size, size), new Vector2(0.5f, 0.5f), 100f, 0, SpriteMeshType.FullRect, new Vector4(b, b, b, b));
        }

        static Sprite MakeTriangle()
        {
            const int size = 64;
            var tex = new Texture2D(size, size, TextureFormat.RGBA32, false) { wrapMode = TextureWrapMode.Clamp, name = "Glass triangle" };
            var px = new Color32[size * size];
            // points (8, 4), (8, 60), (58, 32), with a one-pixel soft edge
            for (int y = 0; y < size; y++)
            for (int x = 0; x < size; x++)
            {
                var p = new Vector2(x + 0.5f, y + 0.5f);
                float e1 = Edge(p, new Vector2(8, 4), new Vector2(58, 32));
                float e2 = Edge(p, new Vector2(58, 32), new Vector2(8, 60));
                float e3 = Edge(p, new Vector2(8, 60), new Vector2(8, 4));
                float inside = Mathf.Clamp01(Mathf.Min(e1, Mathf.Min(e2, e3)) + 0.5f);
                px[y * size + x] = new Color32(255, 255, 255, (byte)(inside * 255));
            }
            tex.SetPixels32(px);
            tex.Apply(false, true);
            return Sprite.Create(tex, new Rect(0, 0, size, size), new Vector2(0.5f, 0.5f), 100f);
        }

        // Signed distance (pixels) to the left of the edge a -> b: positive inside the counter-clockwise triangle.
        static float Edge(Vector2 p, Vector2 a, Vector2 b)
        {
            var d = (b - a).normalized;
            return d.x * (p.y - a.y) - d.y * (p.x - a.x);
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
            var image = Sliced(parent, name, Rounded, position, size, color, cornerRadius);
            return image;
        }

        // A soft shadow under a panel: the panel's shape, 8 mm down, feathered 10 mm.
        public static Image Shadow(Transform parent, Vector2 position, Vector2 size, float cornerRadius, float opacity = 0.32f)
        {
            var image = Sliced(parent, "Shadow", Soft, position + new Vector2(0f, -8f), size + new Vector2(20f, 20f), new Color(0, 0, 0, opacity),
                cornerRadius + 10f);
            image.transform.SetAsFirstSibling();
            return image;
        }

        // A 2 mm focus ring around a rect (drawn behind it).
        public static Image Outline(Transform parent, Vector2 size, float cornerRadius)
        {
            var ring = Sliced(parent, "Focus ring", Rounded, Vector2.zero, size + new Vector2(4f, 4f), Accent, cornerRadius + 2f);
            ring.transform.SetAsFirstSibling();
            ring.enabled = false;
            return ring;
        }

        static Image Sliced(Transform parent, string name, Sprite sprite, Vector2 position, Vector2 size, Color color, float cornerRadius)
        {
            var go = new GameObject(name, typeof(RectTransform), typeof(Image));
            go.transform.SetParent(parent, false);
            var rt = (RectTransform)go.transform;
            rt.anchoredPosition = position;
            rt.sizeDelta = size;
            var image = go.GetComponent<Image>();
            image.sprite = sprite;
            image.type = Image.Type.Sliced;
            image.pixelsPerUnitMultiplier = SpriteRadius / Mathf.Max(0.5f, cornerRadius);
            image.color = color;
            image.raycastTarget = false;
            return image;
        }

        public static Image Shape(Transform parent, string name, Sprite sprite, Vector2 position, Vector2 size, Color color, float rotation = 0f)
        {
            var go = new GameObject(name, typeof(RectTransform), typeof(Image));
            go.transform.SetParent(parent, false);
            var rt = (RectTransform)go.transform;
            rt.anchoredPosition = position;
            rt.sizeDelta = size;
            rt.localRotation = Quaternion.Euler(0f, 0f, rotation);
            var image = go.GetComponent<Image>();
            image.sprite = sprite;
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
