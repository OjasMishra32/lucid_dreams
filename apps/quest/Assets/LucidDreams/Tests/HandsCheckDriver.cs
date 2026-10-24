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
        public string talkServer, talkQuestion;
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
            placer = FindAnyObjectByType<DreamPlacer>();
            player = placer.player; // the first person (a second one has its own player)
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
            if (Seating.WantsSeat(player.Experience, player.Dream.intent))
            {
                yield return SeatedChecks(root);
                Debug.Log($"[Lucid Dreams] Hands check: {(Failures == 0 ? "PASS" : $"{Failures} FAILED")}");
                Done = true;
                yield break;
            }
            Check(!placer.Seat.seated && placer.person.localPosition == Vector3.zero && placer.GetComponent<DreamBench>().Root == null,
                "standing: feet on the floor, no bench");
            // Passthrough only: the person is always in your real room, whatever the plan's environment says.
            Check(!FindObjectsByType<FingertipButton>(FindObjectsInactive.Include).Any(b => b.label.text.StartsWith("Place")),
                "passthrough only: no Place button on the rail");
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
            var askedToSit = new Experience { intent = "sit next to me and teach me this piece", objects = { "piano", "bench" } };
            Check(!Seating.For(player.Body, askedToSit, askedToSit.intent).seated,
                $"a person standing at full height stays standing even when the plan says sit ({player.Body.Height:F2} m tall)");

            // Hands locked down: no pinch or gesture changes anything by itself (a dance or a swing pinches by accident).
            bool wasPlaying = player.IsPlaying;
            var start = root.position;
            float yaw0 = root.eulerAngles.y;
            var air = new Vector3(0.3f, 1.3f, 1.6f);
            yield return Pinch(hands.right, air, air, 0.12f);
            Check(player.IsPlaying == wasPlaying, "a quick pinch in the air changes nothing");
            var chest = start + Vector3.up * 1.2f;
            yield return Pinch(hands.right, chest, chest + new Vector3(0.3f, 0.2f, -0.2f), 0.6f);
            yield return TwoHandTurn(start + Vector3.up * 1.1f, 0.22f, 30f, 0.6f);
            var eye = head.transform.position;
            var aim = eye + (new Vector3(-0.8f, 0f, -0.5f) - eye).normalized * 0.5f;
            yield return Pinch(hands.right, aim, aim, 1.1f);
            yield return new WaitForSeconds(HandTracker.LostS + 0.1f);
            Check(Vector3.Distance(root.position, start) < 1e-4f && Mathf.Abs(Mathf.DeltaAngle(yaw0, root.eulerAngles.y)) < 0.01f
                  && player.IsPlaying == wasPlaying, "pinch-dragging the person, turning them with two hands and a long pinch move nothing");
            yield return PinchChecks();

            // The controls live on your left palm: turned toward your eyes for ~0.2 s, the menu opens just above it.
            Check(!bar.IsOpen && bar.Find("Play") == null && bar.Find("Pause") == null, "no controls float in front of you until your palm asks");
            var palm = new Vector3(0.12f, 1.25f, 1.62f); // in front of you, low, on your left (you face -Z here)
            ShowPalm(palm, eye - palm);
            yield return new WaitForSeconds(0.1f);
            Check(!bar.IsOpen, "a palm turning past doesn't flash it open");
            yield return new WaitForSeconds(0.25f);
            var above = palm + (eye - palm).normalized * 0.06f;
            Check(bar.IsOpen && Vector3.Distance(bar.transform.position, above) < 0.02f,
                $"palm up for 0.2 s opens it, just above your palm ({Vector3.Distance(bar.transform.position, above) * 100f:F1} cm off)");
            Render(Path.Combine(outputDir, "palm-menu-eye-view.png"));
            var playButton = bar.Find(player.IsPlaying ? "Pause" : "Play");
            Check(playButton != null && playButton.rightIndexOnly && !playButton.pinchPress, "only your right index fingertip presses it; pinches don't");
            wasPlaying = player.IsPlaying;
            yield return Push(playButton);
            Check(player.IsPlaying != wasPlaying, "a fingertip push on Play / Pause toggles playback");
            Check(bar.Find("1×") != null && bar.Find("Bring here") != null && bar.Find("Library") != null,
                "Speed, Bring here and Library are on it");
            Check((bar.Find("Reality check") != null) == player.HasReality, "Reality check only for a dream with reality frames");

            // Bring here re-stands them in front of you (and pins them there).
            placer.MoveTo(start + new Vector3(0.6f, 0f, -0.4f), yaw0 + 40f);
            ShowPalm(palm, eye - palm);
            yield return Push(bar.Find("Bring here"));
            Check(Vector3.Distance(root.position, start) < 0.02f && Vector3.Angle(root.forward, Vector3.forward) < 1f,
                $"Bring here stands them back in front of you, facing you ({root.position})");

            if (player.HasReality)
            {
                player.Pause();
                player.Scrub(0.4f);
                int frameBefore = player.Frame;
                ShowPalm(palm, eye - palm);
                yield return Push(bar.Find("Reality check"));
                until = Time.realtimeSinceStartup + 60f;
                while (!player.ShowingReality && player.RealityError == null && Time.realtimeSinceStartup < until)
                {
                    ShowPalm(palm, eye - palm);
                    yield return null;
                }
                yield return Frames(5);
                Check(player.ShowingReality && player.Frame == frameBefore, $"Reality check shows the imagined detail in blue, same moment ({player.RealityError})");
                Render(Path.Combine(outputDir, "reality-side-view.png"), root.position + new Vector3(2.4f, 1.1f, 0f), root.position + Vector3.up * 0.9f);
                ShowPalm(palm, eye - palm);
                yield return Push(bar.Find("Reality check"));
                yield return Frames(3);
                Check(!player.ShowingReality, "and back to the real colours");
            }

            // Palm turned away: it closes after ~0.45 s, not at once (a hand that wobbles keeps it).
            ShowPalm(palm, Vector3.down);
            yield return new WaitForSeconds(0.25f);
            Check(bar.IsOpen, "a wobble doesn't close it");
            yield return new WaitForSeconds(0.4f);
            Check(!bar.IsOpen && bar.Find("Bring here") == null, "palm turned away for ~0.45 s: it closes");
            Release(hands.left);

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

        // The ball on its track and a regulation hoop, in the person's space.
        IEnumerator PropsChecks(Transform root)
        {
            var props = placer.GetComponent<DreamProps>();
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
            // An idle only breathes (about 2 cm in 0.4 s); a frozen rig moves nothing.
            Check(most > 0.005f, $"playing moves it ({most * 100f:F1} cm at most after 0.4 s)");

            if (!string.IsNullOrEmpty(talkServer)) yield return TalkChecks();

            var mode = player.Experience?.mode;
            if (mode == "companion" || mode == "play")
            {
                // Eye contact: step to their side (paused, so only the look moves) and their face follows you.
                var start = head.transform.position;
                foreach (var side in new[] { 0f, 0.7f, -0.7f })
                {
                    head.transform.position = start + new Vector3(side, 0f, 0f);
                    yield return new WaitForSeconds(0.6f);
                    var t = player.transform;
                    var at = t.TransformPoint((Vector3)rig.HeadPosition);
                    var face = t.TransformVector((Vector3)rig.HeadForward).normalized; // TransformVector keeps the mirror
                    float off = Vector3.Angle(face, head.transform.position - at);
                    Check(off < 3f, $"eye contact from {side:+0.0;-0.0;0} m to the side: face {off:F1}° off your eyes (yaw {rig.Look.Yaw * Mathf.Rad2Deg:F1}°)");
                    if (side > 0f) Render(Path.Combine(outputDir, "avatar-look.png"), head.transform.position, at);
                }
                head.transform.position = start;
                yield return new WaitForSeconds(0.6f);
            }
            else Check(rig.Look.Resting, $"no eye contact in {mode ?? "no"} mode: the head plays the motion");

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

            // Bring in another: the second dream downloads, then stands 1.5 m to the first person's left on their clock.
            var another = panel.AnotherButton;
            Check(another.gameObject.activeSelf && another.label.text == "Bring in another", $"with someone playing, the library offers Bring in another ({another.label.text})");
            yield return Push(another);
            yield return Frames(2);
            Check(panel.Picking && panel.CardStatus("synthetic-test") == "Download to bring in" && another.label.text == "Cancel",
                $"it turns the cards into a pick ({panel.CardStatus("synthetic-test")})");
            Check(panel.CardFor("marker-teach") != null && !panel.CardFor("marker-teach").interactable, "the person already playing can't be picked twice");
            yield return Push(panel.CardFor("synthetic-test"));
            var synth = library.Entries.First(x => x.id == "synthetic-test");
            until = Time.realtimeSinceStartup + 60f;
            while (!synth.cached && synth.error == null && Time.realtimeSinceStartup < until) yield return null;
            yield return Frames(3);
            Check(panel.Picking && panel.CardStatus("synthetic-test") == "On this headset · Bring in", $"it downloads and the pick stays open ({panel.CardStatus("synthetic-test")})");
            yield return new WaitForSecondsRealtime(0.4f);
            Render(Path.Combine(outputDir, "library-bring-in-eye-view.png"));
            yield return Push(panel.CardFor("synthetic-test"));
            var companion = FindAnyObjectByType<DreamCompanion>();
            until = Time.realtimeSinceStartup + 60f;
            while (!companion.player.IsReady && companion.player.Error == null && Time.realtimeSinceStartup < until) yield return null;
            yield return Frames(3);
            var lead = placer.transform;
            Check(companion.player.IsReady && library.CompanionId == "synthetic-test" && library.PlayingId == "marker-teach" && !panel.IsOpen,
                $"picking brings them in next to the first person, who keeps playing ({companion.player.Error})");
            Check(Vector3.Distance(companion.transform.position, lead.position - lead.right * 1.5f) < 0.005f
                  && Vector3.Angle(companion.transform.forward, lead.forward) < 0.5f && companion.player.transform.lossyScale.z < 0f,
                $"1.5 m to the first person's left, facing the same way, mirrored the same ({companion.transform.position} vs {lead.position})");
            Check(companion.player.Lesson == null && player.Lesson != null, "one lesson: the second person follows it rather than running their own");
            player.Pause();
            player.Seek(0.7f);
            yield return Frames(2);
            float expect = 0.7f % (companion.player.Duration + 1e-4f);
            Check(!companion.player.IsPlaying && Mathf.Abs(companion.player.ClipTime - expect) < 1e-3f,
                $"on the same clock: paused together, at {companion.player.ClipTime:F3} s ({expect:F3} s, their clip is shorter so it loops)");
            player.Play();
            yield return Frames(5);
            Check(companion.player.IsPlaying && Mathf.Approximately(companion.player.Speed, player.Speed), $"and playing together at {player.Speed}x");
            Check(companion.player.GpuBytes > 0 && player.GpuBytes > 0,
                $"both on the GPU: {player.GpuBytes >> 10} + {companion.player.GpuBytes >> 10} KB, one budget");
            placer.MoveTo(lead.position + new Vector3(0.3f, 0f, -0.2f), lead.eulerAngles.y + 30f);
            yield return Frames(2);
            Check(Vector3.Distance(companion.transform.position, lead.position - lead.right * 1.5f) < 0.005f, "moving and turning the first person brings the second along");
            placer.PlaceInFrontOfViewer();
            yield return Frames(2);
            Render(Path.Combine(outputDir, "two-people-eye-view.png"), head.transform.position, (lead.position + companion.transform.position) / 2f + Vector3.up * 0.9f);
            Render(Path.Combine(outputDir, "two-people-front.png"), (lead.position + companion.transform.position) / 2f + lead.forward * 3.2f + Vector3.up * 1.2f,
                (lead.position + companion.transform.position) / 2f + Vector3.up * 0.9f);

            panel.Open();
            yield return Frames(3);
            Check(another.label.text == "Remove second person" && panel.CardStatus("synthetic-test") == "Beside them now",
                $"the library says who's beside them and offers to remove them ({panel.CardStatus("synthetic-test")})");
            yield return Push(another);
            yield return Frames(2);
            Check(library.CompanionId == null && !companion.Present && !companion.player.IsReady && companion.player.GpuBytes == 0 && player.IsReady,
                "Remove second person frees them; the first keeps playing");
            panel.Close();

            library.bridgeUrl = "http://127.0.0.1:9"; // the bridge is gone
            library.Refresh();
            yield return Frames(2);
            until = Time.realtimeSinceStartup + 15f;
            while (library.Refreshing && Time.realtimeSinceStartup < until) yield return null;
            Check(!library.Online && library.Entries.Count == 2 && library.Entries.All(x => x.cached),
                $"offline, it lists what's on the headset ({library.Entries.Count} dreams)");
            library.Play(library.Entries[0]);
            until = Time.realtimeSinceStartup + 60f;
            yield return Frames(2);
            while (!player.IsReady && player.Error == null && Time.realtimeSinceStartup < until) yield return null;
            Check(player.IsReady, $"and plays it with no bridge ({player.Error})");
        }

        // A lesson from experience.json: placement by place, steps at their speed and repeats, your turn, Back/Again/Next.
        // Seated at a bench (Seating): hips at bench height, a piano bench under them, voice and captions raised with them.
        IEnumerator SeatedChecks(Transform root)
        {
            Check(Experience.Fallback("teach me this piece on the piano", 3f).place == "beside"
                  && Experience.Fallback("teach me this dance", 3f).place == "ahead"
                  && !Seating.WantsSeat(null, "teach me this jump shot") && !Seating.WantsSeat(new Experience { objects = { "basketball", "hoop" } }, null)
                  && Seating.WantsSeat(new Experience { objects = { "piano", "bench" } }, null) && Seating.WantsSeat(null, "sit next to me and teach me this piece"),
                "an instrument plays beside you; a piano, a bench or \"sit\" asks for a seat, a jump shot doesn't");
            var seat = placer.Seat;
            var body = player.Body;
            var person = placer.person;
            Check(seat.seated, $"seated: {body.Height:F2} m from lowest point to top, seat {body.seat - body.low:F2} m above the lowest point");
            if (!seat.seated) yield break;
            Check(placer.place == DreamPlacer.Place.Beside && Vector3.Distance(root.position, new Vector3(-0.8f, 0f, 1.5f)) < 0.02f
                  && Vector3.Angle(root.forward, Vector3.back) < 1f, $"beside: at your right, facing your way ({root.position})");

            float Above(float bundleY) => person.TransformPoint(new Vector3(body.axis.x, bundleY, body.axis.y)).y - placer.FloorY;
            Check(Mathf.Abs(Above(body.seat) - seat.benchTop) < 0.005f, $"hips at bench height ({Above(body.seat):F3} m, bench {seat.benchTop:F3} m)");
            if (!seat.legs)
                Check(Mathf.Approximately(seat.benchTop, Seating.BenchHeight) && Above(body.low) > 0.3f,
                    $"no legs in the reconstruction: raised {seat.lift:F2} m, hips on a {Seating.BenchHeight:F2} m piano bench, nothing on the floor");
            else
                Check(Mathf.Abs(Above(0f)) < 0.001f && Above(body.low) < 0.05f && seat.benchTop > 0.38f && seat.benchTop < 0.6f,
                    $"legs in the reconstruction: their floor on yours, feet on it ({Above(body.low):F3} m), the bench at their own seat ({seat.benchTop:F2} m)");

            var bench = placer.GetComponent<DreamBench>();
            var benchRoot = bench.Root;
            Check(benchRoot != null, "a bench is built under them (the reconstruction has none)");
            if (benchRoot == null) yield break;
            Bounds Of(string part)
            {
                var rs = benchRoot.GetComponentsInChildren<MeshRenderer>().Where(r => r.name == part).ToArray();
                var b = rs[0].bounds;
                foreach (var r in rs) b.Encapsulate(r.bounds);
                return b;
            }
            var cushion = Of("Cushion");
            var legs = Of("Leg");
            Check(Mathf.Abs(cushion.max.y - placer.FloorY - seat.benchTop) < 0.002f && Mathf.Abs(legs.min.y - placer.FloorY) < 0.002f,
                $"cushion level with the hips ({cushion.max.y:F3} m), legs on the floor ({legs.min.y:F3} m)");
            var hips = person.TransformPoint(new Vector3(body.axis.x, body.seat, body.seatBack - 0.08f));
            var top = Of("Case");
            Check(hips.x > top.min.x && hips.x < top.max.x && hips.z > top.min.z && hips.z < top.max.z,
                $"under the hips ({hips.x:F2}, {hips.z:F2} inside x {top.min.x:F2}..{top.max.x:F2}, z {top.min.z:F2}..{top.max.z:F2})");
            Check(Mathf.Abs(top.size.x - Seating.BenchWidth) < 0.002f && Mathf.Abs(top.size.z - Seating.BenchDepth) < 0.002f,
                $"a real piano bench, {top.size.x:F2} x {top.size.z:F2} m");

            var speech = FindAnyObjectByType<DreamSpeech>();
            float mouth = speech.Voice.transform.position.y - placer.FloorY, crown = Above(player.Dream.bounds.Max.y);
            Check(Mathf.Abs(mouth - (crown - 0.13f)) < 0.005f, $"their voice comes from their mouth, seated ({mouth:F2} m, top of the head {crown:F2} m)");

            // grabbing moves them, bench and all, and they stay seated
            placer.MoveTo(root.position + new Vector3(0.4f, 0f, -0.3f), root.eulerAngles.y + 25f);
            yield return Frames(2);
            Check(Mathf.Abs(Above(body.seat) - seat.benchTop) < 0.005f && Mathf.Abs(Of("Leg").min.y - placer.FloorY) < 0.002f,
                "moved and turned, still on the bench and the bench still on the floor");
            placer.PlaceInFrontOfViewer();
            yield return Frames(2);

            player.Pause();
            player.Seek(0.3f);
            yield return Frames(2);
            Render(Path.Combine(outputDir, "seated-eye.png"), head.transform.position, root.position + Vector3.up * 0.8f);
            Render(Path.Combine(outputDir, "seated-front.png"), root.position + root.forward * 2.0f + Vector3.up * 1.0f, root.position + Vector3.up * 0.65f);
            Render(Path.Combine(outputDir, "seated-side.png"), root.position + root.right * 2.2f + Vector3.up * 0.9f, root.position + Vector3.up * 0.6f);
        }

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

            var palm = new Vector3(0.12f, 1.25f, 1.62f);
            var eyes = head.transform.position;
            FingertipButton B(string label)
            {
                ShowPalm(palm, eyes - palm); // the palm stays up between presses
                return bar.Find(label);
            }
            ShowPalm(palm, eyes - palm);
            yield return new WaitForSeconds(0.35f);
            Check(B("Back") != null && B("Again") != null && B("Next") != null && B("1×") == null, "in a lesson the palm menu has Back / Again / Next (no Speed)");
            yield return Push(B("Next"));
            Check(lesson.Index == 2, $"Next goes forward (step {lesson.Index + 1})");
            yield return Push(B("Next"));
            Check(lesson.Index == 0, "and wraps after the last step");
            yield return Push(B("Back"));
            Check(lesson.Index == 2, "Back goes back, wrapping too");
            // Let the step run on, so a restart is unmistakable, then Again: it's back near the step's start (within the
            // ~0.6 s a press takes, at the step's speed), not where it had got to.
            yield return new WaitForSeconds(0.8f);
            float startFrame = lesson.steps[2].start * player.Dream.fps;
            float pressFrames = 0.6f * lesson.steps[2].Speed * player.Dream.fps + 2f;
            yield return Push(B("Again"));
            Check(lesson.Index == 2 && lesson.Rep == 0 && !lesson.YourTurn && player.Frame >= startFrame - 2f && player.Frame <= startFrame + pressFrames,
                $"Again restarts the step (frame {player.Frame}, the step starts at {startFrame:F0})");
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

        // Talk: a recorded question to the talk server, and their reply from their mouth, labelled as AI.
        IEnumerator TalkChecks()
        {
            var talk = FindAnyObjectByType<DreamTalk>();
            var speech = FindAnyObjectByType<DreamSpeech>();
            talk.Configure(talkServer);
            Check(talk.Available == (player.Experience?.mode == "companion"), $"Talk is offered with someone you're with ({player.Experience?.mode})");
            var eyes = head.transform.position;
            var palm = new Vector3(0.12f, 1.25f, 1.62f);
            ShowPalm(palm, eyes - palm);
            yield return new WaitForSeconds(0.35f);
            Check(bar.Find("Talk") != null, "the palm menu has Talk");
            Render(Path.Combine(outputDir, "talk-menu-eye-view.png"));
            ShowPalm(palm, Vector3.down);
            Release(hands.left);
            player.Play();
            yield return Frames(5);
            float t0 = Time.realtimeSinceStartup;
            yield return talk.Ask(System.IO.File.ReadAllBytes(talkQuestion));
            float took = Time.realtimeSinceStartup - t0;
            Check(talk.Error == null && speech.Replying, $"a question gets a spoken reply in {took:F1} s (heard \"{talk.LastHeard}\", said \"{talk.LastReply}\") {talk.Error}");
            yield return Frames(3);
            Check(speech.Reply.transform.position == speech.Voice.transform.position && !speech.Voice.isPlaying,
                "it comes from their mouth, and the clip's own voice waits");
            Check(speech.CaptionText != null && speech.CaptionText.Contains("AI voice") && speech.CaptionText.Contains(talk.LastReply),
                "the caption shows their words, labelled AI voice");
            Render(Path.Combine(outputDir, "talk-reply-eye-view.png"));
            float until = Time.realtimeSinceStartup + 30f;
            while (speech.Replying && Time.realtimeSinceStartup < until) yield return null;
            yield return new WaitForSeconds(0.5f);
            Check(!speech.Replying && (speech.CaptionText == null || !speech.CaptionText.Contains("AI voice")), "when they finish, the reply caption goes");
        }

        // Your left hand open (no pinch), its palm at the point and facing along normal.
        void ShowPalm(Vector3 at, Vector3 normal)
        {
            hands.Simulate(hands.left, true, at + Vector3.up * 0.09f, at + new Vector3(0.06f, 0.02f, 0f));
            hands.SimulatePalm(hands.left, at, normal);
        }

        // A held pinch rides out a moment of the fingers jittering apart or of lost tracking, and says when it opens.
        IEnumerator PinchChecks()
        {
            var at = new Vector3(-0.3f, 1.2f, 1.6f);
            void Fingers(float apart) => hands.Simulate(hands.right, true, at + Vector3.right * apart / 2f, at - Vector3.right * apart / 2f);
            Fingers(0.008f);
            yield return Frames(3);
            bool held = hands.right.pinching;
            Fingers(0.04f);
            yield return new WaitForSeconds(0.03f);
            bool throughJitter = hands.right.pinching && hands.right.opening;
            Fingers(0.008f);
            yield return Frames(2);
            hands.Simulate(hands.right, false, Vector3.zero, Vector3.zero);
            yield return new WaitForSeconds(0.15f);
            bool throughLoss = hands.right.pinching;
            Fingers(0.008f);
            yield return Frames(2);
            Fingers(0.04f);
            yield return new WaitForSeconds(HandTracker.JitterS + 0.05f);
            Check(held && throughJitter && throughLoss && !hands.right.pinching,
                "a pinch rides out 30 ms of the fingers parting (and says it's opening) and 150 ms of lost tracking, then lets go");
            Release(hands.right);
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
            if (button == null) yield break; // its own Check already failed; don't stop the rest
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
