using System;
using System.IO;
using LucidDreams.Tests;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace LucidDreams.Editor
{
    // Headless check of every hand gesture in the real scene with simulated hands (no headset needed).
    //   Unity -batchmode -projectPath apps/quest -executeMethod LucidDreams.Editor.HandsCheck.Run
    //     -dreamBundle /path/to/dreams/<id> -out /path/to/pngs
    // or, for the library against a bridge (an empty cache under -out is used):
    //     -bridge http://127.0.0.1:8765 -out /path/to/pngs
    [InitializeOnLoad]
    public static class HandsCheck
    {
        const string BundleKey = "LucidDreams.HandsCheck.bundle";
        const string OutKey = "LucidDreams.HandsCheck.out";
        const string BridgeKey = "LucidDreams.HandsCheck.bridge";
        const string ExpectKey = "LucidDreams.HandsCheck.expect";

        static HandsCheck()
        {
            if (!string.IsNullOrEmpty(SessionState.GetString(BundleKey, ""))) EditorApplication.update += Tick;
        }

        public static void Run()
        {
            string bridge = OptionalArg("-bridge"), output = Path.GetFullPath(Arg("-out"));
            string bundle = bridge == null ? Path.GetFullPath(Arg("-dreamBundle")) : "";
            SessionState.SetString(BundleKey, bundle == "" ? bridge : bundle);
            SessionState.SetString(OutKey, output);
            SessionState.SetString(BridgeKey, bridge ?? "");
            // An avatar bundle can come with reference poses from lucid_avatars/skinning.py to compare against.
            string expect = OptionalArg("-expect");
            SessionState.SetString(ExpectKey, expect != null ? Path.GetFullPath(expect) : "");
            EditorSceneManager.OpenScene(EditorBuildSettings.scenes[0].path);
            // In memory only; the scene file isn't saved.
            UnityEngine.Object.FindAnyObjectByType<DreamSequencePlayer>().bundle = bundle;
            if (bridge != null)
            {
                var library = UnityEngine.Object.FindAnyObjectByType<DreamLibrary>();
                library.bridgeUrl = bridge;
                library.cacheRoot = Path.Combine(output, "cache");
                if (Directory.Exists(library.cacheRoot)) Directory.Delete(library.cacheRoot, true);
            }
            EditorApplication.update += Tick;
            EditorApplication.EnterPlaymode();
        }

        static void Tick()
        {
            if (!EditorApplication.isPlaying) return;
            var driver = UnityEngine.Object.FindAnyObjectByType<HandsCheckDriver>();
            if (driver == null)
            {
                driver = new GameObject("Hands Check").AddComponent<HandsCheckDriver>();
                driver.outputDir = SessionState.GetString(OutKey, "");
                driver.libraryMode = SessionState.GetString(BridgeKey, "") != "";
                driver.expectDir = SessionState.GetString(ExpectKey, "");
                return;
            }
            if (!driver.Done) return;
            SessionState.EraseString(BundleKey);
            EditorApplication.update -= Tick;
            if (Application.isBatchMode) EditorApplication.Exit(driver.Failures == 0 ? 0 : 1);
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
