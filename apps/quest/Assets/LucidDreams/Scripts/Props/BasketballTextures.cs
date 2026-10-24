using System.Collections.Generic;
using UnityEngine;

namespace LucidDreams
{
    // The ball's skin, as apps/webxr/src/props.ts paints it: pebbled orange-brown composite with the classic 8-panel
    // seams (two great circles at right angles, and two curved seams: circles around the points where the first crosses
    // 90 degrees from the second, splitting each of the 4 lunes in two), plus a normal map: pebbles up, seams sunk in.
    // The pixel maths is pure and runs on a worker thread; Upload makes the textures on the main thread.
    public static class BasketballTextures
    {
        public const int W = 1024, H = 512;

        public struct Pixels
        {
            public Color32[] colour, normal;
        }

        // Row r of the textures is v = (r + 0.5) / H, matching Sphere(): v = 1 - theta / pi.
        static Vector3 Direction(int x, int r)
        {
            float th = Mathf.PI * (1f - (r + 0.5f) / H);
            float ph = 2f * Mathf.PI * (x + 0.5f) / W;
            float st = Mathf.Sin(th);
            return new Vector3(-Mathf.Cos(ph) * st, Mathf.Cos(th), Mathf.Sin(ph) * st);
        }

        public static Pixels Make(float radius)
        {
            float curve = Mathf.Acos(0.5f); // the curved seams' angular radius: 60 degrees gives all 8 panels the same area
            float half = 0.0032f / radius; // half the seam channel (6.4 mm wide), in radians on the ball
            float pebbles = radius / 0.0026f; // about one pebble every 2.6 mm
            var colour = new Color32[W * H];
            var height = new float[W * H];
            for (int r = 0; r < H; r++)
            for (int x = 0; x < W; x++)
            {
                var p = Direction(x, r);
                float ax = Mathf.Min(1f, Mathf.Abs(p.x));
                float d = Mathf.Min(Mathf.Asin(Mathf.Min(1f, Mathf.Abs(p.y))), Mathf.Min(Mathf.Asin(ax), Mathf.Abs(Mathf.Acos(ax) - curve)));
                float seam = 1f - Smooth(half * 0.75f, half * 1.2f, d);
                float groove = 1f - Smooth(half * 0.9f, half * 2.1f, d); // the panel edge rolls down into the channel
                float pebble = Smooth(0.3f, 0.75f, ValueNoise(p.x * pebbles, p.y * pebbles, p.z * pebbles));
                float shade = 0.9f + 0.1f * pebble - 0.12f * groove;
                colour[r * W + x] = new Color32(
                    (byte)(196 * shade * (1 - seam) + 24 * seam),
                    (byte)(88 * shade * (1 - seam) + 19 * seam),
                    (byte)(38 * shade * (1 - seam) + 16 * seam), 255);
                height[r * W + x] = (0.62f + 0.38f * pebble) * (1 - groove) + 0.1f * groove;
            }

            // Height to a tangent-space normal map (RGB, alpha 1: reads right packed or unpacked).
            const float strength = 2.2f;
            var normal = new Color32[W * H];
            for (int r = 0; r < H; r++)
            for (int x = 0; x < W; x++)
            {
                float dx = height[r * W + (x + 1) % W] - height[r * W + (x + W - 1) % W];
                float dy = height[Mathf.Min(r + 1, H - 1) * W + x] - height[Mathf.Max(r - 1, 0) * W + x];
                var n = new Vector3(-dx * strength, -dy * strength, 1f).normalized;
                normal[r * W + x] = new Color32((byte)((n.x * 0.5f + 0.5f) * 255), (byte)((n.y * 0.5f + 0.5f) * 255), (byte)((n.z * 0.5f + 0.5f) * 255), 255);
            }
            return new Pixels { colour = colour, normal = normal };
        }

        public static (Texture2D colour, Texture2D normal) Upload(Pixels p)
        {
            var colour = new Texture2D(W, H, TextureFormat.RGBA32, true, false) { name = "Basketball skin", anisoLevel = 8, wrapModeU = TextureWrapMode.Repeat, wrapModeV = TextureWrapMode.Clamp };
            colour.SetPixels32(p.colour);
            colour.Apply(true, true);
            var normal = new Texture2D(W, H, TextureFormat.RGBA32, true, true) { name = "Basketball pebbles", anisoLevel = 8, wrapModeU = TextureWrapMode.Repeat, wrapModeV = TextureWrapMode.Clamp };
            normal.SetPixels32(p.normal);
            normal.Apply(true, true);
            return (colour, normal);
        }

        // A UV sphere laid out like three.js SphereGeometry (64 x 40), so the skin lands as it does in the WebXR viewer.
        public static Mesh Sphere(float radius, int across = 64, int down = 40)
        {
            var verts = new List<Vector3>();
            var normals = new List<Vector3>();
            var uvs = new List<Vector2>();
            var tris = new List<int>();
            for (int y = 0; y <= down; y++)
            {
                float v = (float)y / down, th = v * Mathf.PI;
                for (int x = 0; x <= across; x++)
                {
                    float u = (float)x / across, ph = u * 2f * Mathf.PI;
                    var n = new Vector3(-Mathf.Cos(ph) * Mathf.Sin(th), Mathf.Cos(th), Mathf.Sin(ph) * Mathf.Sin(th));
                    verts.Add(n * radius);
                    normals.Add(n);
                    uvs.Add(new Vector2(u, 1f - v));
                }
            }
            for (int y = 0; y < down; y++)
                for (int x = 0; x < across; x++)
                {
                    int a = y * (across + 1) + x, b = a + across + 1;
                    tris.AddRange(new[] { a, a + 1, b, b, a + 1, b + 1 });
                }
            var mesh = new Mesh { name = "Basketball" };
            mesh.SetVertices(verts);
            mesh.SetNormals(normals);
            mesh.SetUVs(0, uvs);
            mesh.SetTriangles(tris, 0);
            mesh.RecalculateTangents();
            mesh.RecalculateBounds();
            return mesh;
        }

        static float Smooth(float e0, float e1, float x)
        {
            float k = Mathf.Clamp01((x - e0) / (e1 - e0));
            return k * k * (3f - 2f * k);
        }

        static float Hash3(int x, int y, int z)
        {
            unchecked
            {
                int h = x * 374761393 + y * 668265263 + z * 1274126177;
                h = (h ^ (int)((uint)h >> 13)) * 1274126177;
                return (uint)(h ^ (int)((uint)h >> 16)) / 4294967295f;
            }
        }

        // 3D value noise in 0..1 (sampled on the sphere itself, so pebbles don't stretch toward the map's poles).
        static float ValueNoise(float x, float y, float z)
        {
            int xi = Mathf.FloorToInt(x), yi = Mathf.FloorToInt(y), zi = Mathf.FloorToInt(z);
            float F(float v) => v * v * (3f - 2f * v);
            float u = F(x - xi), v = F(y - yi), w = F(z - zi);
            float L(float a, float b, float k) => a + (b - a) * k;
            float C(int dx, int dy, int dz) => Hash3(xi + dx, yi + dy, zi + dz);
            return L(L(L(C(0, 0, 0), C(1, 0, 0), u), L(C(0, 1, 0), C(1, 1, 0), u), v),
                     L(L(C(0, 0, 1), C(1, 0, 1), u), L(C(0, 1, 1), C(1, 1, 1), u), v), w);
        }
    }
}
