using System;
using System.IO;
using Gaussians.ThreeD;
using Gaussians.ThreeD.Editor;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace LucidDreams.Editor
{
    // Imports a dream bundle's first frame (replay) or rest-pose avatar into the scene's person.
    // Batch mode: Unity -batchmode -quit -projectPath apps/quest
    //   -executeMethod LucidDreams.Editor.DreamBundleImport.ImportFromCommandLine -dreamBundle /path/to/dreams/<id>
    public static class DreamBundleImport
    {
        const string OutputRoot = "Assets/Dreams";

        // Near-lossless: 16-bit positions and scales inside each chunk's bounds, half-float color and SH.
        static GaussianSplat3DImportSettings HighFidelity => new(
            GaussianSplat3DAsset.VectorFormat.Norm16,
            GaussianSplat3DAsset.VectorFormat.Norm16,
            GaussianSplat3DAsset.ColorFormat.Float16x4,
            GaussianSplat3DAsset.SHFormat.Float16);

        [MenuItem("Lucid Dreams/Import Dream Bundle...")]
        static void ImportFromMenu()
        {
            string dir = EditorUtility.OpenFolderPanel("Dream bundle folder (contains dream.json)", "", "");
            if (!string.IsNullOrEmpty(dir)) Import(dir);
        }

        public static void ImportFromCommandLine()
        {
            string[] args = Environment.GetCommandLineArgs();
            int i = Array.IndexOf(args, "-dreamBundle");
            if (i < 0 || i + 1 >= args.Length) throw new ArgumentException("Pass -dreamBundle <bundle folder>");
            Import(args[i + 1]);
        }

        public static GaussianSplat3DAsset Import(string bundleDir)
        {
            string jsonPath = Path.Combine(bundleDir, "dream.json");
            if (!File.Exists(jsonPath)) throw new FileNotFoundException("No dream.json in bundle", jsonPath);
            var dream = DreamBundle.FromJson(File.ReadAllText(jsonPath));

            string relative = dream.IsAvatar ? dream.avatar?.file : dream.FramePath(0);
            if (string.IsNullOrEmpty(relative)) throw new InvalidDataException($"dream.json for '{dream.id}' names no Gaussian file");
            string source = Path.Combine(bundleDir, relative);

            string outDir = $"{OutputRoot}/{dream.id}";
            Directory.CreateDirectory(outDir);
            var asset = GaussianSplat3DImporter.Import(source, outDir, HighFidelity, importCameras: false)[0];
            Debug.Log($"[Lucid Dreams] Imported '{dream.name}' ({dream.kind}) from {relative}: {asset.splatCount:N0} Gaussians.");

            AssignToScene(asset);
            return asset;
        }

        static void AssignToScene(GaussianSplat3DAsset asset)
        {
            var scenePath = EditorBuildSettings.scenes.Length > 0 ? EditorBuildSettings.scenes[0].path : null;
            if (string.IsNullOrEmpty(scenePath)) return;
            var scene = EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Single);
            var splat = UnityEngine.Object.FindFirstObjectByType<GaussianSplat3DRenderer>();
            if (splat == null)
            {
                Debug.LogWarning("[Lucid Dreams] No Gaussian renderer in the scene; run Lucid Dreams > Set Up Project.");
                return;
            }
            splat.m_Asset = asset;
            EditorUtility.SetDirty(splat);
            EditorSceneManager.SaveScene(scene);
        }
    }
}
