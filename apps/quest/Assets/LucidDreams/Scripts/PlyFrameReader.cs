using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Unity.Mathematics;
using UnityEngine;

namespace LucidDreams
{
    // Reads a standard 3DGS PLY (binary little endian) into a GaussianFrame. Pure managed code, safe on worker threads.
    // Conversions match the renderer's own importer: sigmoid opacity, exp scale, (w,x,y,z) -> normalized (x,y,z,w),
    // raw f_dc kept as SH DC, f_rest reordered from channel-major to coefficient-major.
    public static class PlyFrameReader
    {
        struct Property
        {
            public string name;
            public int offset;
            public int size;
            public char kind; // 'f' float, 'd' double, 'u' unsigned, 's' signed
        }

        public static GaussianFrame Read(byte[] data)
        {
            int count = ParseHeader(data, out int bodyStart, out int stride, out var props);
            if ((long)count * stride > data.Length - bodyStart)
                throw new InvalidDataException($"PLY body is truncated: {count} Gaussians need {(long)count * stride} bytes");

            int Offset(string name)
            {
                if (props.TryGetValue(name, out var p)) return p.offset;
                throw new InvalidDataException($"PLY is missing '{name}'");
            }

            int x = Offset("x"), y = Offset("y"), z = Offset("z");
            int op = Offset("opacity");
            int s0 = Offset("scale_0"), s1 = Offset("scale_1"), s2 = Offset("scale_2");
            int r0 = Offset("rot_0"), r1 = Offset("rot_1"), r2 = Offset("rot_2"), r3 = Offset("rot_3");
            int[] dc = { Offset("f_dc_0"), Offset("f_dc_1"), Offset("f_dc_2") };

            int restCount = 0;
            while (props.ContainsKey($"f_rest_{restCount}")) restCount++;
            int coefficients = restCount / 3 + 1;
            if (restCount % 3 != 0 || coefficients is not (1 or 4 or 9 or 16))
                throw new InvalidDataException($"PLY has {restCount} f_rest values; expected 0, 9, 24 or 45");
            var rest = new int[restCount];
            for (int i = 0; i < restCount; i++) rest[i] = props[$"f_rest_{i}"].offset;

            bool allFloat = true;
            foreach (var p in props.Values) allFloat &= p.kind == 'f' && p.size == 4;
            if (!allFloat) throw new InvalidDataException("Only float Gaussian PLY properties are supported");

            int shWords = GaussianFrame.SHWordsPerGaussian(coefficients);
            var frame = new GaussianFrame
            {
                count = count,
                coefficientCount = coefficients,
                attributes = new float[count * GaussianFrame.FloatsPerGaussian],
                sh = new uint[count * shWords],
            };

            if (!BitConverter.IsLittleEndian) throw new PlatformNotSupportedException("PLY decoding expects a little-endian device");
            float F(int row, int offset) => BitConverter.ToSingle(data, bodyStart + row + offset);

            float3 min = new float3(float.MaxValue), max = new float3(float.MinValue);
            var shValues = new float[coefficients * 3];
            int restPerChannel = coefficients - 1;
            for (int i = 0; i < count; i++)
            {
                int row = i * stride;
                int a = i * GaussianFrame.FloatsPerGaussian;
                var pos = new float3(F(row, x), F(row, y), F(row, z));
                min = math.min(min, pos);
                max = math.max(max, pos);

                frame.attributes[a + 0] = pos.x;
                frame.attributes[a + 1] = pos.y;
                frame.attributes[a + 2] = pos.z;
                frame.attributes[a + 3] = 1f / (1f + math.exp(-F(row, op)));
                frame.attributes[a + 4] = math.abs(math.exp(F(row, s0)));
                frame.attributes[a + 5] = math.abs(math.exp(F(row, s1)));
                frame.attributes[a + 6] = math.abs(math.exp(F(row, s2)));
                var q = math.normalizesafe(new float4(F(row, r0), F(row, r1), F(row, r2), F(row, r3)), new float4(1, 0, 0, 0)).yzwx;
                frame.attributes[a + 8] = q.x;
                frame.attributes[a + 9] = q.y;
                frame.attributes[a + 10] = q.z;
                frame.attributes[a + 11] = q.w;

                for (int c = 0; c < 3; c++) shValues[c] = F(row, dc[c]);
                for (int k = 1; k < coefficients; k++)
                    for (int c = 0; c < 3; c++)
                        shValues[k * 3 + c] = F(row, rest[c * restPerChannel + (k - 1)]);
                PackHalves(shValues, frame.sh, i * shWords);
            }

            frame.bounds = count > 0 ? new Bounds((min + max) * 0.5f, max - min) : new Bounds();
            return frame;
        }

        // Component 2n goes in the low 16 bits of word n, matching the renderer's LoadSourceSHComponent.
        static void PackHalves(float[] values, uint[] dst, int start)
        {
            for (int i = 0; i < values.Length; i += 2)
            {
                uint lo = math.f32tof16(values[i]);
                uint hi = i + 1 < values.Length ? math.f32tof16(values[i + 1]) : 0u;
                dst[start + i / 2] = lo | (hi << 16);
            }
        }

        static int ParseHeader(byte[] data, out int bodyStart, out int stride, out Dictionary<string, Property> props)
        {
            const string end = "end_header\n";
            int headerEnd = IndexOf(data, Encoding.ASCII.GetBytes(end), 65536);
            if (headerEnd < 0) throw new InvalidDataException("Not a PLY file (no end_header)");
            bodyStart = headerEnd + end.Length;

            props = new Dictionary<string, Property>();
            int count = -1;
            stride = 0;
            bool inVertex = false;
            foreach (var raw in Encoding.ASCII.GetString(data, 0, headerEnd).Split('\n'))
            {
                var parts = raw.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length == 0) continue;
                switch (parts[0])
                {
                    case "ply":
                    case "comment":
                    case "obj_info":
                        break;
                    case "format":
                        if (parts.Length < 2 || parts[1] != "binary_little_endian")
                            throw new InvalidDataException($"Unsupported PLY format '{raw.Trim()}'");
                        break;
                    case "element":
                        if (count >= 0 && inVertex) throw new InvalidDataException("PLY vertex element must be the only element");
                        inVertex = parts[1] == "vertex";
                        if (!inVertex) throw new InvalidDataException($"Unexpected PLY element '{parts[1]}' before the Gaussians");
                        count = int.Parse(parts[2]);
                        break;
                    case "property":
                        if (parts.Length != 3) throw new InvalidDataException($"Unsupported PLY property '{raw.Trim()}'");
                        var (size, kind) = TypeOf(parts[1]);
                        props[parts[2]] = new Property { name = parts[2], offset = stride, size = size, kind = kind };
                        stride += size;
                        break;
                }
            }
            if (count < 0) throw new InvalidDataException("PLY has no vertex element");
            return count;
        }

        static (int, char) TypeOf(string type) => type switch
        {
            "float" or "float32" => (4, 'f'),
            "double" or "float64" => (8, 'd'),
            "uchar" or "uint8" => (1, 'u'),
            "char" or "int8" => (1, 's'),
            "ushort" or "uint16" => (2, 'u'),
            "short" or "int16" => (2, 's'),
            "uint" or "uint32" => (4, 'u'),
            "int" or "int32" => (4, 's'),
            _ => throw new InvalidDataException($"Unknown PLY type '{type}'"),
        };

        static int IndexOf(byte[] data, byte[] pattern, int limit)
        {
            int last = Math.Min(data.Length, limit) - pattern.Length;
            for (int i = 0; i <= last; i++)
            {
                int j = 0;
                while (j < pattern.Length && data[i + j] == pattern[j]) j++;
                if (j == pattern.Length) return i;
            }
            return -1;
        }
    }
}
