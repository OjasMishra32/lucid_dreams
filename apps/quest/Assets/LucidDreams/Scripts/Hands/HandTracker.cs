using System.Collections.Generic;
using UnityEngine;
using UnityEngine.XR.Hands;

namespace LucidDreams
{
    // Both tracked hands in world space, with a pinch state per hand. Pinch thresholds match the WebXR app:
    // thumb and index tips under 1.8 cm starts a pinch, over 3 cm ends it. A pinch rides out ~70 ms of the fingers
    // jittering apart and ~300 ms of lost tracking, so something held doesn't drop on its own; `opening` turns on as
    // soon as the fingers start to part, so a held thing lands where you let go.
    // Joint poses come from XR Hands in tracking space; trackingSpace (the XR Origin's camera offset) maps them to world.
    [DefaultExecutionOrder(-50)] // pinch state is fresh for everything that reads it this frame
    public class HandTracker : MonoBehaviour
    {
        public const float PinchOn = 0.018f;
        public const float PinchOff = 0.03f;
        public const float JitterS = 0.07f;
        public const float LostS = 0.3f;
        const float OpeningM = 0.008f; // fingers this much further apart than the pinch's tightest: letting go

        public class Hand
        {
            public readonly Handedness handedness;
            public bool tracked;
            public readonly Vector3[] joints = new Vector3[XRHandJointID.EndMarker.ToIndex()];
            public readonly Quaternion[] rotations = new Quaternion[XRHandJointID.EndMarker.ToIndex()];
            public readonly float[] radii = new float[XRHandJointID.EndMarker.ToIndex()];
            public readonly bool[] valid = new bool[XRHandJointID.EndMarker.ToIndex()];
            public bool pinching, pinchStarted, pinchEnded, opening;
            public Vector3 pinchPoint;
            internal float apartSince = -1f, lostSince = -1f, tightest;

            public Hand(Handedness h) => handedness = h;
            public Vector3 Joint(XRHandJointID id) => joints[id.ToIndex()];
            public bool Has(XRHandJointID id) => tracked && valid[id.ToIndex()];
            public Vector3 IndexTip => Joint(XRHandJointID.IndexTip);
            // Out of the palm (XR Hands' palm direction: the palm joint's -Y), when the palm is tracked.
            public bool TryPalm(out Vector3 position, out Vector3 normal)
            {
                position = Joint(XRHandJointID.Palm);
                normal = rotations[XRHandJointID.Palm.ToIndex()] * Vector3.down;
                return Has(XRHandJointID.Palm);
            }
        }

        public Transform trackingSpace;
        public readonly Hand left = new(Handedness.Left), right = new(Handedness.Right);
        public IEnumerable<Hand> Hands { get { yield return left; yield return right; } }

        // Tests and the editor feed joints directly; on the Quest they come from the hand subsystem.
        public bool simulated;

        XRHandSubsystem subsystem;
        static readonly List<XRHandSubsystem> found = new();

        void Update()
        {
            if (!simulated)
            {
                if (subsystem == null || !subsystem.running)
                {
                    SubsystemManager.GetSubsystems(found);
                    subsystem = found.Find(s => s.running);
                }
                Read(left, subsystem?.leftHand);
                Read(right, subsystem?.rightHand);
            }
            UpdatePinch(left);
            UpdatePinch(right);
        }

        void Read(Hand hand, XRHand? source)
        {
            hand.tracked = source.HasValue && source.Value.isTracked;
            if (!hand.tracked) return;
            for (int i = 0; i < hand.joints.Length; i++)
            {
                var joint = source.Value.GetJoint(XRHandJointIDUtility.FromIndex(i));
                hand.valid[i] = joint.TryGetPose(out var pose);
                if (!hand.valid[i]) continue;
                hand.joints[i] = trackingSpace != null ? trackingSpace.TransformPoint(pose.position) : pose.position;
                hand.rotations[i] = trackingSpace != null ? trackingSpace.rotation * pose.rotation : pose.rotation;
                hand.radii[i] = joint.TryGetRadius(out float r) ? r : 0.008f;
            }
        }

        // Sets a simulated hand's thumb and index tips (and the rest of the joints at the index tip).
        public void Simulate(Hand hand, bool tracked, Vector3 indexTip, Vector3 thumbTip)
        {
            simulated = true;
            hand.tracked = tracked;
            for (int i = 0; i < hand.joints.Length; i++)
            {
                hand.joints[i] = indexTip;
                hand.rotations[i] = Quaternion.identity;
                hand.radii[i] = 0.008f;
                hand.valid[i] = tracked;
            }
            hand.joints[XRHandJointID.ThumbTip.ToIndex()] = thumbTip;
        }

        // Turns a simulated hand's palm: centred at position, facing out along normal (the rest of the hand unchanged).
        public void SimulatePalm(Hand hand, Vector3 position, Vector3 normal)
        {
            simulated = true;
            int palm = XRHandJointID.Palm.ToIndex();
            hand.joints[palm] = position;
            hand.rotations[palm] = Quaternion.FromToRotation(Vector3.down, normal.normalized);
            hand.valid[palm] = true;
        }

        static void UpdatePinch(Hand hand)
        {
            bool was = hand.pinching;
            float now = Time.time;
            if (hand.Has(XRHandJointID.IndexTip) && hand.Has(XRHandJointID.ThumbTip))
            {
                hand.lostSince = -1f;
                var index = hand.Joint(XRHandJointID.IndexTip);
                var thumb = hand.Joint(XRHandJointID.ThumbTip);
                float d = Vector3.Distance(index, thumb);
                hand.pinchPoint = (index + thumb) * 0.5f;
                if (!was) hand.pinching = d < PinchOn;
                else if (d < PinchOff) hand.apartSince = -1f;
                else
                {
                    // apart: a jitter for a moment, a release after JitterS
                    if (hand.apartSince < 0f) hand.apartSince = now;
                    hand.pinching = now - hand.apartSince < JitterS;
                }
                if (hand.pinching) hand.tightest = was ? Mathf.Min(hand.tightest, d) : d;
                hand.opening = hand.pinching && d > hand.tightest + OpeningM;
            }
            else if (was)
            {
                // tracking lost mid-pinch: keep holding for a moment, at the last pinch point
                if (hand.lostSince < 0f) hand.lostSince = now;
                hand.pinching = now - hand.lostSince < LostS;
            }
            else hand.pinching = false;
            if (!hand.pinching)
            {
                hand.apartSince = hand.lostSince = -1f;
                hand.opening = false;
            }
            hand.pinchStarted = hand.pinching && !was;
            hand.pinchEnded = !hand.pinching && was;
        }
    }
}
