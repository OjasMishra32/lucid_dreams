using System;
using System.Collections;
using System.IO;
using System.Threading.Tasks;
using Gaussians.ThreeD;
using UnityEngine;
using UnityEngine.Networking;

namespace LucidDreams
{
    // Loads every frame of a replay bundle before playing, then plays it at the clip's fps.
    // The bundle can be an http(s) URL (the bridge), an absolute folder, or a path relative to the app's
    // persistent data (where downloaded bundles live) or StreamingAssets.
    [RequireComponent(typeof(GaussianSplat3DRenderer))]
    public class DreamSequencePlayer : MonoBehaviour
    {
        public static readonly float[] Speeds = { 0.25f, 0.5f, 1f };

        [Tooltip("Bundle folder or URL, e.g. dreams/synthetic-test or http://<mac>:5170/dreams/<id>")]
        public string bundle = "dreams/synthetic-test";
        public bool loadOnStart = true;
        public bool playWhenReady = true;
        public bool loop = true;
        [Tooltip("Frames downloaded and decoded at once while preloading.")]
        [Range(1, 6)] public int parallelLoads = 3;
        [Tooltip("Refuse bundles whose frames would take more GPU memory than this.")]
        public int gpuBudgetMB = 3072;

        public DreamBundle Dream { get; private set; }
        public bool IsReady { get; private set; }
        public bool IsPlaying { get; private set; }
        public float Speed { get; private set; } = 1f;
        public float LoadProgress { get; private set; }
        public string Error { get; private set; }
        public int FrameCount => sequence?.FrameCount ?? 0;
        public int Frame => sequence?.Current ?? 0;
        public float Duration => Dream != null && Dream.fps > 0 ? FrameCount / Dream.fps : 0f;
        public float NormalizedTime => Duration > 0 ? time / Duration : 0f;

        public event Action Ready;

        GaussianSplat3DRenderer splat;
        DreamSequence sequence;
        GaussianSplat3DAsset canonical;
        float time;

        void Awake() => splat = GetComponent<GaussianSplat3DRenderer>();

        void Start()
        {
            if (loadOnStart && !string.IsNullOrEmpty(bundle)) Load(bundle);
        }

        public void Load(string location)
        {
            StopAllCoroutines();
            Release();
            bundle = location;
            StartCoroutine(LoadRoutine(ResolveBase(location)));
        }

        public void Play() { if (IsReady) IsPlaying = true; }
        public void Pause() => IsPlaying = false;
        public void TogglePlay() { if (IsPlaying) Pause(); else Play(); }

        public void SetSpeed(float speed) => Speed = Mathf.Clamp(speed, Speeds[0], Speeds[Speeds.Length - 1]);

        public void CycleSpeed()
        {
            int i = Array.IndexOf(Speeds, Speed);
            SetSpeed(Speeds[(i + 1) % Speeds.Length]);
        }

        // Scrubbing holds the frame under the finger; playback resumes from there if it was playing.
        public void Scrub(float normalized)
        {
            if (!IsReady) return;
            time = Mathf.Clamp01(normalized) * Duration;
            ShowTime();
        }

        public void Step(int frames)
        {
            if (!IsReady) return;
            Pause();
            time = (Mathf.Clamp(Frame + frames, 0, FrameCount - 1) + 0.5f) / Dream.fps;
            ShowTime();
        }

        void Update()
        {
            if (!IsReady || !IsPlaying) return;
            time += Time.deltaTime * Speed;
            if (time >= Duration)
            {
                if (loop) time %= Duration;
                else { time = Duration; Pause(); }
            }
            ShowTime();
        }

        void ShowTime() => sequence.Show(Mathf.Min((int)(time * Dream.fps), FrameCount - 1));

        IEnumerator LoadRoutine(string baseUrl)
        {
            Error = null;
            LoadProgress = 0f;

            string json = null;
            yield return Fetch($"{baseUrl}/dream.json", bytes => json = System.Text.Encoding.UTF8.GetString(bytes));
            if (json == null) yield break;
            Dream = DreamBundle.FromJson(json);
            if (!Dream.IsReplay || Dream.frames == null || Dream.frameCount <= 0 || Dream.fps <= 0)
            {
                Fail($"'{Dream.id}' is not a playable replay (kind {Dream.kind}, {Dream.frameCount} frames at {Dream.fps} fps)");
                yield break;
            }

            int capacity = Mathf.Max(1, Dream.frames.gaussiansPerFrame);
            while (true)
            {
                int overflow = 0;
                GaussianFrame first = null;
                var bounds = new Bounds();
                int next = 0, done = 0;

                IEnumerator LoadFrame(int index)
                {
                    byte[] data = null;
                    yield return Fetch($"{baseUrl}/{Dream.FramePath(index)}", bytes => data = bytes);
                    if (data == null) yield break;
                    var decode = Task.Run(() => PlyFrameReader.Read(data));
                    while (!decode.IsCompleted) yield return null;
                    if (decode.IsFaulted)
                    {
                        Fail($"Frame {index}: {decode.Exception?.GetBaseException().Message}");
                        yield break;
                    }
                    var frame = decode.Result;
                    if (frame.count > capacity) overflow = Mathf.Max(overflow, frame.count);
                    else
                    {
                        if (sequence == null)
                        {
                            sequence = new DreamSequence(Dream.frameCount, capacity, frame.coefficientCount);
                            long budget = (long)gpuBudgetMB << 20;
                            if (sequence.GpuBytes > budget)
                            {
                                int fits = (int)(budget / Dream.frameCount / (sequence.BytesPerFrame / capacity));
                                Fail($"'{Dream.id}' needs {sequence.GpuBytes >> 20} MB of GPU memory ({Dream.frameCount} frames x {capacity:N0} Gaussians); " +
                                     $"the {gpuBudgetMB} MB budget fits {fits:N0} Gaussians per frame");
                                yield break;
                            }
                        }
                        try { sequence.Upload(index, frame); }
                        catch (Exception e) { Fail($"Frame {index}: {e.Message}"); yield break; }
                        if (index == 0) first = frame;
                        if (sequence.LoadedCount == 1) bounds = frame.bounds; else bounds.Encapsulate(frame.bounds);
                    }
                    done++;
                    LoadProgress = (float)done / Dream.frameCount;
                }

                int running = 0;
                while (Error == null && (next < Dream.frameCount || running > 0))
                {
                    while (running < parallelLoads && next < Dream.frameCount)
                    {
                        running++;
                        StartCoroutine(Track(LoadFrame(next++), () => running--));
                    }
                    yield return null;
                }
                if (Error != null)
                {
                    while (running > 0) yield return null; // let in-flight frames finish before freeing their buffers
                    Release();
                    yield break;
                }

                if (overflow > 0)
                {
                    // dream.json under-reported the largest frame: reload at the real size rather than drop Gaussians.
                    Debug.LogWarning($"[Lucid Dreams] '{Dream.id}' has frames with {overflow:N0} Gaussians (dream.json says {capacity:N0}); reloading.");
                    Release();
                    capacity = overflow;
                    continue;
                }

                bounds.Expand(0.2f); // splat extents reach past their centres
                canonical = sequence.CreateCanonicalAsset(first, bounds, Dream.id);
                splat.m_Asset = canonical;
                splat.SetDeformation(sequence);
                break;
            }

            time = 0f;
            sequence.Show(0);
            IsReady = true;
            Debug.Log($"[Lucid Dreams] '{Dream.name}' ready: {Dream.frameCount} frames, {sequence.Capacity:N0} Gaussians, {sequence.GpuBytes >> 20} MB on the GPU.");
            Ready?.Invoke();
            if (playWhenReady) Play();
        }

        IEnumerator Track(IEnumerator routine, Action finished)
        {
            yield return routine;
            finished();
        }

        IEnumerator Fetch(string url, Action<byte[]> received)
        {
            using var request = UnityWebRequest.Get(url);
            yield return request.SendWebRequest();
            if (request.result != UnityWebRequest.Result.Success) Fail($"Couldn't load {url}: {request.error}");
            else received(request.downloadHandler.data);
        }

        void Fail(string message)
        {
            if (Error != null) return;
            Error = message;
            Debug.LogError($"[Lucid Dreams] {message}");
        }

        static string ResolveBase(string location)
        {
            location = location.TrimEnd('/');
            if (location.StartsWith("http://") || location.StartsWith("https://") || location.StartsWith("file://") || location.StartsWith("jar:"))
                return location;
            if (Path.IsPathRooted(location)) return new Uri(location).AbsoluteUri;

            string downloaded = Path.Combine(Application.persistentDataPath, location);
            if (Directory.Exists(downloaded)) return new Uri(downloaded).AbsoluteUri;

            string streaming = $"{Application.streamingAssetsPath}/{location}";
            return streaming.Contains("://") ? streaming : new Uri(streaming).AbsoluteUri;
        }

        void Release()
        {
            IsReady = false;
            IsPlaying = false;
            if (splat != null)
            {
                splat.SetDeformation(null);
                if (splat.m_Asset == canonical) splat.m_Asset = null;
            }
            sequence?.Dispose();
            sequence = null;
            if (canonical != null)
            {
                Destroy(canonical.floatSplats);
                Destroy(canonical.floatSH);
                Destroy(canonical);
                canonical = null;
            }
        }

        void OnDestroy() => Release();
    }
}
