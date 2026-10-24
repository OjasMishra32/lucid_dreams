using System;
using System.Runtime.InteropServices;
using Gaussians.ThreeD;
using UnityEngine;

namespace LucidDreams
{
    // Every frame of a replay, resident on the GPU in full float precision. The renderer draws whichever frame is
    // current through its deformation hook, so switching frames is a pointer swap plus a re-sort: no uploads while playing.
    // The renderer needs one Gaussian count for all frames, so smaller frames are padded with invisible Gaussians.
    public sealed class DreamSequence : IGaussianSplat3DDeformation, IDisposable
    {
        public int FrameCount => frames.Length;
        public int Capacity { get; }
        public int CoefficientCount { get; }
        public long GpuBytes => (long)FrameCount * BytesPerFrame;
        public long BytesPerFrame => (long)Capacity * (GaussianFrame.FloatsPerGaussian + GaussianFrame.SHWordsPerGaussian(CoefficientCount)) * 4;
        public int LoadedCount { get; private set; }
        public int Current { get; private set; }

        readonly GaussianSplat3DData[] frames;
        readonly float[] paddedAttributes;
        readonly uint[] paddedSH;
        uint revision = 1;

        public DreamSequence(int frameCount, int capacity, int coefficientCount)
        {
            frames = new GaussianSplat3DData[frameCount];
            Capacity = capacity;
            CoefficientCount = coefficientCount;
            paddedAttributes = new float[capacity * GaussianFrame.FloatsPerGaussian];
            paddedSH = new uint[capacity * GaussianFrame.SHWordsPerGaussian(coefficientCount)];
        }

        public bool IsLoaded(int index) => frames[index] != null;

        // Main thread only (GPU upload).
        public void Upload(int index, GaussianFrame frame)
        {
            Pad(frame);
            frames[index]?.Dispose();
            var data = new GaussianSplat3DData(Capacity, CoefficientCount, GaussianSplatSHStorage.Float16);
            data.Splats.SetData(paddedAttributes);
            data.SH.SetData(paddedSH);
            if (frames[index] == null) LoadedCount++;
            frames[index] = data;
        }

        public void Show(int index)
        {
            index = Mathf.Clamp(index, 0, FrameCount - 1);
            if (index == Current) return;
            Current = index;
            revision++; // positions moved: the renderer re-sorts
        }

        public bool TryGetFrame(GaussianSplat3DAsset canonical, out GaussianSplat3DFrame frame)
        {
            var data = frames[Current];
            frame = data != null ? new GaussianSplat3DFrame(data, revision, revision) : default;
            return data != null;
        }

        // The renderer's asset: float-source, same Gaussian count and SH as the frames. Its own data is the given frame.
        public GaussianSplat3DAsset CreateCanonicalAsset(GaussianFrame first, Bounds bounds, string id)
        {
            Pad(first);
            return CreateFloatAsset(paddedAttributes, paddedSH, Capacity, CoefficientCount, bounds, $"{id}/{Capacity}/{FrameCount}");
        }

        // A float-source renderer asset holding the given Gaussians (renderer layout, half-float SH).
        public static GaussianSplat3DAsset CreateFloatAsset(float[] attributes, uint[] sh, int count, int coefficientCount, Bounds bounds, string id)
        {
            var splatData = new TextAsset(MemoryMarshal.AsBytes(attributes.AsSpan(0, count * GaussianFrame.FloatsPerGaussian))) { name = $"{id} splats" };
            var shData = new TextAsset(MemoryMarshal.AsBytes(sh.AsSpan(0, count * GaussianFrame.SHWordsPerGaussian(coefficientCount)))) { name = $"{id} sh" };
            var asset = ScriptableObject.CreateInstance<GaussianSplat3DAsset>();
            asset.name = id;
            int degree = (int)Math.Round(Math.Sqrt(coefficientCount)) - 1;
            asset.InitializeFloat(count, degree, splatData, shData, bounds, Hash128.Compute(id), GaussianSplatSHStorage.Float16);
            return asset;
        }

        void Pad(GaussianFrame frame)
        {
            if (frame.count > Capacity) throw new ArgumentException($"Frame has {frame.count} Gaussians, capacity is {Capacity}");
            if (frame.coefficientCount != CoefficientCount)
                throw new ArgumentException($"Frame has {frame.coefficientCount} SH coefficients, sequence has {CoefficientCount}");

            Array.Copy(frame.attributes, paddedAttributes, frame.attributes.Length);
            Array.Copy(frame.sh, paddedSH, frame.sh.Length);

            // Invisible filler: zero opacity is rejected before sorting cost matters, tiny scale keeps it harmless.
            var center = frame.bounds.center;
            for (int i = frame.count; i < Capacity; i++)
            {
                int a = i * GaussianFrame.FloatsPerGaussian;
                paddedAttributes[a + 0] = center.x;
                paddedAttributes[a + 1] = center.y;
                paddedAttributes[a + 2] = center.z;
                paddedAttributes[a + 3] = 0f;
                paddedAttributes[a + 4] = paddedAttributes[a + 5] = paddedAttributes[a + 6] = 1e-6f;
                paddedAttributes[a + 7] = 0f;
                paddedAttributes[a + 8] = paddedAttributes[a + 9] = paddedAttributes[a + 10] = 0f;
                paddedAttributes[a + 11] = 1f;
            }
            Array.Clear(paddedSH, frame.sh.Length, paddedSH.Length - frame.sh.Length);
        }

        public void Dispose()
        {
            for (int i = 0; i < frames.Length; i++)
            {
                frames[i]?.Dispose();
                frames[i] = null;
            }
            LoadedCount = 0;
        }
    }
}
