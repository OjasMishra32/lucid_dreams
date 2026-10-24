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
    // "Reality check" loads the bundle's reality frames (same Gaussians, imagined ones tinted blue) on first use
    // and swaps them in at the same frame; the player is the renderer's frame source, so switching is instant.
    [RequireComponent(typeof(GaussianSplat3DRenderer))]
    public class DreamSequencePlayer : MonoBehaviour, IGaussianSplat3DDeformation
    {
        public enum FrameFormat
        {
            Auto, // full-quality PLY when the bundle has every frame as PLY, otherwise SPZ
            Ply,
            Spz,
        }

        public static readonly float[] Speeds = { 0.25f, 0.5f, 1f };

        [Tooltip("Bundle folder or URL, e.g. dreams/synthetic-test or http://<mac>:5170/dreams/<id>")]
        public string bundle = "dreams/synthetic-test";
        public FrameFormat format = FrameFormat.Auto;
        public bool loadOnStart = true;
        public bool playWhenReady = true;
        public bool loop = true;
        [Tooltip("Frames downloaded and decoded at once while preloading.")]
        [Range(1, 6)] public int parallelLoads = 3;
        [Tooltip("Refuse frames (the replay plus its reality check) that would take more GPU memory than this.")]
        public int gpuBudgetMB = 3072;

        public DreamBundle Dream { get; private set; }
        public bool IsReady { get; private set; }
        public bool IsPlaying { get; private set; }
        public float Speed { get; private set; } = 1f;
        public float LoadProgress { get; private set; }
        public string Error { get; private set; }
        public FrameFormat LoadedFormat { get; private set; }
        public int FrameCount => sequence?.FrameCount ?? 0;
        public int Frame => sequence?.Current ?? 0;
        public float Duration => Dream != null && Dream.fps > 0 ? FrameCount / Dream.fps : 0f;
        public float NormalizedTime => Duration > 0 ? time / Duration : 0f;

        public bool HasReality => IsReady && !string.IsNullOrEmpty(Dream.frames?.reality);
        public bool ShowingReality { get; private set; }
        public bool RealityLoading { get; private set; }
        public float RealityProgress { get; private set; }
        public string RealityError { get; private set; }
        // Share of the person the camera really saw (0-1), or a negative number when the bundle doesn't say.
        public float SeenFraction => Dream?.metrics != null && Dream.metrics.seenFraction > 0f ? Dream.metrics.seenFraction : -1f;

        public event Action Ready;

        class LoadResult
        {
            public DreamSequence sequence;
            public GaussianFrame first;
            public Bounds bounds;
            public int overflow;
            public string error;
        }

        GaussianSplat3DRenderer splat;
        DreamSequence sequence, reality;
        LoadResult loading, realityLoading;
        GaussianSplat3DAsset canonical;
        string baseUrl;
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
            baseUrl = ResolveBase(location);
            StartCoroutine(LoadRoutine());
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

        // Seen vs imagined. The first time, the reality frames load (playback carries on meanwhile).
        public void ToggleReality()
        {
            if (!HasReality || RealityLoading) return;
            if (ShowingReality) ShowingReality = false;
            else if (reality != null) ShowingReality = true;
            else StartCoroutine(LoadReality());
        }

        public bool TryGetFrame(GaussianSplat3DAsset asset, out GaussianSplat3DFrame frame)
        {
            var shown = ShowingReality && reality != null ? reality : sequence;
            frame = default;
            return shown != null && shown.TryGetFrame(asset, out frame);
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

        void ShowTime()
        {
            int frame = Mathf.Min((int)(time * Dream.fps), FrameCount - 1);
            sequence.Show(frame);
            reality?.Show(frame);
        }

        IEnumerator LoadRoutine()
        {
            Error = null;
            LoadProgress = 0f;

            string json = null;
            yield return Fetch($"{baseUrl}/dream.json", bytes => json = System.Text.Encoding.UTF8.GetString(bytes), Fail);
            if (json == null) yield break;
            Dream = DreamBundle.FromJson(json);
            if (!Dream.IsReplay || Dream.frames == null || Dream.frameCount <= 0 || Dream.fps <= 0)
            {
                Fail($"'{Dream.id}' is not a playable replay (kind {Dream.kind}, {Dream.frameCount} frames at {Dream.fps} fps)");
                yield break;
            }

            var chosen = format;
            if (chosen == FrameFormat.Auto)
            {
                bool hasPly = false;
                if (!string.IsNullOrEmpty(Dream.frames.pattern))
                    yield return Exists($"{baseUrl}/{Dream.FramePath(Dream.frameCount - 1)}", found => hasPly = found);
                chosen = hasPly || string.IsNullOrEmpty(Dream.frames.spz) ? FrameFormat.Ply : FrameFormat.Spz;
            }
            string pattern = chosen == FrameFormat.Spz ? Dream.frames.spz : Dream.frames.pattern;
            if (string.IsNullOrEmpty(pattern))
            {
                Fail($"'{Dream.id}' has no {chosen} frames");
                yield break;
            }
            Func<byte[], GaussianFrame> decoder = chosen == FrameFormat.Spz ? SpzFrameReader.Read : PlyFrameReader.Read;
            LoadedFormat = chosen;

            int capacity = Mathf.Max(1, Dream.frames.gaussiansPerFrame);
            while (true)
            {
                loading = new LoadResult();
                yield return Fill(pattern, decoder, capacity, (long)gpuBudgetMB << 20, loading, p => LoadProgress = p);
                var result = loading;
                loading = null;
                if (result.error != null)
                {
                    result.sequence?.Dispose();
                    Fail(result.error);
                    yield break;
                }
                if (result.overflow > 0)
                {
                    // dream.json under-reported the largest frame: reload at the real size rather than drop Gaussians.
                    Debug.LogWarning($"[Lucid Dreams] '{Dream.id}' has frames with {result.overflow:N0} Gaussians (dream.json says {capacity:N0}); reloading.");
                    result.sequence?.Dispose();
                    capacity = result.overflow;
                    continue;
                }

                sequence = result.sequence;
                result.bounds.Expand(0.2f); // splat extents reach past their centres
                canonical = sequence.CreateCanonicalAsset(result.first, result.bounds, Dream.id);
                splat.m_Asset = canonical;
                splat.SetDeformation(this);
                break;
            }

            time = 0f;
            sequence.Show(0);
            IsReady = true;
            Debug.Log($"[Lucid Dreams] '{Dream.name}' ready: {Dream.frameCount} {LoadedFormat} frames, {sequence.Capacity:N0} Gaussians, {sequence.GpuBytes >> 20} MB on the GPU.");
            Ready?.Invoke();
            if (playWhenReady) Play();
        }

        IEnumerator LoadReality()
        {
            RealityLoading = true;
            RealityError = null;
            RealityProgress = 0f;
            realityLoading = new LoadResult();
            long budgetLeft = ((long)gpuBudgetMB << 20) - sequence.GpuBytes;
            yield return Fill(Dream.frames.reality, SpzFrameReader.Read, sequence.Capacity, budgetLeft, realityLoading, p => RealityProgress = p);
            var result = realityLoading;
            realityLoading = null;
            RealityLoading = false;

            if (result.error != null || result.overflow > 0)
            {
                result.sequence?.Dispose();
                RealityError = result.error ?? $"reality frames have {result.overflow:N0} Gaussians, the replay {sequence.Capacity:N0}";
                Debug.LogError($"[Lucid Dreams] Reality check unavailable: {RealityError}");
                yield break;
            }
            reality = result.sequence;
            reality.Show(sequence.Current);
            ShowingReality = true;
            Debug.Log($"[Lucid Dreams] Reality check ready: {reality.GpuBytes >> 20} MB more on the GPU.");
        }

        // Downloads and decodes every frame of one per-frame pattern into a GPU sequence, a few at a time.
        IEnumerator Fill(string pattern, Func<byte[], GaussianFrame> decoder, int capacity, long budget, LoadResult result, Action<float> progress)
        {
            int next = 0, done = 0, running = 0;

            IEnumerator LoadFrame(int index)
            {
                byte[] data = null;
                yield return Fetch($"{baseUrl}/{Dream.FramePath(index, pattern)}", bytes => data = bytes, e => result.error ??= e);
                if (data == null || result.error != null) yield break;
                var decode = Task.Run(() => decoder(data));
                while (!decode.IsCompleted) yield return null;
                if (decode.IsFaulted)
                {
                    result.error ??= $"Frame {index}: {decode.Exception?.GetBaseException().Message}";
                    yield break;
                }
                var frame = decode.Result;
                if (frame.count > capacity)
                {
                    result.overflow = Mathf.Max(result.overflow, frame.count);
                    yield break;
                }
                if (result.sequence == null)
                {
                    result.sequence = new DreamSequence(Dream.frameCount, capacity, frame.coefficientCount);
                    if (result.sequence.GpuBytes > budget)
                    {
                        int fits = (int)(Math.Max(0, budget) / Dream.frameCount / (result.sequence.BytesPerFrame / capacity));
                        result.error ??= $"'{Dream.id}' needs {result.sequence.GpuBytes >> 20} MB of GPU memory ({Dream.frameCount} frames x {capacity:N0} Gaussians); " +
                                         $"the budget left fits {fits:N0} Gaussians per frame";
                        yield break;
                    }
                }
                try { result.sequence.Upload(index, frame); }
                catch (Exception e) { result.error ??= $"Frame {index}: {e.Message}"; yield break; }
                if (index == 0) result.first = frame;
                if (result.sequence.LoadedCount == 1) result.bounds = frame.bounds; else result.bounds.Encapsulate(frame.bounds);
                done++;
                progress((float)done / Dream.frameCount);
            }

            while (result.error == null && (next < Dream.frameCount || running > 0))
            {
                while (running < parallelLoads && next < Dream.frameCount)
                {
                    running++;
                    StartCoroutine(Track(LoadFrame(next++), () => running--));
                }
                yield return null;
            }
            while (running > 0) yield return null; // let in-flight frames finish before anyone frees their buffers
        }

        IEnumerator Track(IEnumerator routine, Action finished)
        {
            yield return routine;
            finished();
        }

        static IEnumerator Fetch(string url, Action<byte[]> received, Action<string> failed)
        {
            using var request = UnityWebRequest.Get(url);
            yield return request.SendWebRequest();
            if (request.result != UnityWebRequest.Result.Success) failed($"Couldn't load {url}: {request.error}");
            else received(request.downloadHandler.data);
        }

        // Local files are checked on disk; anything else (bridge, StreamingAssets in the APK) with a HEAD request.
        static IEnumerator Exists(string url, Action<bool> answer)
        {
            if (url.StartsWith("file://"))
            {
                answer(File.Exists(new Uri(url).LocalPath));
                yield break;
            }
            using var request = UnityWebRequest.Head(url);
            yield return request.SendWebRequest();
            answer(request.result == UnityWebRequest.Result.Success);
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
            ShowingReality = false;
            RealityLoading = false;
            if (splat != null)
            {
                splat.SetDeformation(null);
                if (splat.m_Asset == canonical) splat.m_Asset = null;
            }
            foreach (var s in new[] { sequence, reality, loading?.sequence, realityLoading?.sequence }) s?.Dispose();
            sequence = reality = null;
            loading = realityLoading = null;
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
