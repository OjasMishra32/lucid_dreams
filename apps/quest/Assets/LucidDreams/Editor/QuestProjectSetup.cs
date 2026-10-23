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
            "com.unity.openxr.feature.input.handtracking",
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
            BuildScene();

            AssetDatabase.SaveAssets();
            Debug.Log("[Lucid Dreams] Project set up for Quest 3S.");
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
            EditorBuildSettings.TryGetConfigObject(XRGeneralSettings.k_SettingsKey, out XRGeneralSettingsPerBuildTarget perTarget);
            if (perTarget == null)
            {
                Directory.CreateDirectory("Assets/XR");
                perTarget = ScriptableObject.CreateInstance<XRGeneralSettingsPerBuildTarget>();
                AssetDatabase.CreateAsset(perTarget, "Assets/XR/XRGeneralSettingsPerBuildTarget.asset");
                EditorBuildSettings.AddConfigObject(XRGeneralSettings.k_SettingsKey, perTarget, true);
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
