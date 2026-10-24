using System.IO;
using Gaussians;
using Gaussians.ThreeD;
using Unity.XR.CoreUtils;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.SceneManagement;
using UnityEditor.XR.Management;
using UnityEditor.XR.Management.Metadata;
using UnityEditor.XR.OpenXR.Features;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.XR;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.XR.ARFoundation;
using UnityEngine.XR.Management;
using UnityEngine.XR.OpenXR;

namespace LucidDreams.Editor
{
    // One-shot, idempotent setup for the Quest 3S build: URP with the Gaussian pass, OpenXR + Meta passthrough,
    // Android player settings and the main scene. Run from the menu or in batch mode:
    //   Unity -batchmode -quit -projectPath apps/quest -executeMethod LucidDreams.Editor.QuestProjectSetup.Run
    public static class QuestProjectSetup
    {
        const string SettingsDir = "Assets/LucidDreams/Settings";
        const string ScenePath = "Assets/LucidDreams/Scenes/Dream.unity";
        const string AndroidId = "com.luciddreams.quest";

        static readonly string[] OpenXRFeatures =
        {
            "com.unity.openxr.feature.metaquest",
            "com.unity.openxr.feature.arfoundation-meta-session",
            "com.unity.openxr.feature.arfoundation-meta-camera", // passthrough
            "com.unity.openxr.feature.arfoundation-meta-plane", // floor
            "com.unity.openxr.feature.arfoundation-meta-raycast",
            "com.unity.openxr.feature.foveatedrendering",
            "com.unity.openxr.feature.input.oculustouch",
            "com.unity.openxr.feature.input.handinteraction",
            "com.unity.openxr.feature.input.metahandtrackingaim",
        };

        [MenuItem("Lucid Dreams/Set Up Project")]
        public static void Run()
        {
            Directory.CreateDirectory(SettingsDir);
            Directory.CreateDirectory(Path.GetDirectoryName(ScenePath));

            ConfigurePlayer();
            ConfigureRenderPipeline();
            ConfigureXR();
            ImportTextResources();
            BuildScene();

            AssetDatabase.SaveAssets();
            Debug.Log("[Lucid Dreams] Project set up for Quest 3S.");
        }

        // Unity -batchmode -quit -projectPath apps/quest -buildTarget Android -executeMethod LucidDreams.Editor.QuestProjectSetup.BuildApk
        [MenuItem("Lucid Dreams/Build APK")]
        public static void BuildApk()
        {
            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = new[] { ScenePath },
                locationPathName = "Builds/LucidDreams.apk",
                target = BuildTarget.Android,
                options = BuildOptions.None,
            });
            Debug.Log($"[Lucid Dreams] APK build {report.summary.result}: {report.summary.totalSize / (1024 * 1024)} MB, {report.summary.totalTime:mm\\:ss}.");
            if (Application.isBatchMode && report.summary.result != UnityEditor.Build.Reporting.BuildResult.Succeeded) EditorApplication.Exit(1);
        }

        // TextMesh Pro's default font and settings, used by the in-headset controls.
        static void ImportTextResources()
        {
            if (AssetDatabase.IsValidFolder("Assets/TextMesh Pro")) return;
            var pkg = UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(TMPro.TMP_Text).Assembly);
            UnityEditor.AssetPackage.Package.Import($"{pkg.resolvedPath}/Package Resources/TMP Essential Resources.unitypackage", false);
        }

        static void ConfigurePlayer()
        {
            PlayerSettings.companyName = "Lucid Dreams";
            PlayerSettings.productName = "Lucid Dreams";
            PlayerSettings.colorSpace = ColorSpace.Linear;
            PlayerSettings.SetApplicationIdentifier(NamedBuildTarget.Android, AndroidId);
            PlayerSettings.SetScriptingBackend(NamedBuildTarget.Android, ScriptingImplementation.IL2CPP);
            PlayerSettings.Android.targetArchitectures = AndroidArchitecture.ARM64;
            PlayerSettings.Android.minSdkVersion = AndroidSdkVersions.AndroidApiLevel32;
            PlayerSettings.SetUseDefaultGraphicsAPIs(BuildTarget.Android, false);
            PlayerSettings.SetGraphicsAPIs(BuildTarget.Android, new[] { GraphicsDeviceType.Vulkan });
            PlayerSettings.SetMobileMTRendering(NamedBuildTarget.Android, true);
            // Downloads bundles from the bridge on the local network over plain HTTP.
            PlayerSettings.insecureHttpOption = InsecureHttpOption.AlwaysAllowed;
            PlayerSettings.Android.forceInternetPermission = true;
            EditorUserBuildSettings.androidBuildSubtarget = MobileTextureSubtarget.ASTC;
        }

        static void ConfigureRenderPipeline()
        {
            string rendererPath = $"{SettingsDir}/QuestRenderer.asset";
            string pipelinePath = $"{SettingsDir}/QuestURP.asset";

            var renderer = AssetDatabase.LoadAssetAtPath<UniversalRendererData>(rendererPath);
            if (renderer == null)
            {
                renderer = ScriptableObject.CreateInstance<UniversalRendererData>();
                AssetDatabase.CreateAsset(renderer, rendererPath);
            }
            renderer.postProcessData = null;
            renderer.depthPrimingMode = DepthPrimingMode.Disabled;
            if (!renderer.rendererFeatures.Exists(f => f is GaussiansURPFeature))
            {
                var feature = ScriptableObject.CreateInstance<GaussiansURPFeature>();
                feature.name = "Gaussians";
                AssetDatabase.AddObjectToAsset(feature, renderer);
                renderer.rendererFeatures.Add(feature);
            }
            EditorUtility.SetDirty(renderer);

            var pipeline = AssetDatabase.LoadAssetAtPath<UniversalRenderPipelineAsset>(pipelinePath);
            if (pipeline == null)
            {
                pipeline = UniversalRenderPipelineAsset.Create(renderer);
                AssetDatabase.CreateAsset(pipeline, pipelinePath);
            }
            // Splats are their own anti-aliasing; spend the budget on Gaussians, not on MSAA, HDR or shadows.
            pipeline.msaaSampleCount = 1;
            pipeline.supportsHDR = false;
            pipeline.renderScale = 1f;
            pipeline.shadowDistance = 0f;
            pipeline.supportsCameraDepthTexture = false;
            pipeline.supportsCameraOpaqueTexture = false;
            EditorUtility.SetDirty(pipeline);

            GraphicsSettings.defaultRenderPipeline = pipeline;
            for (int i = 0; i < QualitySettings.names.Length; i++)
            {
                QualitySettings.SetQualityLevel(i, false);
                QualitySettings.renderPipeline = pipeline;
            }
        }

        static void ConfigureXR()
        {
            EditorBuildSettings.TryGetConfigObject(XRGeneralSettings.settingsKey, out XRGeneralSettingsPerBuildTarget perTarget);
            if (perTarget == null)
            {
                Directory.CreateDirectory("Assets/XR");
                perTarget = ScriptableObject.CreateInstance<XRGeneralSettingsPerBuildTarget>();
                AssetDatabase.CreateAsset(perTarget, "Assets/XR/XRGeneralSettingsPerBuildTarget.asset");
                EditorBuildSettings.AddConfigObject(XRGeneralSettings.settingsKey, perTarget, true);
            }

            foreach (var group in new[] { BuildTargetGroup.Android, BuildTargetGroup.Standalone })
            {
                if (!perTarget.HasSettingsForBuildTarget(group)) perTarget.CreateDefaultSettingsForBuildTarget(group);
                if (!perTarget.HasManagerSettingsForBuildTarget(group)) perTarget.CreateDefaultManagerSettingsForBuildTarget(group);
                var general = perTarget.SettingsForBuildTarget(group);
                general.InitManagerOnStart = true;
                XRPackageMetadataStore.AssignLoader(general.Manager, "UnityEngine.XR.OpenXR.OpenXRLoader", group);

                FeatureHelpers.RefreshFeatures(group);
                var openxr = OpenXRSettings.GetSettingsForBuildTargetGroup(group);
                if (openxr == null)
                {
                    Debug.LogWarning($"[Lucid Dreams] No OpenXR settings for {group}: install its build support module in Unity Hub, then run setup again.");
                    continue;
                }
                openxr.renderMode = OpenXRSettings.RenderMode.SinglePassInstanced;
                openxr.depthSubmissionMode = OpenXRSettings.DepthSubmissionMode.Depth16Bit;

                // Desktop (Quest Link) gets the same features, minus the Android-only Meta Quest one.
                foreach (var id in OpenXRFeatures)
                {
                    if (group != BuildTargetGroup.Android && id == "com.unity.openxr.feature.metaquest") continue;
                    var feature = FeatureHelpers.GetFeatureWithIdForBuildTarget(group, id);
                    if (feature != null) feature.enabled = true;
                    else Debug.LogWarning($"[Lucid Dreams] OpenXR feature {id} not found for {group}.");
                }
                // XR Hands' hand tracking shares its feature ID with Microsoft's hand interaction, so match by type.
                foreach (var feature in openxr.GetFeatures())
                {
                    if (feature is UnityEngine.XR.Hands.OpenXR.HandTracking) feature.enabled = true;
#pragma warning disable CS0618 // deprecated, which is why it must stay off
                    if (feature is UnityEngine.XR.OpenXR.Features.Interactions.MicrosoftHandInteraction) feature.enabled = false;
#pragma warning restore CS0618
                }
                EditorUtility.SetDirty(openxr);
            }
            EditorUtility.SetDirty(perTarget);
        }

        static void BuildScene()
        {
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            new GameObject("AR Session", typeof(ARSession));

            var originGo = new GameObject("XR Origin");
            var origin = originGo.AddComponent<XROrigin>();
            var offset = new GameObject("Camera Offset");
            offset.transform.SetParent(originGo.transform, false);

            var camGo = new GameObject("Main Camera") { tag = "MainCamera" };
            camGo.transform.SetParent(offset.transform, false);
            var cam = camGo.AddComponent<Camera>();
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = new Color(0, 0, 0, 0); // transparent so passthrough shows
            cam.nearClipPlane = 0.05f;
            cam.farClipPlane = 50f;
            var camData = camGo.AddComponent<UniversalAdditionalCameraData>();
            camData.renderPostProcessing = false;
            camData.antialiasing = AntialiasingMode.None;
            camGo.AddComponent<ARCameraManager>();

            var pose = camGo.AddComponent<TrackedPoseDriver>();
            pose.positionInput = new InputActionProperty(new InputAction("Head Position", binding: "<XRHMD>/centerEyePosition", expectedControlType: "Vector3"));
            pose.rotationInput = new InputActionProperty(new InputAction("Head Rotation", binding: "<XRHMD>/centerEyeRotation", expectedControlType: "Quaternion"));
            pose.trackingStateInput = new InputActionProperty(new InputAction("Head Tracking State", binding: "<XRHMD>/trackingState", expectedControlType: "Integer"));

            origin.Camera = cam;
            origin.CameraFloorOffsetObject = offset;
            origin.RequestedTrackingOriginMode = XROrigin.TrackingOriginMode.Floor;
            var planes = originGo.AddComponent<ARPlaneManager>();
            planes.requestedDetectionMode = UnityEngine.XR.ARSubsystems.PlaneDetectionMode.Horizontal;

            // Dream root sits on the floor and faces the viewer; the person is a child so placement and
            // grabbing never touch the splat transform.
            var dreamGo = new GameObject("Dream");
            var placer = dreamGo.AddComponent<DreamPlacer>();
            placer.head = camGo.transform;
            placer.planes = planes;
            var personGo = new GameObject("Person");
            personGo.transform.SetParent(dreamGo.transform, false);
            var splat = ObjectFactory.AddComponent<GaussianSplat3DRenderer>(personGo);
            ConfigureSplatRenderer(splat);
            placer.person = personGo.transform;
            var player = personGo.AddComponent<DreamSequencePlayer>();
            player.bundle = ""; // the library picks: the last dream played, or it opens so you can choose
            player.avatarSkinning = AssetDatabase.LoadAssetAtPath<ComputeShader>("Assets/LucidDreams/Shaders/AvatarSkinning.compute");
            placer.player = player;
            var controls = dreamGo.AddComponent<DreamTestControls>();
            controls.player = player;
            controls.placer = placer;
            var shadow = dreamGo.AddComponent<ContactShadow>();
            shadow.shader = AssetDatabase.LoadAssetAtPath<Shader>("Assets/LucidDreams/Shaders/ContactShadow.shader");
            shadow.player = player;

            // Hands: tracked in the camera offset's space, occluding the person, driving the bar and the person.
            var handsGo = new GameObject("Hands");
            handsGo.transform.SetParent(originGo.transform, false);
            var tracker = handsGo.AddComponent<HandTracker>();
            tracker.trackingSpace = offset.transform;
            var occluder = handsGo.AddComponent<HandOccluder>();
            occluder.hands = tracker;
            occluder.depthOnly = AssetDatabase.LoadAssetAtPath<Shader>("Assets/LucidDreams/Shaders/DepthOnly.shader");

            var barGo = new GameObject("Control Bar");
            var bar = barGo.AddComponent<DreamControlBar>();
            bar.head = camGo.transform;
            bar.hands = tracker;
            bar.player = player;
            bar.placer = placer;

            // The library: dreams from the bridge and the ones already downloaded.
            var libraryGo = new GameObject("Library");
            var library = libraryGo.AddComponent<DreamLibrary>();
            library.player = player;
            var libraryPanel = libraryGo.AddComponent<DreamLibraryPanel>();
            libraryPanel.library = library;
            libraryPanel.player = player;
            libraryPanel.hands = tracker;
            libraryPanel.head = camGo.transform;
            bar.library = libraryPanel;

            // Lessons: the step card beside the person, read aloud in the device's voice.
            var lessonGo = new GameObject("Lesson");
            var voice = lessonGo.AddComponent<DeviceVoice>();
            var steps = lessonGo.AddComponent<DreamStepPanel>();
            steps.player = player;
            steps.placer = placer;
            steps.voice = voice;
            steps.head = camGo.transform;

            var interaction = dreamGo.AddComponent<DreamHands>();
            interaction.hands = tracker;
            interaction.placer = placer;
            interaction.player = player;
            interaction.bar = bar;
            interaction.head = camGo.transform;

            EditorSceneManager.SaveScene(scene, ScenePath);
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
        }

        // Fidelity first: full SH, full sort precision, and center depth so Quest reprojection keeps the person stable.
        public static void ConfigureSplatRenderer(GaussianSplat3DRenderer splat)
        {
            splat.m_ProjectionMode = GaussianSplat3DRenderer.ProjectionMode.Optimal;
            splat.m_SHOrder = 3;
            splat.m_SortPrecision = GaussianSplat3DRenderer.SortPrecision.Bits32;
            splat.m_SortNthFrame = 1;
            splat.m_WriteDepth = true;
            EditorUtility.SetDirty(splat);
        }
    }
}
