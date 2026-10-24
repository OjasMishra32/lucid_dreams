using System;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace LucidDreams
{
    // A glass button pressed by pushing an index fingertip through its face, like the WebXR app's XrButton:
    // fires once per push (entering the face), never repeatedly while the finger rests there.
    public class FingertipButton : MonoBehaviour
    {
        const float FrontMm = -4f; // a tip just in front of the face already counts, so presses feel immediate
        const float DepthMm = 20f; // and up to 2 cm through it
        const float HoverMm = -35f;
        const float CooldownS = 0.3f;
        const float FlashS = 0.18f;

        public HandTracker hands;
        public Image background;
        public TMP_Text label;
        public event Action Pressed;
        public bool interactable = true;
        public bool on; // shows the accent colour, for toggles

        readonly bool[] wasInside = new bool[2];
        float cooldownUntil, flashUntil;

        public static FingertipButton Create(Transform parent, HandTracker hands, string text, Vector2 position, Vector2 size)
        {
            var bg = GlassUI.Box(parent, text, position, size, GlassUI.Fill, size.y * 0.5f);
            var button = bg.gameObject.AddComponent<FingertipButton>();
            button.hands = hands;
            button.background = bg;
            button.label = GlassUI.Label(bg.transform, "Label", Vector2.zero, size, text, size.y * 0.36f, GlassUI.Text);
            return button;
        }

        public void SetLabel(string text) => label.text = text;

        void Update()
        {
            bool hover = false;
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
                        hover |= over && local.z > HoverMm && local.z < DepthMm;
                    }
                    if (inside && !wasInside[h] && Time.unscaledTime > cooldownUntil) Press();
                    wasInside[h] = inside;
                    h++;
                }
            }

            var color = Time.unscaledTime < flashUntil || on ? GlassUI.Accent : hover ? GlassUI.Hover : GlassUI.Fill;
            if (!interactable) color.a *= 0.5f;
            background.color = color;
            label.color = interactable ? GlassUI.Text : GlassUI.SecondaryText;
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
