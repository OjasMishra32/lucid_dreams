using System;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace LucidDreams
{
    // A spatial control you can press two ways, as Atina's handoff asks: push an index fingertip through its face (like
    // the WebXR app's XrButton), or pinch on it and release. Either fires once per push or release, never repeatedly.
    // Focus (a fingertip or pinch near it) shows a 2 mm blue ring and a gentle 1.02 scale; a press flashes blue for
    // 150 ms. Disabled controls stay visible.
    public class FingertipButton : MonoBehaviour
    {
        const float FrontMm = -4f; // a tip just in front of the face already counts, so presses feel immediate
        const float DepthMm = 20f; // and up to 2 cm through it
        const float NearMm = -40f; // focus range in front of the face
        const float CooldownS = 0.3f;
        const float FlashS = 0.15f;

        public HandTracker hands;
        public Image background;
        public Image ring;
        public TMP_Text label;
        public event Action Pressed;
        public bool interactable = true;
        public bool on; // shows the accent colour, for toggles and the selected state
        public Color restColor = GlassUI.Raised;
        public Color onColor = GlassUI.Accent;
        public Color focusColor = GlassUI.RaisedFocus;
        [Tooltip("Scale up a little on focus (cards).")]
        public bool growOnFocus;

        public bool Focused { get; private set; }

        readonly bool[] wasInside = new bool[2];
        readonly bool[] armed = new bool[2];
        float cooldownUntil, flashUntil;
        float scale = 1f;

        // A root holding, in draw order, the focus ring, the face and the label.
        public static FingertipButton Create(Transform parent, HandTracker hands, string text, Vector2 position, Vector2 size, float corner = -1f)
        {
            float radius = corner < 0f ? size.y * 0.5f : corner;
            var go = new GameObject(text, typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var rt = (RectTransform)go.transform;
            rt.anchoredPosition = position;
            rt.sizeDelta = size;
            var button = go.AddComponent<FingertipButton>();
            button.hands = hands;
            button.ring = GlassUI.Outline(go.transform, size, radius);
            button.background = GlassUI.Box(go.transform, "Face", Vector2.zero, size, GlassUI.Raised, radius);
            button.label = GlassUI.Label(go.transform, "Label", Vector2.zero, size, text, Mathf.Min(13f, size.y * 0.36f), GlassUI.Text);
            return button;
        }

        public void SetLabel(string text) => label.text = text;

        public void Resize(Vector2 size)
        {
            ((RectTransform)transform).sizeDelta = size;
            background.rectTransform.sizeDelta = size;
            ring.rectTransform.sizeDelta = size + new Vector2(4f, 4f);
            ((RectTransform)label.transform).sizeDelta = size;
        }

        void Update()
        {
            bool focus = false;
            if (hands != null && interactable)
            {
                var rect = ((RectTransform)transform).rect;
                int h = 0;
                foreach (var hand in hands.Hands)
                {
                    bool inside = false;
                    if (hand.Has(UnityEngine.XR.Hands.XRHandJointID.IndexTip))
                    {
                        var local = transform.InverseTransformPoint(hand.IndexTip);
                        bool over = rect.Contains(new Vector2(local.x, local.y));
                        inside = over && local.z > FrontMm && local.z < DepthMm;
                        focus |= over && local.z > NearMm && local.z < DepthMm;
                    }
                    if (inside && !wasInside[h] && Time.unscaledTime > cooldownUntil) Press();
                    wasInside[h] = inside;

                    // Pinch on it and let go: fires on release, only if the pinch began and ended over it.
                    bool pinchOver = false;
                    if (hand.tracked)
                    {
                        var p = transform.InverseTransformPoint(hand.pinchPoint);
                        pinchOver = rect.Contains(new Vector2(p.x, p.y)) && Mathf.Abs(p.z) < 45f;
                        focus |= pinchOver && hand.pinching;
                    }
                    if (hand.pinchStarted) armed[h] = pinchOver;
                    if (hand.pinchEnded)
                    {
                        if (armed[h] && pinchOver && Time.unscaledTime > cooldownUntil) Press();
                        armed[h] = false;
                    }
                    h++;
                }
            }
            Focused = focus;

            var color = Time.unscaledTime < flashUntil || on ? onColor : focus ? focusColor : restColor;
            if (!interactable) color.a *= 0.55f;
            background.color = color;
            if (ring != null) ring.enabled = focus || (on && growOnFocus);
            label.color = interactable ? GlassUI.Text : GlassUI.SecondaryText;
            if (growOnFocus)
            {
                scale = Mathf.MoveTowards(scale, focus ? 1.02f : 1f, Time.unscaledDeltaTime * 0.2f);
                transform.localScale = Vector3.one * scale;
            }
        }

        public void Press()
        {
            if (!interactable) return;
            cooldownUntil = Time.unscaledTime + CooldownS;
            flashUntil = Time.unscaledTime + FlashS;
            Pressed?.Invoke();
        }
    }
}
