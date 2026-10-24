using UnityEngine;

namespace LucidDreams
{
    // The bench under a seated person (Seating): a plain piano bench, black lacquer with a dark leather cushion on four
    // square legs, real size, its cushion level with their hips. Built under the person in bundle space like the other
    // props (so it shares their mirror and moves with them), standing on your floor wherever their lift puts them.
    public class DreamBench : MonoBehaviour
    {
        const float Cushion = 0.04f, Case = 0.08f, Inset = 0.022f, Leg = 0.048f, LegInset = 0.03f;

        public DreamPlacer placer;
        public DreamSequencePlayer player;
        [Tooltip("The person's transform: the bench is built under it, in bundle space.")]
        public Transform person;
        public Material lacquer, leather;
        public Shader shadowShader;

        public GameObject Root => root;

        DreamBundle builtFor;
        GameObject root;
        Material shade;
        readonly System.Collections.Generic.List<Mesh> meshes = new();

        void Update()
        {
            if (player == null || placer == null) return;
            if (!player.IsReady)
            {
                Clear();
                builtFor = null;
                return;
            }
            if (player.Dream == builtFor) return;
            builtFor = player.Dream;
            Clear();
            var seat = placer.Seat;
            if (seat.seated && seat.needsBench) Build(seat);
        }

        void Clear()
        {
            if (root != null) Destroy(root);
            if (shade != null) Destroy(shade);
            foreach (var m in meshes) Destroy(m);
            meshes.Clear();
            root = null;
        }

        Mesh Rounded(Vector3 size, float radius)
        {
            var m = PropMeshes.RoundedBox(size, radius);
            meshes.Add(m);
            return m;
        }

        void Build(Seating seat)
        {
            root = new GameObject("Bench");
            var t = root.transform;
            t.SetParent(person, false);
            // its own floor is your floor: the person's lift doesn't lift the bench
            t.localPosition = new Vector3(seat.benchAt.x, -seat.lift, seat.benchAt.y);

            float w = Seating.BenchWidth, d = Seating.BenchDepth, top = seat.benchTop;
            float caseTop = top - Cushion;
            Part(t, "Cushion", Rounded(new Vector3(w - 2f * Inset, Cushion + 0.01f, d - 2f * Inset), 0.016f), leather,
                new Vector3(0f, top - (Cushion + 0.01f) / 2f, 0f));
            Part(t, "Case", Rounded(new Vector3(w, Case, d), 0.01f), lacquer, new Vector3(0f, caseTop - Case / 2f, 0f));
            float legH = caseTop - Case;
            var leg = Rounded(new Vector3(Leg, legH, Leg), 0.008f);
            float lx = w / 2f - LegInset - Leg / 2f, lz = d / 2f - LegInset - Leg / 2f;
            foreach (var (x, z) in new[] { (-lx, -lz), (lx, -lz), (-lx, lz), (lx, lz) })
                Part(t, "Leg", leg, lacquer, new Vector3(x, legH / 2f, z));

            var s = GameObject.CreatePrimitive(PrimitiveType.Quad);
            Destroy(s.GetComponent<Collider>());
            s.name = "Bench shadow";
            s.transform.SetParent(t, false);
            s.transform.localPosition = new Vector3(0f, 0.002f, 0f);
            s.transform.localRotation = Quaternion.Euler(90f, 0f, 0f);
            s.transform.localScale = new Vector3(w * 1.35f, d * 1.6f, 1f);
            shade = new Material(shadowShader);
            shade.SetFloat("_Opacity", 0.5f);
            var r = s.GetComponent<MeshRenderer>();
            r.sharedMaterial = shade;
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
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
    }
}
