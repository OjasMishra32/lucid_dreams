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
    }
}
