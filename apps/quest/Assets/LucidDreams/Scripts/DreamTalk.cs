using System;
using System.Collections;
using System.IO;
using UnityEngine;
using UnityEngine.Networking;

namespace LucidDreams
{
    // Talk with them (companion mode): press Talk on the palm menu, say something, press Send. What you said goes to the
    // talk server on a Mac (apps/talk: it holds the API keys, so they never ship in the app), which hears you, writes
    // their reply and speaks it in their own cloned voice; the reply plays from their mouth with the words, labelled
    // "AI voice", on the caption. The server's address and token come from talk.txt in the app's storage
    // (http://<mac>:5175/?token=<TALK_TOKEN>), as bridge.txt does for the bridge; no file, no Talk button.
    public class DreamTalk : MonoBehaviour
    {
        public enum State { Idle, Listening, Thinking }

        const int Rate = 16000;
        const int MaxSeconds = 20;

        public DreamSequencePlayer player;
        public DreamSpeech speech;
        [Tooltip("The talk server, e.g. http://192.168.1.20:5175/?token=..., overridden by talk.txt in the app's storage.")]
        public string server = "";

        public State Current { get; private set; }
        public string LastHeard { get; private set; }
        public string LastReply { get; private set; }
        public string Error { get; private set; }
        // Talk is offered with someone you're with (companion), when a talk server is set up.
        public bool Available => !string.IsNullOrEmpty(server) && player != null && player.IsReady && player.Experience?.mode == "companion";

        string baseUrl, token, mic;
        AudioClip recording;
        readonly string session = Guid.NewGuid().ToString("N");

        void Start()
        {
            string file = Path.Combine(Application.persistentDataPath, "talk.txt");
            if (File.Exists(file)) server = File.ReadAllText(file).Trim();
            Configure(server);
        }

        // Splits http://host:port/?token=abc into the base URL and the token.
        public void Configure(string address)
        {
            server = address ?? "";
            if (string.IsNullOrEmpty(server)) return;
            if (!Uri.TryCreate(server, UriKind.Absolute, out var uri))
            {
                Debug.LogWarning($"[Lucid Dreams] talk.txt isn't an address: {server}");
                server = "";
                return;
            }
            baseUrl = uri.GetLeftPart(UriPartial.Authority);
            token = "";
            foreach (var pair in uri.Query.TrimStart('?').Split('&'))
                if (pair.StartsWith("token=")) token = Uri.UnescapeDataString(pair.Substring(6));
        }

        // The palm menu's Talk button: start listening, then send what you said.
        public void Press()
        {
            if (Current == State.Idle) Listen();
            else if (Current == State.Listening) StartCoroutine(SendRecording());
        }

        void Listen()
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            if (!UnityEngine.Android.Permission.HasUserAuthorizedPermission(UnityEngine.Android.Permission.Microphone))
            {
                UnityEngine.Android.Permission.RequestUserPermission(UnityEngine.Android.Permission.Microphone);
                return; // press Talk again once you've allowed it
            }
#endif
            if (Microphone.devices.Length == 0) { Error = "No microphone"; return; }
            mic = Microphone.devices[0];
            recording = Microphone.Start(mic, false, MaxSeconds, Rate);
            Error = null;
            Current = State.Listening;
        }

        IEnumerator SendRecording()
        {
            int samples = Microphone.GetPosition(mic);
            Microphone.End(mic);
            if (samples <= Rate / 4) { Current = State.Idle; yield break; } // under a quarter second: nothing said
            var data = new float[samples * recording.channels];
            recording.GetData(data, 0);
            yield return Ask(Wav(data, recording.channels, Rate));
        }

        // Sends a recording (WAV bytes) and has them answer. Checks call it with a recorded question.
        public IEnumerator Ask(byte[] wav)
        {
            Current = State.Thinking;
            Error = null;
            string query = $"token={Uri.EscapeDataString(token ?? "")}&session={session}";
            using (var post = new UnityWebRequest($"{baseUrl}/api/talk?{query}", "POST"))
            {
                post.uploadHandler = new UploadHandlerRaw(wav) { contentType = "audio/wav" };
                post.downloadHandler = new DownloadHandlerBuffer();
                post.timeout = 30;
                yield return post.SendWebRequest();
                if (post.result != UnityWebRequest.Result.Success)
                {
                    Error = $"{post.error} {post.downloadHandler.text}";
                    Current = State.Idle;
                    yield break;
                }
                var reply = JsonUtility.FromJson<Reply>(post.downloadHandler.text);
                LastHeard = reply.heard;
                LastReply = reply.reply;
                if (string.IsNullOrEmpty(reply.audio)) { Current = State.Idle; yield break; } // nothing heard
                using var get = UnityWebRequestMultimedia.GetAudioClip($"{baseUrl}{reply.audio}?token={Uri.EscapeDataString(token ?? "")}", AudioType.WAV);
                yield return get.SendWebRequest();
                if (get.result != UnityWebRequest.Result.Success)
                {
                    Error = get.error;
                    Current = State.Idle;
                    yield break;
                }
                speech.Say(DownloadHandlerAudioClip.GetContent(get), reply.reply, reply.english);
            }
            Current = State.Idle;
        }

        [Serializable]
        class Reply
        {
            public string heard, reply, english, audio;
        }

        // 16-bit PCM WAV, mixed down to mono.
        public static byte[] Wav(float[] interleaved, int channels, int rate)
        {
            int frames = interleaved.Length / channels;
            using var stream = new MemoryStream(44 + frames * 2);
            using var w = new BinaryWriter(stream);
            w.Write("RIFF".ToCharArray());
            w.Write(36 + frames * 2);
            w.Write("WAVEfmt ".ToCharArray());
            w.Write(16);
            w.Write((short)1);
            w.Write((short)1);
            w.Write(rate);
            w.Write(rate * 2);
            w.Write((short)2);
            w.Write((short)16);
            w.Write("data".ToCharArray());
            w.Write(frames * 2);
            for (int i = 0; i < frames; i++)
            {
                float s = 0f;
                for (int c = 0; c < channels; c++) s += interleaved[i * channels + c];
                w.Write((short)Mathf.Clamp(Mathf.RoundToInt(s / channels * 32767f), short.MinValue, short.MaxValue));
            }
            return stream.ToArray();
        }
    }
}
