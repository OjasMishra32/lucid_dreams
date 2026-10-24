using System;
using System.IO;
using System.IO.Compression;
using Unity.Mathematics;
using UnityEngine;

namespace LucidDreams
{
    // Reads SPZ v2 (gzip of a 16-byte header + packed arrays) into a GaussianFrame. Pure managed code, safe on worker
    // threads. Decoding is the exact inverse of pipeline/lucid/gaussians.py write_spz: positions 24-bit fixed point,
    // alpha u8 (already activated), colour u8 = DC * 0.15 * 255 + 127.5, log scale u8 = (s + 10) * 16,
    // rotation xyz u8 with w >= 0 implied, SH u8 = coefficient * 128 + 128 (coefficient-major RGB).
    public static class SpzFrameReader
    {
        const uint Magic = 0x5053474E; // "NGSP"
        const float ColorScale = 0.15f;

        public static GaussianFrame Read(byte[] gzipped)
        {
            byte[] data = Gunzip(gzipped);
            if (data.Length < 16) throw new InvalidDataException("SPZ is shorter than its header");
            uint magic = BitConverter.ToUInt32(data, 0);
            uint version = BitConverter.ToUInt32(data, 4);
            int count = (int)BitConverter.ToUInt32(data, 8);
            int degree = data[12];
            int fractionalBits = data[13];
            if (magic != Magic) throw new InvalidDataException("Not an SPZ file");
            if (version != 2) throw new InvalidDataException($"SPZ version {version} is not supported (the pipeline writes version 2)");
            if (degree > 3) throw new InvalidDataException($"SPZ SH degree {degree} is not supported");

            int coefficients = (degree + 1) * (degree + 1);
            int rest = coefficients - 1;
            int posAt = 16, alphaAt = posAt + count * 9, colorAt = alphaAt + count, scaleAt = colorAt + count * 3;
            int rotAt = scaleAt + count * 3, shAt = rotAt + count * 3, end = shAt + count * rest * 3;
            if (data.Length < end) throw new InvalidDataException($"SPZ body is truncated: {count} Gaussians need {end} bytes");

            int shWords = GaussianFrame.SHWordsPerGaussian(coefficients);
            var frame = new GaussianFrame
            {
                count = count,
                coefficientCount = coefficients,
                attributes = new float[count * GaussianFrame.FloatsPerGaussian],
                sh = new uint[count * shWords],
            };

            float toMeters = 1f / (1 << fractionalBits);
            float3 min = new float3(float.MaxValue), max = new float3(float.MinValue);
            var shValues = new float[coefficients * 3];
            for (int i = 0; i < count; i++)
            {
                int a = i * GaussianFrame.FloatsPerGaussian;
                var pos = new float3(Fixed24(data, posAt + i * 9), Fixed24(data, posAt + i * 9 + 3), Fixed24(data, posAt + i * 9 + 6)) * toMeters;
                min = math.min(min, pos);
                max = math.max(max, pos);
                frame.attributes[a + 0] = pos.x;
                frame.attributes[a + 1] = pos.y;
                frame.attributes[a + 2] = pos.z;
                frame.attributes[a + 3] = data[alphaAt + i] / 255f;
                for (int c = 0; c < 3; c++) frame.attributes[a + 4 + c] = math.exp(data[scaleAt + i * 3 + c] / 16f - 10f);

                var xyz = new float3(data[rotAt + i * 3], data[rotAt + i * 3 + 1], data[rotAt + i * 3 + 2]) / 127.5f - 1f;
                var q = math.normalizesafe(new float4(xyz, math.sqrt(math.max(0f, 1f - math.dot(xyz, xyz)))), new float4(0, 0, 0, 1));
                frame.attributes[a + 8] = q.x;
                frame.attributes[a + 9] = q.y;
                frame.attributes[a + 10] = q.z;
                frame.attributes[a + 11] = q.w;

                for (int c = 0; c < 3; c++) shValues[c] = (data[colorAt + i * 3 + c] / 255f - 0.5f) / ColorScale;
                for (int j = 0; j < rest * 3; j++) shValues[3 + j] = (data[shAt + i * rest * 3 + j] - 128f) / 128f;
                GaussianFrame.PackHalves(shValues, frame.sh, i * shWords);
            }

            frame.bounds = count > 0 ? new Bounds((min + max) * 0.5f, max - min) : new Bounds();
            return frame;
        }

        static int Fixed24(byte[] data, int at)
        {
            int v = data[at] | (data[at + 1] << 8) | (data[at + 2] << 16);
            return (v & 0x800000) != 0 ? v | unchecked((int)0xFF000000) : v;
        }

        static byte[] Gunzip(byte[] gzipped)
        {
            using var input = new GZipStream(new MemoryStream(gzipped), CompressionMode.Decompress);
            using var output = new MemoryStream(gzipped.Length * 4);
            input.CopyTo(output);
            return output.ToArray();
        }
    }
}
