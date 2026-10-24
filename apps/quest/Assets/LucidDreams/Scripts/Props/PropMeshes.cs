using System.Collections.Generic;
using UnityEngine;

namespace LucidDreams
{
    // Procedural meshes for props, real size, built once: a ring (torus), thin cords (open cylinders) merged into one
    // mesh, and a flat border (a rectangle with a rectangular hole).
    public static class PropMeshes
    {
        // A torus in the XZ plane around the origin.
        public static Mesh Torus(float radius, float tube, int radial = 96, int tubular = 12)
        {
            var verts = new List<Vector3>();
            var normals = new List<Vector3>();
            var tris = new List<int>();
            for (int i = 0; i <= radial; i++)
            {
                float a = 2f * Mathf.PI * i / radial;
                var centre = new Vector3(Mathf.Cos(a), 0f, Mathf.Sin(a)) * radius;
                var outward = centre.normalized;
                for (int j = 0; j <= tubular; j++)
                {
                    float b = 2f * Mathf.PI * j / tubular;
                    var n = outward * Mathf.Cos(b) + Vector3.up * Mathf.Sin(b);
                    verts.Add(centre + n * tube);
                    normals.Add(n);
                }
            }
            for (int i = 0; i < radial; i++)
                for (int j = 0; j < tubular; j++)
                {
                    int a = i * (tubular + 1) + j, b = (i + 1) * (tubular + 1) + j;
                    tris.AddRange(new[] { a, a + 1, b, b, a + 1, b + 1 });
                }
            return Build("Ring", verts, normals, tris);
        }

        // Thin open cylinders between point pairs, one mesh.
        public static Mesh Cords(IList<(Vector3 a, Vector3 b)> cords, float radius, int sides = 5)
        {
            var verts = new List<Vector3>();
            var normals = new List<Vector3>();
            var tris = new List<int>();
            foreach (var (a, b) in cords)
            {
                var axis = (b - a).normalized;
                var u = Vector3.Cross(axis, Mathf.Abs(axis.y) < 0.9f ? Vector3.up : Vector3.right).normalized;
                var v = Vector3.Cross(axis, u);
                int start = verts.Count;
                for (int s = 0; s <= sides; s++)
                {
                    float t = 2f * Mathf.PI * s / sides;
                    var n = u * Mathf.Cos(t) + v * Mathf.Sin(t);
                    verts.Add(a + n * radius);
                    verts.Add(b + n * radius);
                    normals.Add(n);
                    normals.Add(n);
                }
                for (int s = 0; s < sides; s++)
                {
                    int i = start + s * 2;
                    tris.AddRange(new[] { i, i + 1, i + 2, i + 2, i + 1, i + 3 });
                }
            }
            return Build("Cords", verts, normals, tris);
        }

        // A flat border in the XY plane, facing -Z... and +Z (double-sided material): outer w x h, lines `line` wide.
        public static Mesh Border(float w, float h, float line)
        {
            float x0 = w / 2f, y0 = h / 2f, x1 = x0 - line, y1 = y0 - line;
            var outer = new[] { new Vector3(-x0, -y0), new Vector3(x0, -y0), new Vector3(x0, y0), new Vector3(-x0, y0) };
            var inner = new[] { new Vector3(-x1, -y1), new Vector3(x1, -y1), new Vector3(x1, y1), new Vector3(-x1, y1) };
            var verts = new List<Vector3>();
            verts.AddRange(outer);
            verts.AddRange(inner);
            var normals = new List<Vector3>();
            for (int i = 0; i < 8; i++) normals.Add(Vector3.forward * -1f);
            var tris = new List<int>();
            for (int i = 0; i < 4; i++)
            {
                int o0 = i, o1 = (i + 1) % 4, i0 = 4 + i, i1 = 4 + (i + 1) % 4;
                tris.AddRange(new[] { o0, i0, o1, o1, i0, i1 });
            }
            return Build("Border", verts, normals, tris);
        }

        // A box of the given size around the origin with every edge and corner rounded to `radius`: each face is a grid,
        // denser near its edges, pushed out from the box shrunk by the radius.
        public static Mesh RoundedBox(Vector3 size, float radius, int steps = 6)
        {
            var half = size / 2f;
            radius = Mathf.Min(radius, Mathf.Min(half.x, Mathf.Min(half.y, half.z)));
            var inner = half - Vector3.one * radius;
            float[] Samples(float h)
            {
                var v = new List<float>();
                for (int i = 0; i <= steps; i++) v.Add(-h + radius * i / steps);
                for (int i = 0; i <= steps; i++) v.Add(h - radius + radius * i / steps);
                return v.ToArray();
            }
            var verts = new List<Vector3>();
            var normals = new List<Vector3>();
            var tris = new List<int>();
            for (int axis = 0; axis < 3; axis++)
                for (int sign = -1; sign <= 1; sign += 2)
                {
                    int ua = (axis + 1) % 3, va = (axis + 2) % 3;
                    var us = Samples(half[ua]);
                    var vs = Samples(half[va]);
                    int start = verts.Count;
                    foreach (float v in vs)
                        foreach (float u in us)
                        {
                            var p = Vector3.zero;
                            p[axis] = sign * half[axis];
                            p[ua] = u;
                            p[va] = v;
                            var core = new Vector3(Mathf.Clamp(p.x, -inner.x, inner.x), Mathf.Clamp(p.y, -inner.y, inner.y), Mathf.Clamp(p.z, -inner.z, inner.z));
                            var n = (p - core).normalized;
                            verts.Add(core + n * radius);
                            normals.Add(n);
                        }
                    int w = us.Length;
                    for (int j = 0; j < vs.Length - 1; j++)
                        for (int i = 0; i < w - 1; i++)
                        {
                            int a = start + j * w + i, b = a + w;
                            // u x v points out of the + face; Unity's front faces have normal (p1 - p0) x (p2 - p0)
                            if (sign > 0) tris.AddRange(new[] { a, a + 1, b, b, a + 1, b + 1 });
                            else tris.AddRange(new[] { a, b, a + 1, a + 1, b, b + 1 });
                        }
                }
            return Build("Rounded box", verts, normals, tris);
        }

        static Mesh Build(string name, List<Vector3> verts, List<Vector3> normals, List<int> tris)
        {
            var mesh = new Mesh { name = name, indexFormat = verts.Count > 65000 ? UnityEngine.Rendering.IndexFormat.UInt32 : UnityEngine.Rendering.IndexFormat.UInt16 };
            mesh.SetVertices(verts);
            mesh.SetNormals(normals);
            mesh.SetTriangles(tris, 0);
            mesh.RecalculateBounds();
            return mesh;
        }
    }
}
