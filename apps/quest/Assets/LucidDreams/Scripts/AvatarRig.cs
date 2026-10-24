using System;
using System.Collections.Generic;
using Gaussians.ThreeD;
using Unity.Mathematics;
using UnityEngine;

namespace LucidDreams
{
    // An avatar bundle played live, as apps/webxr/src/avatar.ts does: Gaussians in the SMPL-X rest pose, skinned on
    // the GPU from avatar/skin.bin and avatar/skeleton.json, posed every display frame from avatar/motion.json with
    // per-joint slerp between motion frames. Bone maths is avatars/README.md's ("Posing one frame"), in the bundle's own
    // right-handed space; every bone's rest is the identity, so each bone gets the whole skinning transform M_j, blended
    // per Gaussian as dual quaternions.
    public sealed class AvatarRig : IDisposable
    {
        public const int JointCount = 55;

        public int Count { get; }
        public int CoefficientCount { get; }
        public int FrameCount => local.Length;
        public float Fps { get; }
        public float Duration => FrameCount / Fps;
        public bool ShowingReality => showReality && realityOut != null;
        public bool HasRealityLoaded => realityOut != null;
        // Eye contact, layered on the motion (StepLook each frame, then Pose).
        public HeadLook Look { get; } = new HeadLook();
        // Where the head is and which way the face points as last posed, in the bundle's space (for checks).
        public float3 HeadPosition => pos[HeadLook.Head] + posedRoot;
        public float3 HeadForward => math.rotate(rot[HeadLook.Head], new float3(0f, 0f, 1f));

        readonly int[] parents;
        readonly float3[] rest;
        readonly quaternion[][] local; // per motion frame, per joint (root_q folded into joint 0)
        readonly float3[] rootT;
        readonly ComputeShader shader;
        readonly int kernel;
        readonly GraphicsBuffer restBuffer, skinBuffer, boneBuffer;
        readonly GaussianSplat3DData output;
        GaussianSplat3DData realityOut;
        readonly float4[] bones = new float4[JointCount * 2];
        readonly quaternion[] rot = new quaternion[JointCount];
        readonly float3[] pos = new float3[JointCount];
        readonly quaternion[] blend = new quaternion[JointCount];
        bool showReality;
        uint revision = 1;
        float posedAt = float.NaN, posedYaw, posedPitch;
        float3 posedRoot;

        // Parsed on a worker thread, then handed to the constructor on the main thread.
        public class Source
        {
            public GaussianFrame rest;
            public uint[] skin; // two uints per Gaussian: packed indices, packed weights
            public int[] parents;
            public float3[] restJoints;
            public quaternion[][] local;
            public float3[] rootT;
            public float fps;

            public static Source Parse(GaussianFrame rest, byte[] skin, string skeletonJson, string motionJson)
            {
                if (skin.Length != rest.count * 8)
                    throw new FormatException($"skin.bin has {skin.Length / 8} records for {rest.count} Gaussians");
                var s = new Source { rest = rest, skin = new uint[rest.count * 2] };
                Buffer.BlockCopy(skin, 0, s.skin, 0, skin.Length);

                var skeleton = MiniJson.Obj(MiniJson.Parse(skeletonJson), "skeleton.json");
                var parents = MiniJson.Arr(skeleton["parents"], "skeleton.parents");
                var restList = MiniJson.Arr(skeleton["rest"], "skeleton.rest");
                if (parents.Count != JointCount || restList.Count != JointCount)
                    throw new FormatException($"skeleton.json must have {JointCount} joints");
                s.parents = new int[JointCount];
                s.restJoints = new float3[JointCount];
                for (int j = 0; j < JointCount; j++)
                {
                    s.parents[j] = (int)MiniJson.Num(parents[j], "parent");
                    if (s.parents[j] >= j) throw new FormatException("skeleton parents must come before their children");
                    var r = MiniJson.Floats(restList[j], 3, "rest joint");
                    s.restJoints[j] = new float3(r[0], r[1], r[2]);
                }

                var motion = MiniJson.Obj(MiniJson.Parse(motionJson), "motion.json");
                s.fps = (float)MiniJson.Num(motion["fps"], "motion.fps");
                var frames = MiniJson.Arr(motion["frames"], "motion.frames");
                if (frames.Count == 0 || s.fps <= 0f) throw new FormatException("motion.json has no frames");
                s.local = new quaternion[frames.Count][];
                s.rootT = new float3[frames.Count];
                for (int f = 0; f < frames.Count; f++)
                {
                    var frame = MiniJson.Obj(frames[f], "motion frame");
                    var t = MiniJson.Floats(frame["root_t"], 3, "root_t");
                    var q = MiniJson.Floats(frame["root_q"], 4, "root_q");
                    var pose = Pose(frame["pose"]);
                    var l = new quaternion[JointCount];
                    for (int j = 0; j < JointCount; j++) l[j] = AxisAngle(pose[j]);
                    l[0] = math.mul(math.normalize(new quaternion(q[0], q[1], q[2], q[3])), l[0]);
                    s.local[f] = l;
                    s.rootT[f] = new float3(t[0], t[1], t[2]);
                }
                return s;
            }

            // 55 x [x, y, z], or the same 165 numbers flat.
            static float3[] Pose(object o)
            {
                var a = MiniJson.Arr(o, "pose");
                var p = new float3[JointCount];
                if (a.Count == JointCount * 3)
                {
                    for (int j = 0; j < JointCount; j++)
                        p[j] = new float3((float)MiniJson.Num(a[j * 3], "pose"), (float)MiniJson.Num(a[j * 3 + 1], "pose"), (float)MiniJson.Num(a[j * 3 + 2], "pose"));
                    return p;
                }
                if (a.Count != JointCount) throw new FormatException($"pose must have {JointCount} joints");
                for (int j = 0; j < JointCount; j++)
                {
                    var v = MiniJson.Floats(a[j], 3, "pose joint");
                    p[j] = new float3(v[0], v[1], v[2]);
                }
                return p;
            }

            static quaternion AxisAngle(float3 v)
            {
                float angle = math.length(v);
                return angle < 1e-12f ? quaternion.identity : quaternion.AxisAngle(v / angle, angle);
            }
        }

        public AvatarRig(Source s, ComputeShader skinning)
        {
            Count = s.rest.count;
            CoefficientCount = s.rest.coefficientCount;
            Fps = s.fps;
            parents = s.parents;
            rest = s.restJoints;
            local = s.local;
            rootT = s.rootT;
            shader = skinning;
            kernel = shader.FindKernel("Skin");

            restBuffer = new GraphicsBuffer(GraphicsBuffer.Target.Structured, Count, GaussianFrame.FloatsPerGaussian * 4) { name = "Avatar rest" };
            restBuffer.SetData(s.rest.attributes);
            skinBuffer = new GraphicsBuffer(GraphicsBuffer.Target.Structured, Count, 8) { name = "Avatar skin" };
            skinBuffer.SetData(s.skin);
            boneBuffer = new GraphicsBuffer(GraphicsBuffer.Target.Structured, JointCount * 2, 16) { name = "Avatar bones" };
            output = NewOutput(s.rest);
        }

        GaussianSplat3DData NewOutput(GaussianFrame colours)
        {
            var data = new GaussianSplat3DData(Count, colours.coefficientCount, GaussianSplatSHStorage.Float16);
            data.Splats.SetData(colours.attributes); // rest pose until the first Pose
            data.SH.SetData(colours.sh);
            return data;
        }

        // The reality file has the same Gaussians in the same order; only colours differ, so it skins identically.
        public void AddReality(GaussianFrame reality)
        {
            if (reality.count != Count) throw new FormatException($"reality has {reality.count} Gaussians, the avatar {Count}");
            realityOut?.Dispose();
            realityOut = NewOutput(reality);
        }

        public void ShowReality(bool on)
        {
            if (on == showReality) return;
            showReality = on;
            posedAt = float.NaN; // the other output hasn't been posed yet
        }

        // Eases the head toward eye (the viewer's eyes in the bundle's space, or null to look ahead) for the pose at t.
        public void StepLook(float3? eye, float t, float dt)
        {
            if (eye == null && Look.Resting) return;
            var root = Blend(t);
            Look.Step(blend, parents, rest, root, eye, dt);
        }

        // Pose at t seconds (looping), blending between the motion's frames so it's smooth at any display rate.
        public void Pose(float t)
        {
            if (t == posedAt && Look.Yaw == posedYaw && Look.Pitch == posedPitch) return;
            posedAt = t;
            posedYaw = Look.Yaw;
            posedPitch = Look.Pitch;
            var root = Blend(t);
            Look.Apply(blend);
            posedRoot = root;
            SkinTransforms(blend, root);

            var target = ShowingReality ? realityOut : output;
            boneBuffer.SetData(bones);
            shader.SetInt("_Count", Count);
            shader.SetBuffer(kernel, "_Rest", restBuffer);
            shader.SetBuffer(kernel, "_Skin", skinBuffer);
            shader.SetBuffer(kernel, "_Bones", boneBuffer);
            shader.SetBuffer(kernel, "_Out", target.Splats);
            shader.Dispatch(kernel, (Count + 255) / 256, 1, 1);
            revision++;
        }

        // The motion's joint rotations at t into blend; returns the root translation.
        float3 Blend(float t)
        {
            int n = local.Length;
            float f = ((t * Fps) % n + n) % n;
            int i0 = (int)math.floor(f) % n, i1 = (i0 + 1) % n;
            float a = f - math.floor(f);
            for (int j = 0; j < JointCount; j++) blend[j] = math.slerp(local[i0][j], local[i1][j], a);
            return math.lerp(rootT[i0], rootT[i1], a);
        }

        // G_0 = [R(root) | rest_0], G_j = G_parent [R(pose_j) | rest_j - rest_parent], M_j = G_j [I | -rest_j] + root_t,
        // packed per bone as a unit dual quaternion (real = rotation, dual = 0.5 * translation * real).
        void SkinTransforms(quaternion[] l, float3 rootTranslation)
        {
            for (int j = 0; j < JointCount; j++)
            {
                int p = parents[j];
                if (p < 0)
                {
                    rot[j] = l[j];
                    pos[j] = rest[j];
                }
                else
                {
                    rot[j] = math.mul(rot[p], l[j]);
                    pos[j] = math.rotate(rot[p], rest[j] - rest[p]) + pos[p];
                }
                var q = math.normalize(rot[j]);
                float3 t = pos[j] - math.rotate(q, rest[j]) + rootTranslation;
                var dual = math.mul(new quaternion(t.x, t.y, t.z, 0f), q).value * 0.5f;
                bones[j * 2] = q.value;
                bones[j * 2 + 1] = dual;
            }
        }

        public bool TryGetFrame(out GaussianSplat3DFrame frame)
        {
            frame = new GaussianSplat3DFrame(ShowingReality ? realityOut : output, revision, revision);
            return true;
        }

        // The posed Gaussians, read back (tests compare them with the Python reference).
        public float[] ReadBack()
        {
            var data = new float[Count * GaussianFrame.FloatsPerGaussian];
            (ShowingReality ? realityOut : output).Splats.GetData(data);
            return data;
        }

        public void Dispose()
        {
            restBuffer?.Dispose();
            skinBuffer?.Dispose();
            boneBuffer?.Dispose();
            output?.Dispose();
            realityOut?.Dispose();
        }
    }
}
