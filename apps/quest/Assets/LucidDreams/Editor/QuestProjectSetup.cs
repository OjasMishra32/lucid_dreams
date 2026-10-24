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
            "com.unity.openxr.feature.arfoundation-meta-anchor", // the person stays where you put them
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
            // the APK file itself: the report's totalSize counts intermediate files too
            var apk = new FileInfo("Builds/LucidDreams.apk");
            string size = apk.Exists ? $"{apk.Length / (1024f * 1024f):F1} MB" : "no file";
            Debug.Log($"[Lucid Dreams] APK build {report.summary.result}: {size}, {report.summary.totalTime:mm\\:ss}.");
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
            camGo.AddComponent<AudioListener>(); // their voice is heard from where you stand

            var pose = camGo.AddComponent<TrackedPoseDriver>();
            pose.positionInput = new InputActionProperty(new InputAction("Head Position", binding: "<XRHMD>/centerEyePosition", expectedControlType: "Vector3"));
            pose.rotationInput = new InputActionProperty(new InputAction("Head Rotation", binding: "<XRHMD>/centerEyeRotation", expectedControlType: "Quaternion"));
            pose.trackingStateInput = new InputActionProperty(new InputAction("Head Tracking State", binding: "<XRHMD>/trackingState", expectedControlType: "Integer"));

            origin.Camera = cam;
            origin.CameraFloorOffsetObject = offset;
            origin.RequestedTrackingOriginMode = XROrigin.TrackingOriginMode.Floor;
            var planes = originGo.AddComponent<ARPlaneManager>();
            planes.requestedDetectionMode = UnityEngine.XR.ARSubsystems.PlaneDetectionMode.Horizontal;
            var anchors = originGo.AddComponent<ARAnchorManager>(); // pins the person to the room

            // Dream root sits on the floor and faces the viewer; the person is a child so placement and
            // grabbing never touch the splat transform.
            var dreamGo = new GameObject("Dream");
            var placer = dreamGo.AddComponent<DreamPlacer>();
            placer.head = camGo.transform;
            placer.planes = planes;
            placer.worldLock = dreamGo.AddComponent<WorldLock>();
            placer.worldLock.anchors = anchors;
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
            var speech = dreamGo.AddComponent<DreamSpeech>();
            speech.player = player;
            speech.placer = placer;
            var props = dreamGo.AddComponent<DreamProps>();
            props.player = player;
            props.person = personGo.transform;
            props.shadowShader = AssetDatabase.LoadAssetAtPath<Shader>("Assets/LucidDreams/Shaders/ContactShadow.shader");
            props.ball = PropMaterial("Ball", Color.white, 0f, 0.34f, normalMap: true);
            props.ballFading = PropMaterial("Ball fading", Color.white, 0f, 0.34f, normalMap: true, transparent: true);
            props.rimOrange = PropMaterial("Rim orange", Hex(0xd4501c), 0.5f, 0.62f);
            props.steel = PropMaterial("Steel", Hex(0x1d1e21), 0.35f, 0.5f);
            props.standBase = PropMaterial("Stand base", Hex(0x161618), 0.05f, 0.15f);
            props.paint = PropMaterial("Board paint", Hex(0xf5f5f3), 0f, 0.45f, doubleSided: true);
            props.glass = PropMaterial("Board glass", new Color(1f, 1f, 1f, 0.09f), 0f, 0.96f, transparent: true);
            props.glassEdge = PropMaterial("Board glass edge", WithAlpha(Hex(0x9cc7bd), 0.55f), 0f, 0.85f, transparent: true);
            props.cord = PropMaterial("Net cord", WithAlpha(Hex(0xf7f7f5), 0.9f), 0f, 0.1f, transparent: true);
            var bench = dreamGo.AddComponent<DreamBench>();
            bench.player = player;
            bench.person = personGo.transform;
            bench.shadowShader = props.shadowShader;
            bench.lacquer = PropMaterial("Bench lacquer", Hex(0x0d0d0f), 0f, 0.82f);
            bench.leather = PropMaterial("Bench leather", Hex(0x1b1a19), 0f, 0.32f);

            // Light for the solid props only (Gaussians carry their own light): a soft sky and one key light.
            var keyGo = new GameObject("Prop key light");
            var key = keyGo.AddComponent<Light>();
            key.type = LightType.Directional;
            key.intensity = 1.4f;
            key.shadows = LightShadows.None;
            keyGo.transform.rotation = Quaternion.Euler(55f, -25f, 0f);
            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = new Color(0.6f, 0.6f, 0.6f);
            RenderSettings.ambientEquatorColor = new Color(0.45f, 0.44f, 0.42f);
            RenderSettings.ambientGroundColor = Hex(0x8a8178) * 0.6f;
            var shadow = dreamGo.AddComponent<ContactShadow>();
            shadow.shader = AssetDatabase.LoadAssetAtPath<Shader>("Assets/LucidDreams/Shaders/ContactShadow.shader");
            shadow.player = player;

            // A second person (Bring in another): 1.5 m to the first one's left, on their clock, moved with them, with
            // their own props, bench and shadow, and no voice.
            var secondGo = new GameObject("Second person");
            secondGo.transform.SetParent(dreamGo.transform, false);
            var secondPersonGo = new GameObject("Person");
            secondPersonGo.transform.SetParent(secondGo.transform, false);
            ConfigureSplatRenderer(ObjectFactory.AddComponent<GaussianSplat3DRenderer>(secondPersonGo));
            var secondPlayer = secondPersonGo.AddComponent<DreamSequencePlayer>();
            secondPlayer.bundle = "";
            secondPlayer.avatarSkinning = player.avatarSkinning;
            var companion = secondGo.AddComponent<DreamCompanion>();
            companion.lead = player;
            companion.player = secondPlayer;
            var secondProps = secondGo.AddComponent<DreamProps>();
            secondProps.player = secondPlayer;
            secondProps.person = secondPersonGo.transform;
            secondProps.shadowShader = props.shadowShader;
            (secondProps.ball, secondProps.ballFading, secondProps.rimOrange, secondProps.steel, secondProps.standBase) =
                (props.ball, props.ballFading, props.rimOrange, props.steel, props.standBase);
            (secondProps.paint, secondProps.glass, secondProps.glassEdge, secondProps.cord) = (props.paint, props.glass, props.glassEdge, props.cord);
            var secondBench = secondGo.AddComponent<DreamBench>();
            secondBench.player = secondPlayer;
            secondBench.person = secondPersonGo.transform;
            (secondBench.shadowShader, secondBench.lacquer, secondBench.leather) = (bench.shadowShader, bench.lacquer, bench.leather);
            var secondShadow = secondGo.AddComponent<ContactShadow>();
            secondShadow.shader = shadow.shader;
            secondShadow.player = secondPlayer;

            // Hands: tracked in the camera offset's space, occluding the person; the controls sit on the left palm
            // (no gesture moves or pauses anything).
            var handsGo = new GameObject("Hands");
            handsGo.transform.SetParent(originGo.transform, false);
            var tracker = handsGo.AddComponent<HandTracker>();
            tracker.trackingSpace = offset.transform;
            var occluder = handsGo.AddComponent<HandOccluder>();
            occluder.hands = tracker;
            occluder.depthOnly = AssetDatabase.LoadAssetAtPath<Shader>("Assets/LucidDreams/Shaders/DepthOnly.shader");

            var barGo = new GameObject("Palm Menu");
            var bar = barGo.AddComponent<DreamControlBar>();
            bar.head = camGo.transform;
            bar.hands = tracker;
            bar.player = player;
            bar.placer = placer;

            // The library: dreams from the bridge and the ones already downloaded.
            var libraryGo = new GameObject("Library");
            var library = libraryGo.AddComponent<DreamLibrary>();
            library.player = player;
            library.companion = companion;
            var libraryPanel = libraryGo.AddComponent<DreamLibraryPanel>();
            libraryPanel.library = library;
            libraryPanel.player = player;
            libraryPanel.hands = tracker;
            libraryPanel.head = camGo.transform;
            libraryPanel.placer = placer;
            libraryPanel.speech = speech;
            bar.library = libraryPanel;
            bar.dreams = library;
            // Talk with them (companion mode), through the talk server named in talk.txt
            var talk = dreamGo.AddComponent<DreamTalk>();
            talk.player = player;
            talk.speech = speech;
            bar.talk = talk;

            // Lessons: the step card beside the person, read aloud in the device's voice.
            var lessonGo = new GameObject("Lesson");
            var voice = lessonGo.AddComponent<DeviceVoice>();
            var steps = lessonGo.AddComponent<DreamStepPanel>();
            steps.player = player;
            steps.placer = placer;
            steps.voice = voice;
            steps.head = camGo.transform;

            EditorSceneManager.SaveScene(scene, ScenePath);
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
        }

        static Color Hex(int rgb) => new Color(((rgb >> 16) & 255) / 255f, ((rgb >> 8) & 255) / 255f, (rgb & 255) / 255f, 1f);
        static Color WithAlpha(Color c, float a) => new Color(c.r, c.g, c.b, a);

        // A URP Lit material asset for props (assets, so the build keeps their shader variants).
        static Material PropMaterial(string name, Color color, float metallic, float smoothness,
            bool normalMap = false, bool transparent = false, bool doubleSided = false)
        {
            string dir = "Assets/LucidDreams/Props";
            Directory.CreateDirectory(dir);
            string path = $"{dir}/{name}.mat";
            var m = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (m == null)
            {
                m = new Material(Shader.Find("Universal Render Pipeline/Lit"));
                AssetDatabase.CreateAsset(m, path);
            }
            m.SetColor("_BaseColor", color);
            m.SetFloat("_Metallic", metallic);
            m.SetFloat("_Smoothness", smoothness);
            m.SetFloat("_Cull", doubleSided ? 0f : 2f);
            if (normalMap) { m.EnableKeyword("_NORMALMAP"); m.SetFloat("_BumpScale", 1f); }
            if (transparent)
            {
                m.SetFloat("_Surface", 1f);
                m.SetFloat("_Blend", 0f);
                m.SetFloat("_SrcBlend", (float)UnityEngine.Rendering.BlendMode.SrcAlpha);
                m.SetFloat("_DstBlend", (float)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
                // alpha for the passthrough compositor: coverage, not alpha squared
                m.SetFloat("_SrcBlendAlpha", (float)UnityEngine.Rendering.BlendMode.One);
                m.SetFloat("_DstBlendAlpha", (float)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
                m.SetFloat("_ZWrite", 0f);
                m.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
                m.SetOverrideTag("RenderType", "Transparent");
                m.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Transparent;
            }
            EditorUtility.SetDirty(m);
            return m;
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
