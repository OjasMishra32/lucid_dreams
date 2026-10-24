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

            float until = Time.realtimeSinceStartup + 120f;
            while (!player.IsReady && player.Error == null && Time.realtimeSinceStartup < until) yield return null;
            Check(player.IsReady, $"bundle loaded ({player.Error})");
            if (!player.IsReady) { Done = true; yield break; }
            yield return Frames(30); // placement and the bar settle

            var root = placer.transform;
            Check(Vector3.Distance(root.position, new Vector3(0f, 0f, 0.5f)) < 0.02f, $"placed 1.5 m in front, on the floor ({root.position})");
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
