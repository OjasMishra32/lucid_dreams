#if UNITY_EDITOR
using System.Collections;
using System.IO;
using System.Linq;
using UnityEngine;
using UnityEngine.InputSystem.XR;
using UnityEngine.XR.Hands;

namespace LucidDreams.Tests
{
    // Drives simulated hands through every gesture in the real scene and checks the outcome. Editor only;
    // started by LucidDreams.Editor.HandsCheck. Results go to the log as "[Lucid Dreams] Hands check: ...".
    public class HandsCheckDriver : MonoBehaviour
    {
        public string outputDir;
        public bool libraryMode;
        public string expectDir;
        public bool Done { get; private set; }
        public int Failures { get; private set; }

        HandTracker hands;
        DreamSequencePlayer player;
        DreamPlacer placer;
        DreamControlBar bar;
        Camera head;

        IEnumerator Start()
        {
            hands = FindAnyObjectByType<HandTracker>();
            player = FindAnyObjectByType<DreamSequencePlayer>();
            placer = FindAnyObjectByType<DreamPlacer>();
            bar = FindAnyObjectByType<DreamControlBar>();
            head = Camera.main;
            var driver = head.GetComponent<TrackedPoseDriver>();
            if (driver) driver.enabled = false;
            head.transform.SetPositionAndRotation(new Vector3(0f, 1.6f, 2f), Quaternion.Euler(10f, 180f, 0f));
            hands.Simulate(hands.left, false, Vector3.zero, Vector3.zero);
            hands.Simulate(hands.right, false, Vector3.zero, Vector3.zero);
            if (libraryMode)
            {
                yield return LibraryChecks();
                Debug.Log($"[Lucid Dreams] Hands check: {(Failures == 0 ? "PASS" : $"{Failures} FAILED")}");
                Done = true;
                yield break;
            }

            float until = Time.realtimeSinceStartup + 120f;
            while (!player.IsReady && player.Error == null && Time.realtimeSinceStartup < until) yield return null;
            Check(player.IsReady, $"bundle loaded ({player.Error})");
            if (!player.IsReady) { Done = true; yield break; }
            yield return Frames(30); // placement and the bar settle

            var root = placer.transform;
            if (player.IsAvatar)
            {
                yield return AvatarChecks(root);
                Debug.Log($"[Lucid Dreams] Hands check: {(Failures == 0 ? "PASS" : $"{Failures} FAILED")}");
                Done = true;
                yield break;
            }
            if (DreamPlaces.Starting(player.Experience?.environment, player.Experience?.intent ?? player.Dream.intent) != null)
            {
                yield return PlacesChecks(root);
                Debug.Log($"[Lucid Dreams] Hands check: {(Failures == 0 ? "PASS" : $"{Failures} FAILED")}");
                Done = true;
                yield break;
            }
            if (!string.IsNullOrEmpty(player.Dream.props))
            {
                yield return PropsChecks(root);
                Debug.Log($"[Lucid Dreams] Hands check: {(Failures == 0 ? "PASS" : $"{Failures} FAILED")}");
                Done = true;
                yield break;
            }
            if (!string.IsNullOrEmpty(player.Dream.voice) || !string.IsNullOrEmpty(player.Dream.captions))
            {
                yield return SpeechChecks(root);
                Debug.Log($"[Lucid Dreams] Hands check: {(Failures == 0 ? "PASS" : $"{Failures} FAILED")}");
                Done = true;
                yield break;
            }
            if (player.Lesson != null)
            {
                yield return TeachChecks(root);
                Debug.Log($"[Lucid Dreams] Hands check: {(Failures == 0 ? "PASS" : $"{Failures} FAILED")}");
                Done = true;
                yield break;
            }
            Check(Vector3.Distance(root.position, new Vector3(0f, 0f, 0.2f)) < 0.02f, $"placed 1.8 m in front, on the floor ({root.position})");
            Check(Vector3.Angle(root.forward, Vector3.forward) < 1f, "faces the viewer");

            // Quick pinch in the room toggles playback.
            bool wasPlaying = player.IsPlaying;
            var air = new Vector3(0.3f, 1.3f, 1.6f);
            yield return Pinch(hands.right, air, air, 0.12f);
            Check(player.IsPlaying != wasPlaying, "quick pinch toggles play/pause");

            // A fingertip pushed through the play button presses it once, even resting there.
            var button = FindObjectsByType<FingertipButton>(FindObjectsInactive.Exclude)
                .First(b => b.label.text == "Play" || b.label.text == "Pause");
            wasPlaying = player.IsPlaying;
            var front = button.transform.TransformPoint(new Vector3(0f, 0f, -30f));
            var through = button.transform.TransformPoint(new Vector3(0f, 0f, 6f));
            for (int i = 0; i <= 10; i++)
            {
                Point(hands.right, Vector3.Lerp(front, through, i / 10f));
                yield return null;
            }
            yield return Frames(20);
            Check(player.IsPlaying != wasPlaying, "fingertip push presses the button");
            Check(player.IsPlaying != wasPlaying, "resting on the button doesn't fire again");
            Point(hands.right, front);
            yield return Frames(5);
            Release(hands.right);

            // Pinch-drag on the timeline scrubs.
            yield return Pinch(hands.left, bar.TimelinePoint(0.1f), bar.TimelinePoint(0.75f), 0.4f);
            Check(Mathf.Abs(player.NormalizedTime - 0.75f) < 0.05f && !player.IsPlaying, $"timeline scrub lands at 75% ({player.NormalizedTime:F2})");

            // Pinch the person and drag: they slide along the floor.
            var start = root.position;
            var chest = start + Vector3.up * 1.2f;
            yield return Pinch(hands.right, chest, chest + new Vector3(0.3f, 0.2f, -0.2f), 0.6f);
            var moved = root.position - start;
            Check(Mathf.Abs(moved.x - 0.3f) < 0.02f && Mathf.Abs(moved.z + 0.2f) < 0.02f && Mathf.Abs(root.position.y) < 1e-4f,
                $"grab moves along the floor, never lifts ({moved})");

            // Two hands on the person turn them.
            float yaw0 = root.eulerAngles.y;
            var c = root.position + Vector3.up * 1.1f;
            yield return TwoHandTurn(c, 0.22f, 30f, 0.6f);
            float turned = Mathf.DeltaAngle(yaw0, root.eulerAngles.y);
            Check(Mathf.Abs(turned - 30f) < 2f, $"two-hand grab turns them ({turned:F1} degrees)");

            // Long pinch pointing at the floor: they stand there, facing you.
            var target = new Vector3(-0.8f, 0f, -0.5f);
            var eye = head.transform.position;
            var aim = eye + (target - eye).normalized * 0.5f;
            yield return Pinch(hands.right, aim, aim, 1.1f);
            Check(Vector3.Distance(root.position, target) < 0.03f, $"long pinch re-places them where you point ({root.position})");
            var toViewer = Vector3.ProjectOnPlane(eye - root.position, Vector3.up);
            Check(Vector3.Angle(root.forward, toViewer) < 1f, "and they face you");

            // Reality check: a fingertip push loads the reality frames and swaps them in at the same frame.
            placer.PlaceInFrontOfViewer();
            player.Pause();
            player.Scrub(0.4f);
            int frameBefore = player.Frame;
            var realityButton = FindObjectsByType<FingertipButton>(FindObjectsInactive.Exclude).FirstOrDefault(b => b.label.text == "Reality check");
            Check(realityButton != null, "reality button shows for a bundle with reality frames");
            if (realityButton != null)
            {
                yield return Push(realityButton);
                yield return Frames(3);
                var seen = FindObjectsByType<TMPro.TMP_Text>(FindObjectsInactive.Exclude).FirstOrDefault(t => t.name == "Seen");
                Check(seen != null && seen.text == "50% seen by the camera · blue was imagined" && !player.ShowingReality,
                    $"Reality check opens and says how much was seen, before anything is tinted ({seen?.text})");
                var imagined = FindObjectsByType<FingertipButton>(FindObjectsInactive.Exclude).FirstOrDefault(b => b.label.text == "Show imagined detail");
                Check(imagined != null, "with one toggle, Show imagined detail");
                yield return Push(imagined);
                until = Time.realtimeSinceStartup + 60f;
                while (!player.ShowingReality && player.RealityError == null && Time.realtimeSinceStartup < until) yield return null;
                yield return Frames(5);
                Check(player.ShowingReality, $"the toggle loads and shows the imagined detail in blue ({player.RealityError})");
                Check(player.Frame == frameBefore, "same moment, just the reality version");
                Render(Path.Combine(outputDir, "reality-popover-eye-view.png"));
                Render(Path.Combine(outputDir, "reality-side-view.png"), root.position + new Vector3(2.4f, 1.1f, 0f), root.position + Vector3.up * 0.9f);
                yield return Push(imagined);
                yield return Frames(3);
                Check(!player.ShowingReality, "toggling it off goes back to the real colours");
                yield return Push(realityButton);
            }

            // A finger between your eyes and the person: the person must not draw over it.
            placer.PlaceInFrontOfViewer();
            player.Scrub(0f);
            yield return Frames(5);
            Finger(hands.left, new Vector3(-0.02f, 1.35f, 1.55f), new Vector3(0.06f, 1.42f, 1.5f));
            yield return Frames(3);
            Render(Path.Combine(outputDir, "hands-eye-view.png"));

            Debug.Log($"[Lucid Dreams] Hands check: {(Failures == 0 ? "PASS" : $"{Failures} FAILED")}");
            Done = true;
        }

        // A place around the person: chosen by the plan or the intent, passthrough off once it's in, cycled by fingertip.
        IEnumerator PlacesChecks(Transform root)
        {
            Check(DreamPlaces.Starting("concert-hall", "teach me this jump shot")?.id == "concert-hall"
                  && DreamPlaces.Starting("room", "teach me this jump shot") == null
                  && DreamPlaces.Starting(null, "sit with me and teach me this piece on the piano")?.id == "concert-hall"
                  && DreamPlaces.Starting(null, "I just want to sit with her") == null,
                "environment wins (room included), then the intent, else your room");
            var places = FindAnyObjectByType<DreamPlaces>();
            var occluder = FindAnyObjectByType<HandOccluder>();
            float until = Time.realtimeSinceStartup + 10f;
            while (places.Opacity < 1f && Time.realtimeSinceStartup < until) yield return null;
            yield return Frames(3);
            Check(places.Current?.id == "court" && places.Opacity >= 1f, $"'{player.Dream.intent}' starts on the court ({places.Name})");
            Check(!places.PassthroughOn && !occluder.enabled, "once it's in, passthrough and the hand stand-ins are off");
            player.Pause();
            player.Seek(5f / player.Dream.fps);
            yield return Frames(3);
            Render(Path.Combine(outputDir, "place-court-eye.png"));
            Render(Path.Combine(outputDir, "place-court-side.png"), root.position + root.right * 3.2f + Vector3.up * 1.4f, root.position + Vector3.up * 0.9f);

            var button = FindObjectsByType<FingertipButton>(FindObjectsInactive.Exclude).FirstOrDefault(b => b.label.text.StartsWith("Place:"));
            Check(button != null && button.label.text == "Place: Court", $"the rail names the place ({button?.label.text})");
            yield return Push(button);
            yield return new WaitForSeconds(0.2f);
            Check(places.Current?.id == "gym" && places.Opacity < 1f, "a push crossfades to the next place");
            yield return new WaitForSeconds(0.8f);
            Check(places.Opacity >= 1f && !places.PassthroughOn, "and it settles in");
            Render(Path.Combine(outputDir, "place-gym-eye.png"));
            foreach (var expect in new[] { "ring", "studio", "mountains" })
            {
                yield return Push(button);
                Check(places.Current?.id == expect, $"then {expect}");
            }
            yield return new WaitForSeconds(0.8f);
            Render(Path.Combine(outputDir, "place-mountains-eye.png"));
            yield return Push(button);
            Check(places.Current == null && places.PassthroughOn, "and back to your room: passthrough comes back first");
            yield return new WaitForSeconds(0.8f);
            Check(!places.Visible && occluder.enabled, "the place fades away and your hands stay in front again");
        }

        // The ball on its track and a regulation hoop, in the person's space.
        IEnumerator PropsChecks(Transform root)
        {
            var props = FindAnyObjectByType<DreamProps>();
            float until = Time.realtimeSinceStartup + 20f;
            while (props.HoopCount == 0 && Time.realtimeSinceStartup < until) yield return null;
            Check(props.HoopCount == 1 && props.Root != null, $"props.json builds: {props.HoopCount} hoop, unknown kinds ignored");

            var json = MiniJson.Obj(MiniJson.Parse(File.ReadAllText(Path.Combine(player.bundle, player.Dream.props))), "props");
            var track = MiniJson.Arr(MiniJson.Arr(json["objects"], "objects")[0] is System.Collections.Generic.Dictionary<string, object> ball ? ball["track"] : null, "track");
            Vector3 T(int f) { var v = MiniJson.Floats(track[f], 3, "track"); return new Vector3(v[0], v[1], v[2]); }
            float fps = player.Dream.fps;
            player.Pause();

            player.Seek(5f / fps);
            yield return new WaitForSeconds(0.3f);
            Check(Vector3.Distance(props.BallPosition, T(5)) < 0.001f && props.BallVisible && props.BallAlpha >= 1f,
                $"on a frame, the ball is exactly on its track ({props.BallPosition} vs {T(5)})");
            player.Seek(15.5f / fps);
            yield return Frames(2);
            var mid = props.BallPosition;
            float span = Vector3.Distance(T(15), T(16));
            Check(Vector3.Distance(mid, T(15)) > 0.2f * span && Vector3.Distance(mid, T(16)) > 0.2f * span
                  && Vector3.Distance(mid, (T(15) + T(16)) / 2f) < 0.25f * span,
                $"between frames it follows the curve, not jumping ({mid} between {T(15)} and {T(16)})");
            player.Seek(10.5f / fps);
            yield return new WaitForSeconds(0.35f);
            Check(!props.BallVisible, $"where the track is null it fades out (alpha {props.BallAlpha:F2})");
            player.Seek(13f / fps);
            yield return Frames(2);
            bool fadingIn = props.BallAlpha < 1f;
            yield return new WaitForSeconds(0.3f);
            Check(fadingIn && props.BallVisible && props.BallAlpha >= 1f, "and fades back in when it's found again");
            Render(Path.Combine(outputDir, "props-side.png"), root.position + root.right * 4.5f + Vector3.up * 1.7f, root.position + root.forward * 0.8f + Vector3.up * 1.6f);

            float lowest = float.MaxValue;
            for (float f = 25f; f <= 28f; f += 0.1f)
            {
                player.Seek(f / fps);
                yield return null;
                lowest = Mathf.Min(lowest, props.BallPosition.y);
            }
            Check(lowest >= 0.12f - 1e-4f, $"through the bounce it never goes through the floor (lowest centre {lowest:F3} m)");

            var ring = props.Root.transform.Find("Hoop/Ring");
            var glass = props.Root.transform.Find("Hoop/Glass");
            var rimWorld = root.InverseTransformPoint(ring.position);
            Check(ring != null && Mathf.Abs(rimWorld.y - (3.05f - 0.008f)) < 0.001f && Mathf.Abs(rimWorld.z - 1.6f) < 0.001f,
                $"the rim is at 3.05 m, 1.6 m in front of them ({rimWorld})");
            Check(glass != null && Vector3.Distance(glass.localScale, new Vector3(1.83f, 1.07f, 0.025f)) < 1e-4f, "on a regulation 1.83 x 1.07 m board");
            player.Seek(5f / fps);
            yield return new WaitForSeconds(0.3f);
            Render(Path.Combine(outputDir, "props-eye.png"));
        }

        // Their voice from where they stand, in step with the clip, and their words as a caption in front of them.
        IEnumerator SpeechChecks(Transform root)
        {
            var speech = FindAnyObjectByType<DreamSpeech>();
            float until = Time.realtimeSinceStartup + 15f;
            while (!speech.HasVoice && Time.realtimeSinceStartup < until) yield return null;
            Check(speech.HasVoice && speech.Voice.clip.length > 1f, $"voice.m4a decodes ({(speech.HasVoice ? speech.Voice.clip.length : 0f):F2} s)");
            float height = player.Dream.bounds.Height;
            var mouth = root.InverseTransformPoint(speech.Voice.transform.position);
            Check(Mathf.Abs(mouth.y - (height - 0.13f)) < 0.005f && Mathf.Abs(mouth.z - 0.08f) < 0.005f,
                $"the voice comes from their mouth, in front of the face ({mouth})");
            Check(speech.Voice.spatialBlend == 1f, "as a sound in the room");

            player.SetSpeed(1f);
            player.Scrub(0f);
            player.Play();
            yield return new WaitForSeconds(0.3f);
            Check(speech.Voice.isPlaying && Mathf.Abs(speech.Voice.time - player.ClipTime) < 0.15f,
                $"plays in step with the clip (voice {speech.Voice.time:F2} s, clip {player.ClipTime:F2} s)");
            player.Pause();
            yield return Frames(2);
            Check(!speech.Voice.isPlaying, "quiet while paused");
            player.SetSpeed(0.5f);
            player.Play();
            yield return Frames(5);
            Check(!speech.Voice.isPlaying, "quiet at slowed speeds (no pitch-correct stretch yet)");
            player.Pause();
            player.SetSpeed(1f);

            player.Scrub(0.3f / player.Duration);
            yield return new WaitForSeconds(0.3f);
            Check(speech.CaptionText == "Hello there.", $"caption shows what they say now ({speech.CaptionText})");
            player.Scrub(0.9f / player.Duration);
            yield return new WaitForSeconds(0.3f);
            Check(speech.CaptionText == "Watch my right hand & follow along.", $"and changes with the clip, entities decoded ({speech.CaptionText})");
            Render(Path.Combine(outputDir, "caption-eye-view.png"));
            var words = FindObjectsByType<TMPro.TMP_Text>(FindObjectsInactive.Exclude).First(t => t.name == "Words");
            Check(Mathf.Approximately(words.fontSize, 29f) && words.textInfo.lineCount <= 2, $"29 mm, two lines at most ({words.fontSize} mm, {words.textInfo.lineCount} lines)");
            speech.LargeCaptions = true;
            yield return Frames(3);
            Check(Mathf.Approximately(words.fontSize, 36f), $"Large is 36 mm ({words.fontSize} mm)");
            Render(Path.Combine(outputDir, "caption-large-eye-view.png"));
            speech.LargeCaptions = false;
            speech.CaptionsOn = false;
            yield return Frames(3);
            Check(speech.CaptionText == null, "Captions off shows nothing");
            speech.CaptionsOn = true;
        }

        // An avatar posed on the GPU, against lucid_avatars/skinning.py's reference positions (when given).
        IEnumerator AvatarChecks(Transform root)
        {
            var rig = player.Rig;
            Check(rig.FrameCount > 1 && rig.Count > 0, $"avatar loaded: {rig.Count:N0} Gaussians, {rig.FrameCount} motion frames");
            player.Pause();

            if (!string.IsNullOrEmpty(expectDir))
            {
                var expect = JsonUtility.FromJson<Expect>(File.ReadAllText(Path.Combine(expectDir, "expect.json")));
                var single = File.ReadAllBytes(Path.Combine(expectDir, "single.bin"));
                foreach (int f in expect.frames)
                {
                    player.Seek(f / expect.fps);
                    yield return Frames(2);
                    var posed = rig.ReadBack();
                    var lbs = ReadFloats(Path.Combine(expectDir, $"frame{f}.bin"));
                    var dq = ReadFloats(Path.Combine(expectDir, $"frame{f}.dq.bin"));
                    float oneBone = 0f, blendedVsDq = 0f, blendedVsLbs = 0f;
                    for (int i = 0; i < rig.Count; i++)
                    {
                        var p = new Vector3(posed[i * 12], posed[i * 12 + 1], posed[i * 12 + 2]);
                        float dl = Vector3.Distance(p, new Vector3(lbs[i * 3], lbs[i * 3 + 1], lbs[i * 3 + 2]));
                        float dd = Vector3.Distance(p, new Vector3(dq[i * 3], dq[i * 3 + 1], dq[i * 3 + 2]));
                        if (single[i] == 1) oneBone = Mathf.Max(oneBone, dl);
                        else
                        {
                            blendedVsDq = Mathf.Max(blendedVsDq, dd);
                            blendedVsLbs = Mathf.Max(blendedVsLbs, dl);
                        }
                    }
                    // One bone: identical to skinning.py's linear blend. Blends: identical to a dual-quaternion blend of
                    // skinning.py's matrices (what the WebXR viewer does); linear blend differs there by design.
                    Check(oneBone < 1e-4f && blendedVsDq < 1e-4f,
                        $"frame {f}: one-bone vs skinning.py {oneBone * 1000f:F3} mm, blends vs dual-quaternion reference {blendedVsDq * 1000f:F3} mm " +
                        $"(vs linear blend {blendedVsLbs * 1000f:F1} mm)");
                }
            }

            // Playing moves it, smoothly between motion frames.
            player.Seek(0f);
            yield return Frames(2);
            var a = rig.ReadBack();
            player.Play();
            yield return new WaitForSeconds(0.4f);
            player.Pause();
            yield return Frames(2);
            var b = rig.ReadBack();
            float most = 0f;
            for (int i = 0; i < rig.Count; i++)
                most = Mathf.Max(most, Vector3.Distance(new Vector3(a[i * 12], a[i * 12 + 1], a[i * 12 + 2]), new Vector3(b[i * 12], b[i * 12 + 1], b[i * 12 + 2])));
            Check(most > 0.02f, $"playing moves it ({most * 100f:F1} cm at most after 0.4 s)");

            player.Seek(13f / rig.Fps);
            yield return Frames(3);
            Render(Path.Combine(outputDir, "avatar-front.png"), root.position + root.forward * 2.6f + Vector3.up * 1.1f, root.position + Vector3.up * 1.0f);
            Render(Path.Combine(outputDir, "avatar-side.png"), root.position + root.right * 2.6f + Vector3.up * 1.1f, root.position + Vector3.up * 1.0f);

            if (player.HasReality)
            {
                player.ToggleReality();
                float until = Time.realtimeSinceStartup + 30f;
                while (!player.ShowingReality && player.RealityError == null && Time.realtimeSinceStartup < until) yield return null;
                yield return Frames(3);
                Check(player.ShowingReality, $"reality check skins the reality Gaussians the same way ({player.RealityError})");
                Render(Path.Combine(outputDir, "avatar-reality-side.png"), root.position + root.right * 2.6f + Vector3.up * 1.1f, root.position + Vector3.up * 1.0f);
                player.ToggleReality();
                yield return Frames(2);
                Check(!player.ShowingReality, "and back to the real colours");
            }
        }

        static float[] ReadFloats(string path)
        {
            var bytes = File.ReadAllBytes(path);
            var f = new float[bytes.Length / 4];
            System.Buffer.BlockCopy(bytes, 0, f, 0, bytes.Length);
            return f;
        }

        [System.Serializable]
        class Expect
        {
            public float fps;
            public int[] frames;
            public int count;
        }

        // The library against a bridge, from an empty headset: list, download, play from the cache, then offline.
        IEnumerator LibraryChecks()
        {
            var library = FindAnyObjectByType<DreamLibrary>();
            var panel = FindAnyObjectByType<DreamLibraryPanel>();
            float until = Time.realtimeSinceStartup + 20f;
            while ((!panel.IsOpen || library.Refreshing || library.Entries.Count == 0) && Time.realtimeSinceStartup < until) yield return null;
            yield return Frames(3);
            Check(panel.IsOpen, "with nothing to play, the library opens by itself");
            Check(library.Online && library.Entries.Count == 2 && library.Entries[0].id == "marker-teach",
                $"lists the bridge's dreams, newest first ({string.Join(", ", library.Entries.Select(x => x.id))})");

            var teach = library.Entries.First(x => x.id == "marker-teach");
            Check(panel.CardFor("marker-teach") != null && panel.CardStatus("marker-teach") == "Download to play",
                $"a dream not on the headset says so on its card ({panel.CardStatus("marker-teach")})");
            yield return new WaitForSecondsRealtime(0.4f);
            Render(Path.Combine(outputDir, "library-eye-view.png"));

            yield return Push(panel.CardFor("marker-teach"));
            yield return Frames(2);
            Check(panel.CardStatus("marker-teach")?.StartsWith("Downloading") == true || teach.cached,
                $"pushing the card downloads it, and you keep browsing ({panel.CardStatus("marker-teach")})");
            until = Time.realtimeSinceStartup + 60f;
            while (!teach.cached && teach.error == null && Time.realtimeSinceStartup < until) yield return null;
            string dir = Path.Combine(library.cacheRoot, "marker-teach");
            int spz = Directory.Exists(Path.Combine(dir, "frames")) ? Directory.GetFiles(Path.Combine(dir, "frames"), "*.spz").Length : 0;
            Check(teach.cached && spz == 2 * teach.dream.frameCount && File.Exists(Path.Combine(dir, "experience.json"))
                  && File.Exists(Path.Combine(dir, "thumb.jpg")) && !Directory.Exists(dir + ".part"),
                $"download lands whole: {spz} SPZ frames + reality, plan and thumb ({teach.error})");
            yield return Frames(3);
            Check(panel.CardStatus("marker-teach") == "On this headset · Play", $"then it's on the headset ({panel.CardStatus("marker-teach")})");

            yield return Push(panel.CardFor("marker-teach"));
            until = Time.realtimeSinceStartup + 60f;
            while (!player.IsReady && player.Error == null && Time.realtimeSinceStartup < until) yield return null;
            Check(player.IsReady && player.LoadedFormat == DreamSequencePlayer.FrameFormat.Spz && player.Lesson != null && player.HasReality,
                $"plays from the headset: SPZ frames, its lesson and reality check ({player.Error})");
            Check(!panel.IsOpen, "picking a dream closes the library");
            yield return Frames(10);
            panel.Open();
            yield return Frames(5);
            Render(Path.Combine(outputDir, "library-playing-eye-view.png"));
            panel.Close();

            library.bridgeUrl = "http://127.0.0.1:9"; // the bridge is gone
            library.Refresh();
            yield return Frames(2);
            until = Time.realtimeSinceStartup + 15f;
            while (library.Refreshing && Time.realtimeSinceStartup < until) yield return null;
            Check(!library.Online && library.Entries.Count == 1 && library.Entries[0].cached,
                $"offline, it lists what's on the headset ({library.Entries.Count} dreams)");
            library.Play(library.Entries[0]);
            until = Time.realtimeSinceStartup + 60f;
            yield return Frames(2);
            while (!player.IsReady && player.Error == null && Time.realtimeSinceStartup < until) yield return null;
            Check(player.IsReady, $"and plays it with no bridge ({player.Error})");
        }

        // A lesson from experience.json: placement by place, steps at their speed and repeats, your turn, Back/Again/Next.
        IEnumerator TeachChecks(Transform root)
        {
            var lesson = player.Lesson;
            var e = player.Experience;
            Check(e.place != "ahead" || (Vector3.Distance(root.position, new Vector3(0f, 0f, 0.5f)) < 0.02f && Vector3.Angle(root.forward, Vector3.back) < 1f),
                $"'{e.place}' placement: 1.5 m ahead, facing your way ({root.position}, facing {root.forward})");

            var card = FindObjectsByType<TMPro.TMP_Text>(FindObjectsInactive.Exclude);
            string Text(string name) => card.FirstOrDefault(t => t.name == name)?.text;
            lesson.Go(0);
            yield return Frames(2);
            Check(Text("Count") == $"Step 1 of {lesson.steps.Count}" && Text("Step") == lesson.steps[0].title, $"step card shows step 1 ({Text("Count")}: {Text("Step")})");
            Check(Mathf.Approximately(player.Speed, lesson.steps[0].Speed), $"step plays at its speed ({player.Speed}x)");
            var voice = FindAnyObjectByType<DeviceVoice>();
            Check(voice != null && voice.LastSaid != null && voice.LastSaid.StartsWith(lesson.steps[0].title), $"the device voice says the step ({voice?.LastSaid})");

            float watch = (lesson.steps[0].end - lesson.steps[0].start) / lesson.steps[0].Speed * lesson.steps[0].Repeat;
            float t0 = Time.time;
            while (!lesson.YourTurn && Time.time - t0 < watch + 1f) yield return null;
            Check(lesson.YourTurn && Mathf.Abs(Time.time - t0 - watch) < 0.25f, $"after {lesson.steps[0].Repeat} plays it's your turn ({Time.time - t0:F2} s, expected {watch:F2})");
            int frozen = player.Frame;
            Check(frozen == Mathf.FloorToInt(lesson.steps[0].end * player.Dream.fps) - 1, $"frozen in the step's last pose (frame {frozen})");
            yield return new WaitForSeconds(0.5f);
            yield return Frames(2);
            Check(player.Frame == frozen && Text("Count") == "Your turn", $"holds still for your turn ({Text("Count")})");
            Render(Path.Combine(outputDir, "teach-eye-view.png"));

            float turn = lesson.steps[0].end - lesson.steps[0].start + Lesson.TurnBreathS;
            while (lesson.Index == 0 && Time.time - t0 < watch + turn + 1f) yield return null;
            Check(lesson.Index == 1 && !lesson.YourTurn && Mathf.Abs(Time.time - t0 - watch - turn) < 0.3f,
                $"then the next step ({Time.time - t0:F2} s, expected {watch + turn:F2})");

            var buttons = FindObjectsByType<FingertipButton>(FindObjectsInactive.Exclude);
            FingertipButton B(string label) => buttons.FirstOrDefault(b => b.label.text == label);
            Check(B("Previous step") != null && B("Again") != null && B("Next step") != null, "the rail has Previous step / Again / Next step in a lesson");
            yield return Push(B("Next step"));
            Check(lesson.Index == 2, $"Next step goes forward (step {lesson.Index + 1})");
            yield return Push(B("Next step"));
            Check(lesson.Index == 0, "and wraps after the last step");
            yield return Push(B("Previous step"));
            Check(lesson.Index == 2, "Previous step goes back, wrapping too");
            yield return Frames(10);
            yield return Push(B("Again"));
            Check(lesson.Index == 2 && lesson.Rep == 0 && !lesson.YourTurn && Mathf.Abs(player.Frame - lesson.steps[2].start * player.Dream.fps) <= 2f,
                $"Again restarts the step (frame {player.Frame})");
        }

        void Check(bool ok, string what)
        {
            if (!ok) Failures++;
            Debug.Log($"[Lucid Dreams] Hands check: {(ok ? "ok  " : "FAIL")} {what}");
        }

        static IEnumerator Frames(int n)
        {
            for (int i = 0; i < n; i++) yield return null;
        }

        // Pinches at from, moves to to over the duration, then lets go.
        IEnumerator Pinch(HandTracker.Hand hand, Vector3 from, Vector3 to, float seconds)
        {
            float t0 = Time.time;
            while (Time.time - t0 < seconds)
            {
                var p = Vector3.Lerp(from, to, Mathf.Clamp01((Time.time - t0) / seconds * 1.25f));
                hands.Simulate(hand, true, p + Vector3.right * 0.004f, p - Vector3.right * 0.004f);
                yield return null;
            }
            Release(hand);
            yield return Frames(3);
        }

        IEnumerator TwoHandTurn(Vector3 center, float halfSpan, float degrees, float seconds)
        {
            float t0 = Time.time;
            while (true)
            {
                float u = Mathf.Clamp01((Time.time - t0) / seconds * 1.25f);
                var offset = Quaternion.Euler(0f, degrees * u, 0f) * new Vector3(halfSpan, 0f, 0f);
                hands.Simulate(hands.right, true, center + offset + Vector3.up * 0.004f, center + offset - Vector3.up * 0.004f);
                hands.Simulate(hands.left, true, center - offset + Vector3.up * 0.004f, center - offset - Vector3.up * 0.004f);
                if (Time.time - t0 >= seconds) break;
                yield return null;
            }
            Release(hands.right);
            Release(hands.left);
            yield return Frames(3);
        }

        IEnumerator Push(FingertipButton button)
        {
            var front = button.transform.TransformPoint(new Vector3(0f, 0f, -30f));
            var through = button.transform.TransformPoint(new Vector3(0f, 0f, 6f));
            for (int i = 0; i <= 10; i++)
            {
                Point(hands.right, Vector3.Lerp(front, through, i / 10f));
                yield return null;
            }
            Point(hands.right, front);
            yield return Frames(3);
            Release(hands.right);
            yield return new WaitForSecondsRealtime(0.35f); // past the button's cooldown
        }

        // An open hand: index tip at the point, thumb well away (no pinch).
        void Point(HandTracker.Hand hand, Vector3 tip) => hands.Simulate(hand, true, tip, tip + new Vector3(0.05f, -0.04f, 0.03f));

        void Release(HandTracker.Hand hand) => hands.Simulate(hand, false, Vector3.zero, Vector3.zero);

        // A straight index finger from knuckle to tip; the other joints sit at the knuckle.
        void Finger(HandTracker.Hand hand, Vector3 knuckle, Vector3 tip)
        {
            Point(hand, knuckle);
            hand.joints[XRHandJointID.IndexProximal.ToIndex()] = knuckle;
            hand.joints[XRHandJointID.IndexIntermediate.ToIndex()] = Vector3.Lerp(knuckle, tip, 0.45f);
            hand.joints[XRHandJointID.IndexDistal.ToIndex()] = Vector3.Lerp(knuckle, tip, 0.75f);
            hand.joints[XRHandJointID.IndexTip.ToIndex()] = tip;
            hand.joints[XRHandJointID.ThumbTip.ToIndex()] = knuckle;
        }

        void Render(string path, Vector3 from, Vector3 lookAt)
        {
            var pose = (head.transform.position, head.transform.rotation);
            head.transform.position = from;
            head.transform.LookAt(lookAt);
            Render(path);
            head.transform.SetPositionAndRotation(pose.position, pose.rotation);
        }

        void Render(string path)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            var rt = new RenderTexture(1024, 1024, 24, RenderTextureFormat.ARGB32);
            var cam = head;
            var oldTarget = cam.targetTexture;
            var oldColor = cam.backgroundColor;
            cam.targetTexture = rt;
            cam.backgroundColor = new Color(0.32f, 0.32f, 0.34f, 1f);
            cam.fieldOfView = 70f;
            cam.Render();
            RenderTexture.active = rt;
            var tex = new Texture2D(rt.width, rt.height, TextureFormat.RGB24, false);
            tex.ReadPixels(new Rect(0, 0, rt.width, rt.height), 0, 0);
            RenderTexture.active = null;
            File.WriteAllBytes(path, tex.EncodeToPNG());
            cam.targetTexture = oldTarget;
            cam.backgroundColor = oldColor;
            Debug.Log($"[Lucid Dreams] Hands check: eye view written to {path}");
        }
    }
}
#endif
