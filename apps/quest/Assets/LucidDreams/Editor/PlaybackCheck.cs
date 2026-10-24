using System;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering.Universal;

namespace LucidDreams.Editor
{
    // Headless end-to-end check of the sequence player, no headset needed: plays a bundle in the real scene,
    // checks it advances at the clip's fps, and renders front and side views of a few frames to PNG.
    //   Unity -batchmode -projectPath apps/quest -executeMethod LucidDreams.Editor.PlaybackCheck.Run
    //     -dreamBundle /path/to/dreams/<id> -out /path/to/pngs [-format auto|ply|spz]
    [InitializeOnLoad]
    public static class PlaybackCheck
    {
        const string BundleKey = "LucidDreams.PlaybackCheck.bundle";
        const string OutKey = "LucidDreams.PlaybackCheck.out";
        const float TimeoutS = 120f;

        static float readyAt = -1f;
        static int startFrame;

        static PlaybackCheck()
        {
            if (!string.IsNullOrEmpty(SessionState.GetString(BundleKey, ""))) EditorApplication.update += Tick;
        }

        public static void Run()
        {
            string bundle = Arg("-dreamBundle"), output = Arg("-out");
            SessionState.SetString(BundleKey, Path.GetFullPath(bundle));
            SessionState.SetString(OutKey, Path.GetFullPath(output));
            EditorSceneManager.OpenScene(EditorBuildSettings.scenes[0].path);
            var player = UnityEngine.Object.FindAnyObjectByType<DreamSequencePlayer>();
            player.bundle = Path.GetFullPath(bundle); // in-memory only; the scene file is not saved
            string format = OptionalArg("-format");
            if (format != null) player.format = (DreamSequencePlayer.FrameFormat)Enum.Parse(typeof(DreamSequencePlayer.FrameFormat), format, true);
            EditorApplication.update += Tick;
            EditorApplication.EnterPlaymode();
        }

        static void Tick()
        {
            if (!EditorApplication.isPlaying) return;
            var player = UnityEngine.Object.FindAnyObjectByType<DreamSequencePlayer>();
            if (player == null) return;

            if (player.Error != null) Finish(1, $"player error: {player.Error}");
            else if (!player.IsReady)
            {
                if (Time.realtimeSinceStartup > TimeoutS) Finish(1, "timed out loading");
            }
            else if (readyAt < 0)
            {
                readyAt = Time.realtimeSinceStartup;
                startFrame = player.Frame;
            }
            else if (Time.realtimeSinceStartup - readyAt >= 1f)
            {
                int advanced = (player.Frame - startFrame + player.FrameCount) % player.FrameCount;
                Debug.Log($"[Lucid Dreams] Check: advanced {advanced} frames in ~1 s at 1x (clip is {player.Dream.fps} fps, {player.FrameCount} frames).");
                Render(player);
                Finish(0, "done");
            }
        }

        static void Render(DreamSequencePlayer player)
        {
            player.Pause();
            var placer = UnityEngine.Object.FindAnyObjectByType<DreamPlacer>();
            if (placer != null)
            {
                placer.enabled = false;
                placer.transform.SetPositionAndRotation(Vector3.zero, Quaternion.identity); // person faces +Z
            }

            string dir = SessionState.GetString(OutKey, "");
            Directory.CreateDirectory(dir);
            var camGo = new GameObject("Check Camera");
            var cam = camGo.AddComponent<Camera>();
            camGo.AddComponent<UniversalAdditionalCameraData>();
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = new Color(0.32f, 0.32f, 0.34f, 1f);
            cam.fieldOfView = 40f;
            cam.nearClipPlane = 0.05f;
            var rt = new RenderTexture(768, 1024, 24, RenderTextureFormat.ARGB32);
            cam.targetTexture = rt;

            int n = player.FrameCount;
            foreach (int frame in new[] { 0, n / 4, n / 2 })
            {
                player.Scrub((frame + 0.5f) / n);
                foreach (var (view, pos) in new[] { ("front", new Vector3(0, 1.0f, 3f)), ("side", new Vector3(3f, 1.0f, 0)) })
                {
                    camGo.transform.position = pos;
                    camGo.transform.LookAt(new Vector3(0, 0.9f, 0));
                    cam.Render();
                    RenderTexture.active = rt;
                    var tex = new Texture2D(rt.width, rt.height, TextureFormat.RGB24, false);
                    tex.ReadPixels(new Rect(0, 0, rt.width, rt.height), 0, 0);
                    RenderTexture.active = null;
                    File.WriteAllBytes(Path.Combine(dir, $"{player.Dream.id}-{player.LoadedFormat.ToString().ToLowerInvariant()}-f{player.Frame:000}-{view}.png"), tex.EncodeToPNG());
                    UnityEngine.Object.DestroyImmediate(tex);
                }
            }
            Debug.Log($"[Lucid Dreams] Check: renders written to {dir}");
        }

        static void Finish(int code, string message)
        {
            Debug.Log($"[Lucid Dreams] Check finished: {message}");
            SessionState.EraseString(BundleKey);
            EditorApplication.update -= Tick;
            if (Application.isBatchMode) EditorApplication.Exit(code);
            else EditorApplication.ExitPlaymode();
        }

        static string Arg(string name) => OptionalArg(name) ?? throw new ArgumentException($"Pass {name} <value>");

        static string OptionalArg(string name)
        {
            var args = Environment.GetCommandLineArgs();
            int i = Array.IndexOf(args, name);
            return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
        }
    }
}
