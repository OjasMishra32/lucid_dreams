using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using UnityEngine;
using UnityEngine.Networking;

namespace LucidDreams
{
    // The dreams on the bridge (GET /api/dreams) plus the ones already on the headset. Downloads a bundle's SPZ frames,
    // reality frames, plan and thumb into the app's storage (never the multi-GB PLYs), so cached dreams play offline.
    // A download lands in "<id>.part" and is renamed only once complete, so a half-copied bundle never shows as ready.
    public class DreamLibrary : MonoBehaviour
    {
        public class Entry
        {
            public DreamBundle dream;
            public string id;
            public bool online, cached, downloading;
            public float progress;
            public string error;
            public Texture2D thumb;
        }

        [Serializable]
        class DreamList { public DreamBundle[] items; }

        [Tooltip("The bridge on the Mac, e.g. http://192.168.1.20:5170. A bridge.txt in the app's storage overrides it.")]
        public string bridgeUrl = "";
        [Tooltip("Where bundles are kept. Empty: <app storage>/dreams.")]
        public string cacheRoot = "";
        public DreamSequencePlayer player;
        [Tooltip("The second person, for Bring in another.")]
        public DreamCompanion companion;
        [Range(1, 8)] public int parallelDownloads = 4;

        public IReadOnlyList<Entry> Entries => entries;
        public bool Online { get; private set; }
        public bool Refreshing { get; private set; }
        public string PlayingId { get; private set; }
        public string CompanionId => companion != null && companion.Present ? companion.Id : null;
        public string Bridge => bridgeUrl;
        public event Action Changed;
        // Nothing playable at start: the library panel opens itself until you pick a dream.
        public bool WaitingForPick { get; private set; }

        const string LastPlayedKey = "LucidDreams.lastPlayed";
        static readonly Regex SafeId = new(@"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$");
        readonly List<Entry> entries = new();

        void Awake()
        {
            if (string.IsNullOrEmpty(cacheRoot)) cacheRoot = Path.Combine(Application.persistentDataPath, "dreams");
            string overrideFile = Path.Combine(Application.persistentDataPath, "bridge.txt");
            if (File.Exists(overrideFile)) bridgeUrl = File.ReadAllText(overrideFile).Trim();
            bridgeUrl = bridgeUrl.TrimEnd('/');
        }

        void Start()
        {
            Directory.CreateDirectory(cacheRoot);
            Refresh();
            // A bundle set on the player (tests, a pinned demo) wins; otherwise the last dream you played, if it's here.
            if (player != null && string.IsNullOrEmpty(player.bundle))
            {
                string last = PlayerPrefs.GetString(LastPlayedKey, "");
                if (IsCached(last)) Play(last);
                else WaitingForPick = true;
            }
        }

        public void Refresh()
        {
            if (!Refreshing) StartCoroutine(RefreshRoutine());
        }

        public void Download(Entry e)
        {
            if (e == null || e.downloading || !e.online) return;
            StartCoroutine(DownloadRoutine(e));
        }

        public void Play(Entry e)
        {
            if (e != null && e.cached) Play(e.id);
        }

        void Play(string id)
        {
            if (id == CompanionId) companion.Dismiss(); // they become the one you're with
            PlayingId = id;
            WaitingForPick = false;
            PlayerPrefs.SetString(LastPlayedKey, id);
            player.Load(Path.Combine(cacheRoot, id));
            Changed?.Invoke();
        }

        // A second person next to the one playing, on the same clock.
        public void BringIn(Entry e)
        {
            if (companion == null || e == null || !e.cached || !Playable(e.dream) || e.id == PlayingId) return;
            companion.Load(Path.Combine(cacheRoot, e.id), e.id);
            Changed?.Invoke();
        }

        public void SendAway()
        {
            if (companion == null || !companion.Present) return;
            companion.Dismiss();
            Changed?.Invoke();
        }

        // Replays, and avatars that carry skinning (skin.bin, skeleton.json, motion.json).
        public static bool Playable(DreamBundle d) =>
            d != null && (d.IsReplay || (d.IsAvatar && d.avatar != null && !string.IsNullOrEmpty(d.avatar.skin)
                                         && !string.IsNullOrEmpty(d.avatar.skeleton) && !string.IsNullOrEmpty(d.avatar.motion)));

        IEnumerable<Entry> Ready => entries.Where(e => e.cached && Playable(e.dream));
        public int PlayableCount => Ready.Count();

        // The previous or next person on this headset, in library order (wrapping).
        public void PlayAdjacent(int direction)
        {
            var ready = Ready.ToList();
            if (ready.Count == 0) return;
            int at = ready.FindIndex(e => e.id == PlayingId);
            var target = ready[((at < 0 ? 0 : at + direction) % ready.Count + ready.Count) % ready.Count];
            if (target.id != PlayingId) Play(target);
        }

        public bool IsCached(string id) => !string.IsNullOrEmpty(id) && SafeId.IsMatch(id) && File.Exists(Path.Combine(cacheRoot, id, "dream.json"));

        IEnumerator RefreshRoutine()
        {
            Refreshing = true;
            Changed?.Invoke();
            DreamBundle[] online = null;
            if (!string.IsNullOrEmpty(bridgeUrl))
            {
                using var request = UnityWebRequest.Get($"{bridgeUrl}/api/dreams");
                request.timeout = 6;
                yield return request.SendWebRequest();
                if (request.result == UnityWebRequest.Result.Success)
                {
                    try { online = JsonUtility.FromJson<DreamList>($"{{\"items\":{request.downloadHandler.text}}}").items; }
                    catch (Exception ex) { Debug.LogWarning($"[Lucid Dreams] Bridge list unreadable: {ex.Message}"); }
                }
                else Debug.Log($"[Lucid Dreams] Bridge unreachable ({request.error}); showing downloaded dreams.");
            }
            Online = online != null;

            // Online dreams in the bridge's order (newest first), then anything only on the headset.
            var next = new List<Entry>();
            foreach (var d in online ?? Array.Empty<DreamBundle>())
                if (d != null && SafeId.IsMatch(d.id ?? "")) next.Add(Merge(d.id, d, true));
            foreach (var dir in Directory.GetDirectories(cacheRoot).OrderByDescending(Directory.GetLastWriteTimeUtc))
            {
                string id = Path.GetFileName(dir);
                if (next.Any(x => x.id == id) || !IsCached(id)) continue;
                var local = ReadLocal(id);
                if (local != null) next.Add(Merge(id, local, false));
            }
            entries.Clear();
            entries.AddRange(next);
            Refreshing = false;
            Changed?.Invoke();
            foreach (var e in entries.Where(x => x.thumb == null).ToList()) StartCoroutine(LoadThumb(e));
        }

        Entry Merge(string id, DreamBundle dream, bool online)
        {
            var existing = entries.FirstOrDefault(x => x.id == id);
            var e = existing ?? new Entry { id = id };
            e.dream = dream;
            e.online = online;
            e.cached = IsCached(id);
            return e;
        }

        DreamBundle ReadLocal(string id)
        {
            try { return DreamBundle.FromJson(File.ReadAllText(Path.Combine(cacheRoot, id, "dream.json"))); }
            catch { return null; }
        }

        IEnumerator LoadThumb(Entry e)
        {
            if (string.IsNullOrEmpty(e.dream.thumb)) yield break;
            string local = Path.Combine(cacheRoot, e.id, e.dream.thumb);
            string url = File.Exists(local) ? new Uri(local).AbsoluteUri : e.online ? $"{bridgeUrl}/dreams/{e.id}/{e.dream.thumb}" : null;
            if (url == null) yield break;
            using var request = UnityWebRequestTexture.GetTexture(url);
            yield return request.SendWebRequest();
            if (request.result != UnityWebRequest.Result.Success) yield break;
            e.thumb = DownloadHandlerTexture.GetContent(request);
            Changed?.Invoke();
        }

        // Every file a headset player uses, as (path, required). PLY frames stay on the Mac: SPZ is what streams.
        static List<(string path, bool required)> FilesOf(DreamBundle d)
        {
            var files = new List<(string, bool)>();
            void Add(string f, bool required) { if (!string.IsNullOrEmpty(f)) files.Add((f, required)); }
            Add(d.thumb, false);
            Add(d.experience, false);
            Add(d.guide, false);
            Add(d.audio, false);
            Add(d.voice, false);
            Add(d.captions, false);
            Add(d.props, false);
            if (d.IsReplay && d.frames != null && !string.IsNullOrEmpty(d.frames.spz))
                for (int i = 0; i < d.frameCount; i++)
                {
                    Add(d.FramePath(i, d.frames.spz), true);
                    Add(d.FramePath(i, d.frames.reality), true);
                }
            if (d.IsAvatar && d.avatar != null)
            {
                Add(d.avatar.file, true);
                Add(d.avatar.motion, true);
                Add(d.avatar.skin, true);
                Add(d.avatar.skeleton, true);
                Add(d.avatar.reality, false);
            }
            return files;
        }

        IEnumerator DownloadRoutine(Entry e)
        {
            e.downloading = true;
            e.error = null;
            e.progress = 0f;
            Changed?.Invoke();

            string part = Path.Combine(cacheRoot, e.id + ".part");
            string final = Path.Combine(cacheRoot, e.id);
            string baseUrl = $"{bridgeUrl}/dreams/{e.id}";

            // dream.json first (to know the files) but written last: it's what marks the bundle as here.
            string json = null;
            using (var request = UnityWebRequest.Get($"{baseUrl}/dream.json"))
            {
                yield return request.SendWebRequest();
                if (request.result == UnityWebRequest.Result.Success) json = request.downloadHandler.text;
                else e.error = request.error;
            }
            var dream = json != null ? DreamBundle.FromJson(json) : null;
            var files = dream != null ? FilesOf(dream) : new List<(string, bool)>();
            if (dream != null && dream.IsReplay && string.IsNullOrEmpty(dream.frames?.spz)) e.error = "This dream has no SPZ frames to stream";

            var progress = new float[files.Count];
            int next = 0, running = 0;
            IEnumerator Fetch(int index)
            {
                var (path, required) = files[index];
                string target = Path.Combine(part, path);
                if (File.Exists(target)) { progress[index] = 1f; yield break; } // resumed download
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                using var request = new UnityWebRequest($"{baseUrl}/{path}", UnityWebRequest.kHttpVerbGET)
                {
                    downloadHandler = new DownloadHandlerFile(target + ".tmp") { removeFileOnAbort = true },
                };
                var op = request.SendWebRequest();
                while (!op.isDone)
                {
                    progress[index] = request.downloadProgress;
                    yield return null;
                }
                if (request.result == UnityWebRequest.Result.Success)
                {
                    File.Move(target + ".tmp", target);
                    progress[index] = 1f;
                }
                else
                {
                    if (File.Exists(target + ".tmp")) File.Delete(target + ".tmp");
                    progress[index] = 1f;
                    if (required) e.error ??= $"{path}: {request.error}";
                }
            }

            while (e.error == null && (next < files.Count || running > 0))
            {
                while (running < parallelDownloads && next < files.Count)
                {
                    running++;
                    StartCoroutine(Track(Fetch(next++), () => running--));
                }
                e.progress = files.Count > 0 ? progress.Sum() / files.Count : 1f;
                yield return null;
            }
            while (running > 0) yield return null;

            if (e.error == null)
            {
                File.WriteAllText(Path.Combine(part, "dream.json"), json);
                if (Directory.Exists(final)) Directory.Delete(final, true);
                Directory.Move(part, final);
                e.cached = true;
                e.dream = dream;
                Debug.Log($"[Lucid Dreams] Downloaded '{dream.name}' ({files.Count} files).");
            }
            else Debug.LogWarning($"[Lucid Dreams] Download of '{e.id}' failed: {e.error}");
            e.downloading = false;
            e.progress = e.error == null ? 1f : 0f;
            Changed?.Invoke();
        }

        static IEnumerator Track(IEnumerator routine, Action finished)
        {
            yield return routine;
            finished();
        }
    }
}
