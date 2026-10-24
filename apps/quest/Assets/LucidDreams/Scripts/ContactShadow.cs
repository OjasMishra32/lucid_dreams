using UnityEngine;

namespace LucidDreams
{
    // A soft contact shadow on the floor under the feet: the single biggest cue that a person stands on the floor
    // rather than floating. Sized from the bundle's footprint, it sits a hair above the floor under the dream root.
    public class ContactShadow : MonoBehaviour
    {
        public Shader shader;
        public DreamSequencePlayer player;
        [Range(0, 1)] public float opacity = 0.45f;

        Transform quad;
        Material material;

        void Start()
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Quad);
            go.name = "Contact shadow";
            Destroy(go.GetComponent<Collider>());
            quad = go.transform;
            quad.SetParent(transform, false);
            quad.localPosition = new Vector3(0f, 0.002f, 0f);
            quad.localRotation = Quaternion.Euler(90f, 0f, 0f);
            material = new Material(shader) { name = "Contact shadow" };
            var r = go.GetComponent<MeshRenderer>();
            r.sharedMaterial = material;
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            Resize(0.75f, 0.6f);
        }

        void Update()
        {
            material.SetFloat("_Opacity", opacity);
            quad.gameObject.SetActive(player == null || player.IsReady);
            var b = player != null && player.IsReady ? player.Dream.bounds : null;
            if (b?.min != null && b.min.Length == 3)
                Resize(Mathf.Clamp((b.Max.x - b.Min.x) * 1.3f, 0.5f, 1.4f), Mathf.Clamp((b.Max.z - b.Min.z) * 1.3f, 0.4f, 1.2f));
        }

        void Resize(float width, float depth) => quad.localScale = new Vector3(width, depth, 1f);
    }
}
