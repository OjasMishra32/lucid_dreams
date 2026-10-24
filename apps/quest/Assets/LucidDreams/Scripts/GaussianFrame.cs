using Unity.Mathematics;
using UnityEngine;

namespace LucidDreams
{
    // One frame of Gaussians in the renderer's float layout (Gaussians.ThreeD.GaussianSplat3DData):
    // attributes are three float4 per Gaussian (position + opacity, scale + pad, rotation xyzw), all activated;
    // sh is coefficient-major RGB including DC, packed as half floats, two per uint.
    public class GaussianFrame
    {
        public int count;
        public int coefficientCount; // 1, 4, 9 or 16 (SH degree 0-3)
        public float[] attributes;
        public uint[] sh;
        public Bounds bounds;

        public const int FloatsPerGaussian = 12;
        public static int SHWordsPerGaussian(int coefficientCount) => (coefficientCount * 3 + 1) / 2;
        public long GpuBytes => (long)count * (FloatsPerGaussian * 4 + SHWordsPerGaussian(coefficientCount) * 4);

        // Component 2n goes in the low 16 bits of word n, matching the renderer's LoadSourceSHComponent.
        public static void PackHalves(float[] values, uint[] dst, int start)
        {
            for (int i = 0; i < values.Length; i += 2)
            {
                uint lo = math.f32tof16(values[i]);
                uint hi = i + 1 < values.Length ? math.f32tof16(values[i + 1]) : 0u;
                dst[start + i / 2] = lo | (hi << 16);
            }
        }
    }
}
