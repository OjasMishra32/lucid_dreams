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
    [InitializeOnLoad]
    public static class HandsCheck
    {
        const string BundleKey = "LucidDreams.HandsCheck.bundle";
        const string OutKey = "LucidDreams.HandsCheck.out";

        static HandsCheck()
        {
            if (!string.IsNullOrEmpty(SessionState.GetString(BundleKey, ""))) EditorApplication.update += Tick;
        }

        public static void Run()
        {
            string bundle = Path.GetFullPath(Arg("-dreamBundle")), output = Path.GetFullPath(Arg("-out"));
            SessionState.SetString(BundleKey, bundle);
            SessionState.SetString(OutKey, output);
            EditorSceneManager.OpenScene(EditorBuildSettings.scenes[0].path);
            UnityEngine.Object.FindAnyObjectByType<DreamSequencePlayer>().bundle = bundle; // in memory; the scene isn't saved
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
                return;
            }
            if (!driver.Done) return;
            SessionState.EraseString(BundleKey);
            EditorApplication.update -= Tick;
            if (Application.isBatchMode) EditorApplication.Exit(driver.Failures == 0 ? 0 : 1);
            else EditorApplication.ExitPlaymode();
        }

        static string Arg(string name)
        {
            var args = Environment.GetCommandLineArgs();
            int i = Array.IndexOf(args, name);
            if (i < 0 || i + 1 >= args.Length) throw new ArgumentException($"Pass {name} <value>");
            return args[i + 1];
        }
    }
}
