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
        // Atina's caption spec: at most 0.56 m wide, at least 0.10 m tall, 22 mm side padding, 29 mm text (36 mm Large).
        const float MaxWidth = 560f, MinHeight = 100f, SidePad = 22f, Standard = 29f, Large = 36f;
        const string CaptionsKey = "LucidDreams.captions", LargeKey = "LucidDreams.largeCaptions";

        public DreamSequencePlayer player;
        [Tooltip("Raises the voice and captions with a seated person (Seating).")]
        public DreamPlacer placer;
        [Range(0f, 1f)] public float captionOpacity = 0.9f;

        public AudioSource Voice { get; private set; }
        // Talk (DreamTalk): their AI reply, from the same mouth position; the clip's own voice waits while it plays.
        public AudioSource Reply { get; private set; }
        public bool Replying => Reply != null && Reply.isPlaying;

        // Settings in the library: Captions on / off, Standard / Large. Remembered on the headset.
        public bool CaptionsOn
        {
            get => PlayerPrefs.GetInt(CaptionsKey, 1) == 1;
            set { PlayerPrefs.SetInt(CaptionsKey, value ? 1 : 0); lastSize = -1f; }
        }

        public bool LargeCaptions
        {
            get => PlayerPrefs.GetInt(LargeKey, 0) == 1;
            set { PlayerPrefs.SetInt(LargeKey, value ? 1 : 0); lastSize = -1f; }
        }

        float lastSize = -1f;
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
            Reply = voiceGo.AddComponent<AudioSource>();
            Reply.playOnAwake = false;
            Reply.spatialBlend = 1f;
            Reply.rolloffMode = AudioRolloffMode.Logarithmic;
            Reply.minDistance = 1.2f;
            Reply.maxDistance = 25f;
            Reply.dopplerLevel = 0f;

            var canvas = GlassUI.WorldCanvas(transform, "Caption", new Vector2(MaxWidth, 200f));
            canvas.transform.localRotation = Quaternion.Euler(0f, 180f, 0f); // readable from in front of them
            captionGroup = canvas.gameObject.AddComponent<CanvasGroup>();
            captionGroup.alpha = 0f;
            pill = (RectTransform)GlassUI.Box(canvas.transform, "Pill", Vector2.zero, new Vector2(200f, MinHeight),
                GlassUI.Hex(0x161617, 0.88f), GlassUI.Corner).transform;
            captionLabel = GlassUI.Label(pill, "Words", Vector2.zero, new Vector2(MaxWidth - 2 * SidePad, 200f), "", Standard, GlassUI.Text,
                TextAlignmentOptions.Center, FontWeight.Medium);
            captionLabel.textWrappingMode = TextWrappingModes.Normal;
            captionLabel.maxVisibleLines = 2;
            captionLabel.lineSpacing = 0f; // TMP's default line height is about 1.18 em
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

            // Mouth and chest height from the bundle's real size (never scaled), raised with someone seated on a bench.
            float height = player.Dream.bounds != null && player.Dream.bounds.Height > 0.5f ? player.Dream.bounds.Height : 1.7f;
            bool seated = placer != null && placer.Seat.seated;
            float top = height + (placer != null ? placer.Lift : 0f);
            Voice.transform.localPosition = new Vector3(0f, top - MouthBelowTop, FaceForward);
            captionGroup.transform.localPosition = new Vector3(0f, seated ? top - 0.42f : height * 0.6f, 0.42f);

            SyncVoice();
            if (Replying) ShowCaption(replyCaption, 4);
            else if (Time.time < noticeUntil) ShowCaption(notice, 2);
            else ShowCaption(CaptionsOn ? Captions.At(cues, player.ClipTime) : null);
        }

        string replyCaption, notice;
        float noticeUntil;

        // A short line from the app itself on the caption for a few seconds (Talk resting, too long, didn't work):
        // shown even with captions off, since it's the only answer to a press.
        public void Notice(string text, float seconds = 5f)
        {
            notice = text;
            noticeUntil = Time.time + seconds;
        }

        // Says a reply in their voice from where they stand, with its words (Vietnamese, then English) on the caption,
        // labelled as AI: generated speech is never shown as theirs (AGENTS.md rule 6).
        public void Say(AudioClip clip, string words, string english)
        {
            if (Reply == null || clip == null) return;
            replyCaption = $"<size=55%><color=#86868b>AI voice</color></size>\n{words}" +
                           (string.IsNullOrEmpty(english) ? "" : $"\n<size=70%><color=#86868b>{english}</color></size>");
            Reply.Stop();
            Reply.clip = clip;
            Reply.Play();
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
                           && t < Voice.clip.length && !Replying;
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

        void ShowCaption(string text, int lines = 2)
        {
            float fontSize = LargeCaptions ? Large : Standard;
            if (text != null && (text != CaptionText || fontSize != lastSize))
            {
                lastSize = fontSize;
                captionLabel.fontSize = fontSize;
                captionLabel.maxVisibleLines = lines;
                captionLabel.text = text;
                // Sized to the words, up to 0.56 m; never shrunk below readable size (cues are already segmented).
                var size = captionLabel.GetPreferredValues(text, MaxWidth - 2 * SidePad, 0f);
                float lineHeight = fontSize * 1.18f;
                pill.sizeDelta = new Vector2(Mathf.Min(MaxWidth, size.x + 2 * SidePad), Mathf.Max(MinHeight, Mathf.Min(size.y, lines * lineHeight) + 30f));
                ((RectTransform)captionLabel.transform).sizeDelta = new Vector2(pill.sizeDelta.x - 2 * SidePad, pill.sizeDelta.y);
            }
            CaptionText = text;
            float target = text != null ? captionOpacity : 0f;
            captionGroup.alpha = Mathf.MoveTowards(captionGroup.alpha, target, Time.deltaTime * 6f);
        }
    }
}
