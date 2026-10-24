using UnityEngine;
using UnityEngine.XR.Hands;

namespace LucidDreams
{
    // Invisible, depth-only stand-ins for each tracked hand (a sphere per joint, a capsule per finger bone), like the
    // WebXR app's handOccluder: your real fingers in passthrough stay in front of the person and the controls.
    public class HandOccluder : MonoBehaviour
    {
        static readonly XRHandJointID[][] Chains =
        {
            new[] { XRHandJointID.Wrist, XRHandJointID.ThumbMetacarpal, XRHandJointID.ThumbProximal, XRHandJointID.ThumbDistal, XRHandJointID.ThumbTip },
            new[] { XRHandJointID.Wrist, XRHandJointID.IndexMetacarpal, XRHandJointID.IndexProximal, XRHandJointID.IndexIntermediate, XRHandJointID.IndexDistal, XRHandJointID.IndexTip },
            new[] { XRHandJointID.Wrist, XRHandJointID.MiddleMetacarpal, XRHandJointID.MiddleProximal, XRHandJointID.MiddleIntermediate, XRHandJointID.MiddleDistal, XRHandJointID.MiddleTip },
            new[] { XRHandJointID.Wrist, XRHandJointID.RingMetacarpal, XRHandJointID.RingProximal, XRHandJointID.RingIntermediate, XRHandJointID.RingDistal, XRHandJointID.RingTip },
            new[] { XRHandJointID.Wrist, XRHandJointID.LittleMetacarpal, XRHandJointID.LittleProximal, XRHandJointID.LittleIntermediate, XRHandJointID.LittleDistal, XRHandJointID.LittleTip },
        };

        public HandTracker hands;
        public Shader depthOnly;
        [Tooltip("Fingers are drawn a little fatter than tracked so passthrough edges never show the person through them.")]
        public float radiusScale = 1.15f;

        class Rig
        {
            public GameObject root;
            public Transform[] joints;
            public (XRHandJointID a, XRHandJointID b, Transform t)[] bones;
        }

        Rig leftRig, rightRig;

        void Start()
        {
            var material = new Material(depthOnly) { name = "Hand occluder", enableInstancing = true };
            leftRig = Build("Left hand occluder", material);
            rightRig = Build("Right hand occluder", material);
        }

        Rig Build(string name, Material material)
        {
            var rig = new Rig { root = new GameObject(name) };
            rig.root.transform.SetParent(transform, false);
            var sphere = Primitive(PrimitiveType.Sphere);
            var cylinder = Primitive(PrimitiveType.Cylinder);

            int count = XRHandJointID.EndMarker.ToIndex();
            rig.joints = new Transform[count];
            for (int i = 0; i < count; i++) rig.joints[i] = Part(rig.root.transform, $"Joint {i}", sphere, material);

            var bones = new System.Collections.Generic.List<(XRHandJointID, XRHandJointID, Transform)>();
            foreach (var chain in Chains)
                for (int k = 1; k < chain.Length; k++)
                    bones.Add((chain[k - 1], chain[k], Part(rig.root.transform, $"{chain[k]}", cylinder, material)));
            rig.bones = bones.ToArray();
            return rig;
        }

        static Mesh Primitive(PrimitiveType type)
        {
            var go = GameObject.CreatePrimitive(type);
            var mesh = go.GetComponent<MeshFilter>().sharedMesh;
            Destroy(go);
            return mesh;
        }

        static Transform Part(Transform parent, string name, Mesh mesh, Material material)
        {
            var go = new GameObject(name, typeof(MeshFilter), typeof(MeshRenderer));
            go.transform.SetParent(parent, false);
            go.GetComponent<MeshFilter>().sharedMesh = mesh;
            var r = go.GetComponent<MeshRenderer>();
            r.sharedMaterial = material;
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            r.receiveShadows = false;
            return go.transform;
        }

        void LateUpdate()
        {
            if (leftRig == null) return;
            Pose(hands.left, leftRig);
            Pose(hands.right, rightRig);
        }

        void Pose(HandTracker.Hand hand, Rig rig)
        {
            rig.root.SetActive(hand.tracked);
            if (!hand.tracked) return;

            for (int i = 0; i < rig.joints.Length; i++)
            {
                bool ok = hand.valid[i];
                rig.joints[i].gameObject.SetActive(ok);
                if (!ok) continue;
                rig.joints[i].position = hand.joints[i];
                rig.joints[i].localScale = Vector3.one * Radius(hand, i) * 2f; // the sphere primitive has radius 0.5
            }

            foreach (var (a, b, t) in rig.bones)
            {
                int ia = a.ToIndex(), ib = b.ToIndex();
                bool ok = hand.valid[ia] && hand.valid[ib];
                t.gameObject.SetActive(ok);
                if (!ok) continue;
                Vector3 pa = hand.joints[ia], pb = hand.joints[ib];
                float length = Vector3.Distance(pa, pb);
                if (length < 1e-4f) { t.gameObject.SetActive(false); continue; }
                float r = Mathf.Min(Radius(hand, ia), Radius(hand, ib));
                t.position = (pa + pb) * 0.5f;
                t.rotation = Quaternion.FromToRotation(Vector3.up, pb - pa);
                t.localScale = new Vector3(r * 2f, length * 0.5f, r * 2f); // the cylinder primitive is 2 tall, radius 0.5
            }
        }

        float Radius(HandTracker.Hand hand, int i) => Mathf.Max(0.006f, hand.radii[i]) * radiusScale;
    }
}
