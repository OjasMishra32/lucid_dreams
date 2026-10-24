using UnityEngine;

namespace LucidDreams
{
    // Says lesson steps in the headset's own text-to-speech voice (Android TextToSpeech), never the person's voice.
    // Elsewhere (the editor) it only logs what it would say. Quietly does nothing if the engine isn't available.
    public class DeviceVoice : MonoBehaviour
    {
        public string LastSaid { get; private set; }

#if UNITY_ANDROID && !UNITY_EDITOR
        AndroidJavaObject tts;
        bool ready;
        string pending;

        class InitListener : AndroidJavaProxy
        {
            readonly DeviceVoice voice;
            public InitListener(DeviceVoice voice) : base("android.speech.tts.TextToSpeech$OnInitListener") => this.voice = voice;
            void onInit(int status) => voice.OnInit(status == 0); // TextToSpeech.SUCCESS
        }

        void Start()
        {
            try
            {
                using var unity = new AndroidJavaClass("com.unity3d.player.UnityPlayer");
                var activity = unity.GetStatic<AndroidJavaObject>("currentActivity");
                activity.Call("runOnUiThread", new AndroidJavaRunnable(() =>
                    tts = new AndroidJavaObject("android.speech.tts.TextToSpeech", activity, new InitListener(this))));
            }
            catch (System.Exception e) { Debug.LogWarning($"[Lucid Dreams] No device voice: {e.Message}"); }
        }

        void OnInit(bool ok)
        {
            ready = ok;
            if (ok && pending != null) Speak(pending);
            pending = null;
        }

        void Speak(string text)
        {
            if (!ready) { pending = text; return; }
            // QUEUE_FLUSH: a new step interrupts the old one, as speechSynthesis.cancel() does on the web.
            using var parameters = new AndroidJavaObject("android.os.Bundle");
            tts?.Call<int>("speak", text, 0, parameters, "lucid-step");
        }

        void OnDestroy()
        {
            tts?.Call("shutdown");
            tts?.Dispose();
        }
#else
        void Speak(string text) => Debug.Log($"[Lucid Dreams] Voice: {text}");
#endif

        // Says the line unless it was the last thing said; force says it again (the Again button).
        public void Say(string text, bool force = false)
        {
            if (string.IsNullOrWhiteSpace(text) || (!force && text == LastSaid)) return;
            LastSaid = text;
            Speak(text);
        }
    }
}
