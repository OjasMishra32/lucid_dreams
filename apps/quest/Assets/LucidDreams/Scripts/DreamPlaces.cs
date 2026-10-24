using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using UnityEngine;
using UnityEngine.XR.ARFoundation;

namespace LucidDreams
{
    // Places, as in apps/webxr/src/places.ts: one tap swaps your room (passthrough) for a full 360-degree environment
    // around the person: a concert hall around a pianist, a court around a shooter, a ring around a fighter. Each is a
    // CC0 Poly Haven panorama (apps/webxr/public/places/CREDITS.md) on a sphere whose bottom is flattened into a real
    // floor at your floor, so the person stands on the place's floor (their shadow lands on it) and it stays put as you
    // walk around. "Your room" is no place at all: passthrough shows through. Changes crossfade over 0.6 s; once a place
    // is fully in, passthrough is switched off (nobody sees it), and back on before the place fades away.
    public class DreamPlaces : MonoBehaviour
    {
        public const string Room = "room";
        const float FadeS = 0.6f;
        const float Radius = 30f; // meters: anyone walking around stays well inside
        const float DefaultCameraHeight = 1.6f; // the panoramas were shot from 1.6 m up

        public class Place
        {
            public string id, name;
            public float ahead; // the panorama column (0 = left edge, 1 = right edge) turned straight ahead of you, behind the person
            public float cameraHeight = DefaultCameraHeight;
        }

        public static readonly Place[] All =
        {
            new() { id = "concert-hall", name = "Concert hall", ahead = 0.5f }, // the organ and the grand piano
            new() { id = "court", name = "Court", ahead = 0.36f }, // down the court at sunset
            new() { id = "gym", name = "Gym", ahead = 0.62f },
            new() { id = "ring", name = "Boxing ring", ahead = 0.49f }, // the red corner
            new() { id = "studio", name = "Studio", ahead = 0.09f }, // the white cove, the lights behind you
            new() { id = "mountains", name = "Mountains", ahead = 0.78f },
        };

        public Transform head;
        public DreamPlacer placer;
        public DreamSequencePlayer player;
        public ARCameraManager passthrough;
        public HandOccluder handOccluder;
        public Shader shader;

        public Place Current { get; private set; }
        public bool Visible => layers.Count > 0;
        public bool PassthroughOn => passthrough == null || passthrough.enabled;
        public float Opacity => layers.Count > 0 ? layers[^1].k : 0f;
        public string Name => Current?.name ?? "Your room";

        class Layer
        {
            public Place place;
            public GameObject go;
            public Material material;
            public float k; // 0 -> 1 fade progress
            public bool leaving;
        }

        readonly List<Layer> layers = new();
        Transform anchor;
        DreamBundle startedFor;
        Vector3 placedForward = Vector3.forward;
        int request;
        static Mesh sphere;

        void Start()
        {
            anchor = new GameObject("Place anchor").transform;
            anchor.SetParent(transform, false);
            if (placer != null) placer.PlacedForViewer += f => placedForward = f;
        }

        // Where a dream starts: experience.json's "environment" wins ("room" included); otherwise the intent picks one;
        // otherwise your room.
        public static Place Starting(string environment, string intent)
        {
            if (environment == Room) return null;
            return ById(environment) ?? ForIntent(intent);
        }

        public static Place ById(string id) => All.FirstOrDefault(p => p.id == id);

        // piano or music -> the concert hall, a fight -> the ring, basketball -> the court, a workout -> the gym
        public static Place ForIntent(string intent)
        {
            string said = intent?.ToLowerInvariant() ?? "";
            if (said.Length == 0) return null;
            if (Regex.IsMatch(said, @"\b(piano|pianist|keyboard|music|musician|concert|recital|orchestra|instrument|guitar|violin|cello|ukulele|drums?|sing|singing|song)\b")) return ById("concert-hall");
            if (Regex.IsMatch(said, @"\b(box|boxing|boxer|fight|fighter|fighting|punch\w*|jab|uppercut|spar\w*|kickbox\w*|mma|martial|karate|taekwondo)\b")) return ById("ring");
            if (Regex.IsMatch(said, @"\b(basketball|shot|shoot\w*|jumper|dribbl\w*|layup|dunk\w*|hoop|free throw|crossover)\b")) return ById("court");
            if (Regex.IsMatch(said, @"\b(workout|work out|gym|lift\w*|squat\w*|deadlift\w*|exercise|fitness|push-?ups?|pull-?ups?|burpees?|lunges?|kettlebell)\b")) return ById("gym");
            return null;
        }

        // Your room -> each place in turn -> your room.
        public void Cycle()
        {
            int i = Current == null ? -1 : System.Array.IndexOf(All, Current);
            Set(i + 1 < All.Length ? All[i + 1] : null);
        }

        public void Set(Place place)
        {
            if (place == Current) return;
            if (!Visible) Anchor();
            Current = place;
            if (place == null)
            {
                if (passthrough != null) passthrough.enabled = true; // your room comes back as the place fades away
                foreach (var l in layers) l.leaving = true;
                return;
            }
            StartCoroutine(Bring(place, ++request));
        }

        // The place's camera where you stand, its interesting side the way you faced when the person was placed.
        void Anchor()
        {
            if (head == null || anchor == null) return;
            var at = head.position;
            float floor = placer != null ? placer.FloorY : 0f;
            anchor.SetPositionAndRotation(new Vector3(at.x, floor, at.z), Quaternion.LookRotation(placedForward, Vector3.up));
        }

        IEnumerator Bring(Place place, int ticket)
        {
            var load = Resources.LoadAsync<Texture2D>($"Places/{place.id}");
            yield return load;
            if (ticket != request) yield break; // already moved on to another place
            if (load.asset is not Texture2D texture)
            {
                Debug.LogWarning($"[Lucid Dreams] The place '{place.id}' isn't in this build (run Lucid Dreams > Set Up Project).");
                if (Current == place) Current = null;
                yield break;
            }

            var go = new GameObject($"Place: {place.name}", typeof(MeshFilter), typeof(MeshRenderer));
            go.transform.SetParent(anchor, false);
            go.transform.localPosition = new Vector3(0f, place.cameraHeight, 0f); // its flattened bottom on our floor
            // turn the chosen column to the anchor's forward (columns run left to right as you turn right)
            go.transform.localRotation = Quaternion.Euler(0f, -360f * (place.ahead - 0.5f), 0f);
            go.GetComponent<MeshFilter>().sharedMesh = sphere ??= GroundedSphere(DefaultCameraHeight, Radius);
            var material = new Material(shader) { name = place.name, mainTexture = texture };
            material.SetFloat("_Opacity", 0f);
            var r = go.GetComponent<MeshRenderer>();
            r.sharedMaterial = material;
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            // the newest place draws over the ones it's fading in over
            foreach (var l in layers) l.material.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Background - 1;
            material.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Background;
            layers.Add(new Layer { place = place, go = go, material = material });
        }

        void Update()
        {
            // A dream starts in its own place: experience.environment, else what its intent suggests, else your room.
            if (player != null && player.IsReady && player.Dream != startedFor)
            {
                startedFor = player.Dream;
                Set(Starting(player.Experience?.environment, player.Experience?.intent ?? player.Dream.intent));
            }

            if (layers.Count == 0) return;
            float step = Time.deltaTime / FadeS;
            var top = layers[^1];
            foreach (var l in layers)
            {
                // a place fades in over the one before it; only a lone place leaving fades itself out (back to your room)
                l.k = l.leaving ? Mathf.Max(0f, l.k - step) : Mathf.Min(1f, l.k + step);
                l.material.SetFloat("_Opacity", GlassUI.Ease(l.k));
            }
            var keep = !top.leaving && top.k >= 1f ? new List<Layer> { top } : layers.Where(l => !(l.leaving && l.k <= 0f)).ToList();
            foreach (var l in layers.Where(l => !keep.Contains(l)).ToList())
            {
                Destroy(l.go);
                Destroy(l.material);
            }
            layers.Clear();
            layers.AddRange(keep);

            bool fullyIn = layers.Count > 0 && !layers[^1].leaving && layers[^1].k >= 1f;
            if (passthrough != null && passthrough.enabled == fullyIn) passthrough.enabled = !fullyIn;
            // Your real hands only show in passthrough; inside a place their stand-ins would cut holes in the person.
            if (handOccluder != null) handOccluder.enabled = layers.Count == 0;
        }

        // A sphere seen from inside, centred at the panorama's camera, with its bottom flattened into a floor `height`
        // below the centre (as three.js's GroundedSkybox does), so the panorama's ground lies on your real floor.
        static Mesh GroundedSphere(float height, float radius, int across = 128, int down = 64)
        {
            var verts = new List<Vector3>();
            var uvs = new List<Vector2>();
            var tris = new List<int>();
            float y1 = -height * 1.5f;
            for (int y = 0; y <= down; y++)
            {
                float v = (float)y / down; // 0 at the zenith
                float lat = Mathf.PI * (0.5f - v);
                for (int x = 0; x <= across; x++)
                {
                    float u = (float)x / across;
                    float lon = 2f * Mathf.PI * (u - 0.5f); // u = 0.5 straight ahead (+Z), increasing to the right
                    var p = new Vector3(Mathf.Cos(lat) * Mathf.Sin(lon), Mathf.Sin(lat), Mathf.Cos(lat) * Mathf.Cos(lon)) * radius;
                    if (p.y < 0f)
                    {
                        float f = p.y < y1 ? -height / p.y : 1f - p.y * p.y / (3f * y1 * y1);
                        p *= f;
                    }
                    verts.Add(p);
                    uvs.Add(new Vector2(u, 1f - v));
                }
            }
            for (int y = 0; y < down; y++)
                for (int x = 0; x < across; x++)
                {
                    int a = y * (across + 1) + x, b = a + across + 1;
                    tris.AddRange(new[] { a, b, a + 1, a + 1, b, b + 1 });
                }
            var mesh = new Mesh { name = "Grounded sphere", indexFormat = UnityEngine.Rendering.IndexFormat.UInt32 };
            mesh.SetVertices(verts);
            mesh.SetUVs(0, uvs);
            mesh.SetTriangles(tris, 0);
            mesh.RecalculateBounds();
            mesh.bounds = new Bounds(Vector3.zero, Vector3.one * radius * 2.2f);
            return mesh;
        }
    }
}
