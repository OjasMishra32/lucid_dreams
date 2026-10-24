using System.Collections.Generic;
using UnityEngine;
using UnityEngine.XR.Hands;

namespace LucidDreams
{
    // Both tracked hands in world space, with a pinch state per hand. Pinch thresholds match the WebXR app:
    // thumb and index tips under 1.8 cm starts a pinch, over 3 cm ends it.
    // Joint poses come from XR Hands in tracking space; trackingSpace (the XR Origin's camera offset) maps them to world.
    [DefaultExecutionOrder(-50)] // pinch state is fresh for everything that reads it this frame
    public class HandTracker : MonoBehaviour
    {
        public const float PinchOn = 0.018f;
        public const float PinchOff = 0.03f;

        public class Hand
        {
            public readonly Handedness handedness;
            public bool tracked;
            public readonly Vector3[] joints = new Vector3[XRHandJointID.EndMarker.ToIndex()];
            public readonly float[] radii = new float[XRHandJointID.EndMarker.ToIndex()];
            public readonly bool[] valid = new bool[XRHandJointID.EndMarker.ToIndex()];
            public bool pinching, pinchStarted, pinchEnded;
            public Vector3 pinchPoint;

            public Hand(Handedness h) => handedness = h;
            public Vector3 Joint(XRHandJointID id) => joints[id.ToIndex()];
            public bool Has(XRHandJointID id) => tracked && valid[id.ToIndex()];
            public Vector3 IndexTip => Joint(XRHandJointID.IndexTip);
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
                hand.radii[i] = 0.008f;
                hand.valid[i] = tracked;
            }
            hand.joints[XRHandJointID.ThumbTip.ToIndex()] = thumbTip;
        }

        static void UpdatePinch(Hand hand)
        {
            bool was = hand.pinching;
            if (hand.Has(XRHandJointID.IndexTip) && hand.Has(XRHandJointID.ThumbTip))
            {
                var index = hand.Joint(XRHandJointID.IndexTip);
                var thumb = hand.Joint(XRHandJointID.ThumbTip);
                float d = Vector3.Distance(index, thumb);
                hand.pinching = was ? d < PinchOff : d < PinchOn;
                hand.pinchPoint = (index + thumb) * 0.5f;
            }
            else hand.pinching = false;
            hand.pinchStarted = hand.pinching && !was;
            hand.pinchEnded = !hand.pinching && was;
        }
    }
}
