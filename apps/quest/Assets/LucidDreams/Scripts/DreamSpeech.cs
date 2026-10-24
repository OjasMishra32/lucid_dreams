using System.Collections;
using System.Collections.Generic;
using TMPro;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.UI;

namespace LucidDreams
{
    // Their voice and words, as in the WebXR viewer: voice.m4a (or audio.m4a) comes from where they stand, at mouth
    // height a little in front of the face, kept in step with the clip; captions.vtt shows as a quiet caption in front
    // of them at chest height, toward you, so it never cuts through their body. Lives on the dream root, so it moves
    // with the person. The voice is quiet while paused, during your turn, and at slowed speeds (no pitch-correct
    // time stretch on the Quest yet).
    public class DreamSpeech : MonoBehaviour
    {
        const float MouthBelowTop = 0.13f;
        const float FaceForward = 0.08f;
        const float ResyncS = 0.12f;
        static readonly Vector2 CaptionArea = new(760f, 120f);

        public DreamSequencePlayer player;
        [Range(0f, 1f)] public float captionOpacity = 0.9f;

        public AudioSource Voice { get; private set; }
        public string CaptionText { get; private set; }
        public bool HasVoice => Voice != null && Voice.clip != null;

        DreamBundle loadedFor;
        List<Captions.Cue> cues = new();
        CanvasGroup captionGroup;
        RectTransform pill;
        TMP_Text captionLabel;

        void Start()
        {
            var voiceGo = new GameObject("Voice");
            voiceGo.transform.SetParent(transform, false);
            Voice = voiceGo.AddComponent<AudioSource>();
            Voice.playOnAwake = false;
            Voice.loop = false;
            Voice.spatialBlend = 1f; // a sound in the room, not in your head
            Voice.rolloffMode = AudioRolloffMode.Logarithmic;
            Voice.minDistance = 1.2f; // full voice within conversation distance, like the WebXR panner's ref distance
            Voice.maxDistance = 25f;
            Voice.dopplerLevel = 0f;

            var canvas = GlassUI.WorldCanvas(transform, "Caption", CaptionArea);
            canvas.transform.localRotation = Quaternion.Euler(0f, 180f, 0f); // readable from in front of them
            captionGroup = canvas.gameObject.AddComponent<CanvasGroup>();
            captionGroup.alpha = 0f;
            pill = (RectTransform)GlassUI.Box(canvas.transform, "Pill", Vector2.zero, new Vector2(200f, 50f),
                new Color(0.114f, 0.114f, 0.122f, 0.78f), 25f).transform;
            captionLabel = GlassUI.Label(pill, "Words", Vector2.zero, CaptionArea, "", 30f, GlassUI.Text,
                TextAlignmentOptions.Center, FontWeight.Medium);
            captionLabel.textWrappingMode = TextWrappingModes.Normal;
            captionLabel.maxVisibleLines = 2;
        }

        void Update()
        {
            if (player == null || Voice == null) return;
            if (player.IsReady && player.Dream != loadedFor) Begin(player.Dream);
            if (!player.IsReady)
            {
                if (Voice.isPlaying) Voice.Stop();
                captionGroup.alpha = 0f;
                return;
            }

            // Mouth and chest height from the bundle's real size (never scaled).
            float height = player.Dream.bounds != null && player.Dream.bounds.Height > 0.5f ? player.Dream.bounds.Height : 1.7f;
            Voice.transform.localPosition = new Vector3(0f, height - MouthBelowTop, FaceForward);
            captionGroup.transform.localPosition = new Vector3(0f, height * 0.6f, 0.42f);

            SyncVoice();
            ShowCaption(Captions.At(cues, player.ClipTime));
        }

        void Begin(DreamBundle dream)
        {
            loadedFor = dream;
            StopAllCoroutines();
            Voice.Stop();
            Voice.clip = null;
            cues = new List<Captions.Cue>();
            string track = !string.IsNullOrEmpty(dream.voice) ? dream.voice : dream.audio;
            if (!string.IsNullOrEmpty(track))
                StartCoroutine(VoiceClipLoader.Load($"{player.BaseUrl}/{track}", clip =>
                {
                    if (loadedFor == dream) Voice.clip = clip;
                }, e => Debug.LogWarning($"[Lucid Dreams] No voice for '{dream.name}': {e}")));
            if (!string.IsNullOrEmpty(dream.captions)) StartCoroutine(LoadCaptions(dream));
        }

        IEnumerator LoadCaptions(DreamBundle dream)
        {
            using var request = UnityWebRequest.Get($"{player.BaseUrl}/{dream.captions}");
            yield return request.SendWebRequest();
            if (request.result != UnityWebRequest.Result.Success || loadedFor != dream) yield break;
            cues = Captions.Parse(request.downloadHandler.text);
        }

        void SyncVoice()
        {
            if (Voice.clip == null) return;
            float t = player.ClipTime;
            bool audible = player.IsPlaying && !(player.Lesson?.YourTurn ?? false) && Mathf.Approximately(player.Speed, 1f)
                           && t < Voice.clip.length;
            if (!audible)
            {
                if (Voice.isPlaying) Voice.Pause();
                return;
            }
            if (!Voice.isPlaying)
            {
                Voice.time = t;
                Voice.Play();
            }
            else if (Mathf.Abs(Voice.time - t) > ResyncS) Voice.time = t; // after a loop, a scrub or a lesson jump
        }

        void ShowCaption(string text)
        {
            if (text != null && text != CaptionText)
            {
                captionLabel.text = text;
                var size = captionLabel.GetPreferredValues(text, CaptionArea.x - 48f, 0f);
                pill.sizeDelta = new Vector2(Mathf.Min(CaptionArea.x, size.x + 48f), Mathf.Min(CaptionArea.y, size.y + 20f));
                ((RectTransform)captionLabel.transform).sizeDelta = pill.sizeDelta - new Vector2(32f, 0f);
            }
            CaptionText = text;
            float target = text != null ? captionOpacity : 0f;
            captionGroup.alpha = Mathf.MoveTowards(captionGroup.alpha, target, Time.deltaTime * 6f);
        }
    }
}
