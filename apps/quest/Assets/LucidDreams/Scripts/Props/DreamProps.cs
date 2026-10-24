using System;
using System.Collections;
using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.Networking;

namespace LucidDreams
{
    // The important objects around the person (AGENTS.md, "Props"), as apps/webxr/src/props.ts builds them: the real
    // ball moving exactly as in the clip, a regulation hoop. Same space as the person (built under it, so they share its
    // handedness mirror and move with every placement); everything is built from code, real size.
    public class DreamProps : MonoBehaviour
    {
        // Regulation (FIBA / NBA): ring 0.457 m inside, its inner edge 0.151 m from the board; board 1.83 x 1.07 m, its
        // bottom edge 0.15 m under the ring; the shooter's square 0.59 x 0.45 m, its base line level with the ring.
        const float RimR = 0.457f / 2f, RimTube = 0.008f, BoardGap = 0.151f, BoardW = 1.83f, BoardH = 1.07f, BoardT = 0.025f;
        const float BoardBelowRim = 0.15f, SquareW = 0.59f, SquareH = 0.45f, Line = 0.05f, NetLen = 0.4f;
        const float FadeS = 0.18f; // the ball fades in and out over this long instead of popping
        const float Backspin = 0.35f; // spin as a fraction of rolling speed, turned backwards the way a shot leaves the fingers

        public DreamSequencePlayer player;
        [Tooltip("The person's transform: props are built under it, in bundle space.")]
        public Transform person;
        public Material ball, ballFading, rimOrange, steel, standBase, paint, glass, glassEdge, cord;
        public Shader shadowShader;

        public GameObject Root => root;
        public Vector3 BallPosition => balls.Count > 0 ? balls[0].pos : Vector3.zero; // bundle space
        public float BallAlpha => balls.Count > 0 ? balls[0].alpha : 0f;
        public bool BallVisible => balls.Count > 0 && balls[0].renderer.enabled;
        public int HoopCount { get; private set; }

        DreamBundle loadedFor;
        GameObject root;
        Material ballSolid, ballFade; // per-run copies with the generated skin, so the assets never change
        readonly List<Ball> balls = new();
        static Texture2D ballSkin, ballBumps;

        void Update()
        {
            if (player == null) return;
            if (player.IsReady && player.Dream != loadedFor)
            {
                loadedFor = player.Dream;
                Clear();
                if (!string.IsNullOrEmpty(loadedFor.props)) StartCoroutine(Load(loadedFor));
            }
            if (!player.IsReady) return;
            foreach (var b in balls) b.Update(player.ClipTime, Time.deltaTime);
        }

        void Clear()
        {
            StopAllCoroutines();
            balls.Clear();
            HoopCount = 0;
            if (root != null) Destroy(root);
        }

        IEnumerator Load(DreamBundle dream)
        {
            using var request = UnityWebRequest.Get($"{player.BaseUrl}/{dream.props}");
            yield return request.SendWebRequest();
            if (request.result != UnityWebRequest.Result.Success || loadedFor != dream) yield break;

            Dictionary<string, object> file;
            try { file = MiniJson.Obj(MiniJson.Parse(request.downloadHandler.text), "props.json"); }
            catch (Exception e) { Debug.LogWarning($"[Lucid Dreams] props.json unreadable: {e.Message}"); yield break; }
            float fps = file.TryGetValue("fps", out var f) && f is double d && d > 0 ? (float)d : dream.fps;
            var objects = file.TryGetValue("objects", out var o) ? o as List<object> : null;
            if (objects == null) yield break;

            if (ballSkin == null)
            {
                var skin = Task.Run(() => BasketballTextures.Make(0.12f));
                while (!skin.IsCompleted) yield return null;
                (ballSkin, ballBumps) = BasketballTextures.Upload(skin.Result);
            }
            if (ballSolid == null)
            {
                ballSolid = new Material(ball);
                ballFade = new Material(ballFading);
                foreach (var m in new[] { ballSolid, ballFade })
                {
                    m.SetTexture("_BaseMap", ballSkin);
                    m.SetTexture("_BumpMap", ballBumps);
                }
            }
            if (loadedFor != dream) yield break;

            root = new GameObject("Props");
            root.transform.SetParent(person, false); // bundle space, mirrored with the person
            foreach (var item in objects)
            {
                if (item is not Dictionary<string, object> obj || !obj.TryGetValue("kind", out var kind)) continue; // unknown: ignored
                if ((kind as string) == "basketball" && obj.TryGetValue("track", out var track) && track is List<object> points)
                {
                    float radius = obj.TryGetValue("radius", out var r) && r is double rr && rr > 0 ? (float)rr : 0.12f;
                    balls.Add(new Ball(this, points, radius, fps));
                }
                else if ((kind as string) == "hoop" && Vec(obj.TryGetValue("rim", out var rim) ? rim : null, out var rimAt))
                {
                    Vec(obj.TryGetValue("facing", out var facing) ? facing : null, out var toward);
                    BuildHoop(rimAt, toward);
                    HoopCount++;
                }
            }
            Debug.Log($"[Lucid Dreams] Props: {balls.Count} ball(s), {HoopCount} hoop(s).");
        }

        static bool Vec(object o, out Vector3 v)
        {
            v = Vector3.zero;
            if (o is not List<object> a || a.Count < 3 || a[0] is not double x || a[1] is not double y || a[2] is not double z) return false;
            if (double.IsNaN(x) || double.IsNaN(y) || double.IsNaN(z)) return false;
            v = new Vector3((float)x, (float)y, (float)z);
            return true;
        }

        // ---------------- the ball ----------------

        class Ball
        {
            public readonly Renderer renderer;
            public Vector3 pos;
            public float alpha;
            readonly DreamProps owner;
            readonly Transform transform, shadow;
            readonly Material shadowMaterial;
            readonly Vector3?[] pts;
            readonly float r, fps;
            bool known;
            float prevT = float.NaN, lastT;
            Vector3 vel, last, lastVel;

            public Ball(DreamProps owner, List<object> track, float radius, float fps)
            {
                this.owner = owner;
                r = radius;
                this.fps = fps;
                pts = new Vector3?[track.Count];
                for (int i = 0; i < track.Count; i++) pts[i] = Vec(track[i], out var p) ? p : (Vector3?)null;

                var go = new GameObject("Basketball", typeof(MeshFilter), typeof(MeshRenderer));
                go.transform.SetParent(owner.root.transform, false);
                go.GetComponent<MeshFilter>().sharedMesh = BasketballTextures.Sphere(r);
                renderer = go.GetComponent<MeshRenderer>();
                renderer.sharedMaterial = owner.ballSolid;
                renderer.enabled = false;
                transform = go.transform;
                transform.localRotation = Quaternion.Euler(0.35f * Mathf.Rad2Deg, 0.6f * Mathf.Rad2Deg, 0.2f * Mathf.Rad2Deg); // seams at a natural angle

                var s = GameObject.CreatePrimitive(PrimitiveType.Quad);
                UnityEngine.Object.Destroy(s.GetComponent<Collider>());
                s.name = "Ball shadow";
                s.transform.SetParent(owner.root.transform, false);
                s.transform.localRotation = Quaternion.Euler(90f, 0f, 0f);
                shadowMaterial = new Material(owner.shadowShader);
                s.GetComponent<MeshRenderer>().sharedMaterial = shadowMaterial;
                shadow = s.transform;
            }

            // Where the ball is at clip time t, smoothly between frames (centripetal Catmull-Rom). False where it isn't known.
            bool Sample(float t, out Vector3 o)
            {
                o = default;
                int n = pts.Length;
                float f = t * fps;
                if (!(f >= 0f) || f > n) return false;
                int i = Mathf.Min(Mathf.FloorToInt(f), n - 1);
                float u = i == n - 1 ? 0f : f - i;
                if (pts[i] is not Vector3 p1) return false;
                if (u == 0f) { o = p1; return true; }
                if (pts[i + 1] is not Vector3 p2) return false;
                // past either end of a known stretch, mirror the neighbour so the curve carries straight on
                var p0 = i > 0 && pts[i - 1] is Vector3 a ? a : 2f * p1 - p2;
                var p3 = i + 2 < n && pts[i + 2] is Vector3 b ? b : 2f * p2 - p1;
                o = CatmullRom(p0, p1, p2, p3, u);
                // a bounce between two frames: the smooth curve would turn round in mid-air above the floor. Follow the
                // way in and the way out as straight lines instead; they meet at (or under, clamped to) the floor.
                if (i > 0 && pts[i - 1] is Vector3 before && i + 2 < n && pts[i + 2] is Vector3 after)
                {
                    float down = p1.y - before.y, up = after.y - p2.y;
                    if (down < 0f && up > 0f && Mathf.Min(p1.y, p2.y) < r + 0.3f) o.y = Mathf.Max(p1.y + down * u, p2.y - up * (1f - u));
                }
                return true;
            }

            public void Update(float t, float dt)
            {
                float h = 0.5f / fps;
                bool wasKnown = known;
                known = Sample(t, out var at);
                if (known)
                {
                    pos = at;
                    // a jump (the clip looping, a scrub) fades in at the new place rather than flying across the room
                    if (wasKnown && Vector3.Distance(pos, last) > 0.8f) alpha = 0f;
                    bool ahead = Sample(t + h, out var a), behind = Sample(t - h, out var b);
                    vel = ahead && behind ? (a - b) / (2f * h) : ahead ? (a - pos) / h : behind ? (pos - b) / h : Vector3.zero;
                    last = pos;
                    lastVel = vel;
                    lastT = t;
                }
                else
                {
                    // lost: it keeps going the way it was going while it fades out
                    pos = last + lastVel * Mathf.Clamp(t - lastT, 0f, 0.3f);
                    vel = lastVel;
                }
                pos.y = Mathf.Max(pos.y, r); // never through the floor
                alpha = Mathf.Clamp01(alpha + (known ? dt : -dt) / FadeS);

                // backspin about (velocity x up), in proportion to its speed; follows clip time, so it slows with playback
                float dtc = t - prevT;
                prevT = t;
                if (!float.IsNaN(dtc) && Mathf.Abs(dtc) < 0.25f && dtc != 0f)
                {
                    var axis = new Vector3(-vel.z, 0f, vel.x);
                    float speed = axis.magnitude;
                    if (speed > 1e-4f)
                        transform.localRotation = Quaternion.AngleAxis(speed * Backspin / r * dtc * Mathf.Rad2Deg, axis / speed) * transform.localRotation;
                }

                transform.localPosition = pos;
                renderer.enabled = alpha > 0.002f;
                // opaque when whole, transparent only while fading, so it always sorts right against the person
                renderer.sharedMaterial = alpha >= 1f ? owner.ballSolid : owner.ballFade;
                if (alpha < 1f) owner.ballFade.SetColor("_BaseColor", new Color(1f, 1f, 1f, alpha));
                // a soft contact shadow, wider and fainter the higher it is
                float above = pos.y - r;
                float opacity = alpha * 0.75f * Mathf.Max(0f, 1f - above / 2.5f);
                shadowMaterial.SetFloat("_Opacity", opacity);
                shadow.gameObject.SetActive(opacity > 0.002f);
                shadow.localPosition = new Vector3(pos.x, 0.003f, pos.z);
                shadow.localScale = Vector3.one * (r * 3.2f * (1f + above * 0.5f));
            }

            // Centripetal Catmull-Rom between p1 and p2: no overshoot or loops when samples bunch up at a bounce.
            static Vector3 CatmullRom(Vector3 p0, Vector3 p1, Vector3 p2, Vector3 p3, float u)
            {
                float d0 = Mathf.Pow((p1 - p0).sqrMagnitude, 0.25f), d1 = Mathf.Pow((p2 - p1).sqrMagnitude, 0.25f), d2 = Mathf.Pow((p3 - p2).sqrMagnitude, 0.25f);
                if (d1 < 1e-4f) d1 = 1f;
                if (d0 < 1e-4f) d0 = d1;
                if (d2 < 1e-4f) d2 = d1;
                float u2 = u * u, u3 = u2 * u;
                var o = Vector3.zero;
                for (int c = 0; c < 3; c++)
                {
                    float x0 = p0[c], x1 = p1[c], x2 = p2[c], x3 = p3[c];
                    float t1 = ((x1 - x0) / d0 - (x2 - x0) / (d0 + d1) + (x2 - x1) / d1) * d1;
                    float t2 = ((x2 - x1) / d1 - (x3 - x1) / (d1 + d2) + (x3 - x2) / d2) * d1;
                    o[c] = x1 + t1 * u + (-3f * x1 + 3f * x2 - 2f * t1 - t2) * u2 + (2f * x1 - 2f * x2 + t1 + t2) * u3;
                }
                return o;
            }
        }

        // ---------------- the hoop ----------------

        // Local frame: origin on the floor under the ring's centre, +Z toward the shooter. The ring, a diamond-mesh net,
        // the glass board with its white border and shooter's square, and a dark pole on a base behind it.
        void BuildHoop(Vector3 rim, Vector3 facing)
        {
            var g = new GameObject("Hoop").transform;
            g.SetParent(root.transform, false);
            float top = rim.y, ringY = top - RimTube;
            float face = -(RimR + BoardGap), back = face - BoardT;
            g.localPosition = new Vector3(rim.x, 0f, rim.z);
            var f = new Vector3(facing.x, 0f, facing.z);
            if (f.sqrMagnitude < 1e-8f) f = Vector3.forward;
            g.localRotation = Quaternion.LookRotation(f.normalized, Vector3.up); // local +Z toward the shooter

            Part(g, "Ring", PropMeshes.Torus(RimR + RimTube, RimTube), rimOrange, new Vector3(0f, ringY, 0f));
            float reach = BoardGap - RimTube;
            Box(g, "Bracket", rimOrange, new Vector3(0.1f, 0.018f, reach), new Vector3(0f, ringY, -(RimR + RimTube) - reach / 2f));
            Box(g, "Bracket web", rimOrange, new Vector3(0.02f, 0.07f, 0.09f), new Vector3(0f, ringY - 0.04f, face + 0.045f));
            Box(g, "Mounting plate", rimOrange, new Vector3(0.18f, 0.12f, 0.012f), new Vector3(0f, ringY - 0.03f, face + 0.006f));

            // the net: a tapered tube of thin cords knotted into diamonds, 12 loops on the ring
            const int loops = 12, rows = 6;
            float r0 = RimR + RimTube * 0.5f, r1 = 0.135f;
            Vector3 At(int j, int k)
            {
                float s = (float)j / rows;
                float rad = r0 + (r1 - r0) * (1f - Mathf.Pow(1f - s, 1.8f)); // narrows quickly under the ring, then hangs straight
                float a = 2f * Mathf.PI * (k + (j % 2) * 0.5f) / loops;
                return new Vector3(Mathf.Cos(a) * rad, ringY - RimTube - s * NetLen, Mathf.Sin(a) * rad);
            }
            var cords = new List<(Vector3, Vector3)>();
            for (int j = 0; j < rows; j++)
                for (int k = 0; k < loops; k++)
                {
                    int side = j % 2 == 1 ? k + 1 : k - 1;
                    cords.Add((At(j, k), At(j + 1, k)));
                    cords.Add((At(j, k), At(j + 1, (side + loops) % loops)));
                }
            Part(g, "Net", PropMeshes.Cords(cords, 0.0028f), cord, Vector3.zero);

            // the glass: faces see-through, edges a touch green like real tempered glass
            float boardY = top - BoardBelowRim + BoardH / 2f;
            Box(g, "Glass", glass, new Vector3(BoardW, BoardH, BoardT), new Vector3(0f, boardY, face - BoardT / 2f));
            foreach (var (size, at) in new[]
                     {
                         (new Vector3(BoardW, 0.006f, BoardT + 0.002f), new Vector3(0f, boardY + BoardH / 2f, face - BoardT / 2f)),
                         (new Vector3(BoardW, 0.006f, BoardT + 0.002f), new Vector3(0f, boardY - BoardH / 2f, face - BoardT / 2f)),
                         (new Vector3(0.006f, BoardH, BoardT + 0.002f), new Vector3(BoardW / 2f, boardY, face - BoardT / 2f)),
                         (new Vector3(0.006f, BoardH, BoardT + 0.002f), new Vector3(-BoardW / 2f, boardY, face - BoardT / 2f)),
                     })
                Box(g, "Glass edge", glassEdge, size, at);
            Part(g, "Border", PropMeshes.Border(BoardW, BoardH, Line), paint, new Vector3(0f, boardY, face + 0.0015f));
            Part(g, "Shooter's square", PropMeshes.Border(SquareW, SquareH, Line), paint, new Vector3(0f, top - Line + SquareH / 2f, face + 0.0015f));

            // behind the glass: the support frame, two parallel arms back to the pole, the pole, its base
            float frameY = boardY - 0.08f;
            Box(g, "Frame", steel, new Vector3(0.9f, 0.05f, 0.05f), new Vector3(0f, frameY - 0.28f, back - 0.03f));
            Box(g, "Frame", steel, new Vector3(0.9f, 0.05f, 0.05f), new Vector3(0f, frameY + 0.28f, back - 0.03f));
            Box(g, "Frame", steel, new Vector3(0.05f, 0.61f, 0.05f), new Vector3(-0.42f, frameY, back - 0.03f));
            Box(g, "Frame", steel, new Vector3(0.05f, 0.61f, 0.05f), new Vector3(0.42f, frameY, back - 0.03f));
            float poleZ = back - 1.0f, armLen = back - 0.055f - poleZ;
            foreach (float y in new[] { frameY - 0.2f, frameY + 0.2f })
                Box(g, "Arm", steel, new Vector3(0.06f, 0.06f, armLen), new Vector3(0f, y, poleZ + armLen / 2f));
            float poleTop = frameY + 0.32f;
            Box(g, "Pole", steel, new Vector3(0.14f, poleTop, 0.14f), new Vector3(0f, poleTop / 2f, poleZ));
            Box(g, "Base", standBase, new Vector3(0.7f, 0.14f, 1.0f), new Vector3(0f, 0.07f, poleZ - 0.12f));

            var s = GameObject.CreatePrimitive(PrimitiveType.Quad);
            Destroy(s.GetComponent<Collider>());
            s.name = "Base shadow";
            s.transform.SetParent(g, false);
            s.transform.localPosition = new Vector3(0f, 0.002f, poleZ - 0.12f);
            s.transform.localRotation = Quaternion.Euler(90f, 0f, 0f);
            s.transform.localScale = new Vector3(1.3f, 1.6f, 1f);
            var shade = new Material(shadowShader);
            shade.SetFloat("_Opacity", 0.55f);
            s.GetComponent<MeshRenderer>().sharedMaterial = shade;
        }

        static void Part(Transform parent, string name, Mesh mesh, Material material, Vector3 at)
        {
            var go = new GameObject(name, typeof(MeshFilter), typeof(MeshRenderer));
            go.transform.SetParent(parent, false);
            go.transform.localPosition = at;
            go.GetComponent<MeshFilter>().sharedMesh = mesh;
            var r = go.GetComponent<MeshRenderer>();
            r.sharedMaterial = material;
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
        }

        static void Box(Transform parent, string name, Material material, Vector3 size, Vector3 at)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            Destroy(go.GetComponent<Collider>());
            go.name = name;
            go.transform.SetParent(parent, false);
            go.transform.localPosition = at;
            go.transform.localScale = size;
            var r = go.GetComponent<MeshRenderer>();
            r.sharedMaterial = material;
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
        }
    }
}
