using UnityEngine;
using UnityEngine.XR.ARFoundation;
using UnityEngine.XR.ARSubsystems;

namespace LucidDreams
{
    // Stands the dream on the real floor, life size, facing the viewer. Never scales the person.
    // Bundle space (AGENTS.md): meters, +Y up, feet at y = 0, centred on x = z = 0, front faces -Z.
    public class DreamPlacer : MonoBehaviour
    {
        public enum Place
        {
            Facing, // in front of you, facing you (default)
            Beside, // at your right side, facing your way: copy them like the person next to you in a class
            Ahead,  // ahead of you, facing away: follow them like the teacher at the front of the room
        }

        public Transform head;
        public ARPlaneManager planes;
        public Transform person;
        [Tooltip("Takes Place from the bundle's experience plan once it loads.")]
        public DreamSequencePlayer player;
        public Place place = Place.Facing;

        [Tooltip("How far in front of the viewer the person stands when facing you, in meters.")]
        public float distance = 1.8f;
        public float aheadDistance = 1.5f;
        public Vector2 besideOffset = new(0.8f, 0.5f); // right, forward

        // Fires after the person is set in front of the viewer, with the viewer's flat forward.
        public event System.Action<Vector3> PlacedForViewer;

        [Tooltip("Pipeline exports are right-handed; mirror Z so the person isn't flipped in Unity's left-handed space.")]
        public bool sourceIsRightHanded = true;

        public float FloorY => floorY;
        public bool IsPlaced => placed;
        // Seated at bench height (Seating), or standing on the floor.
        public Seating Seat { get; private set; }
        // How far the person is raised above their bundle's own floor: a seated person without legs, onto the bench.
        public float Lift => Seat.lift;

        float floorY;
        bool placed;
        bool floorFromPlane;

        void Start()
        {
            ApplyHandedness();
            if (player != null) player.Ready += OnReady;
        }

        void OnDestroy()
        {
            if (player != null) player.Ready -= OnReady;
        }

        // Someone seated goes up (or down) to bench height. A plan that wants them beside you or ahead re-stands them
        // once it's known.
        void OnReady()
        {
            Seat = Seating.For(player.Body, player.Experience, player.Dream?.intent);
            if (person != null) person.localPosition = new Vector3(0f, Seat.lift, 0f);
            if (Seat.seated)
                Debug.Log($"[Lucid Dreams] Seated: hips at {Seat.benchTop:F2} m, raised {Seat.lift:+0.00;-0.00} m{(Seat.needsBench ? ", a bench under them" : "")}.");

            var wanted = Parse(player.Experience?.place);
            if (wanted == place && placed) return;
            place = wanted;
            if (head != null && head.position != Vector3.zero) PlaceInFrontOfViewer();
        }

        public static Place Parse(string value) => value switch
        {
            "beside" => Place.Beside,
            "ahead" => Place.Ahead,
            _ => Place.Facing,
        };

        void Update()
        {
            if (!floorFromPlane && TryFindFloor(out float y))
            {
                floorY = y;
                floorFromPlane = true;
                // Keep wherever the person was put; only stand them exactly on the scanned floor.
                if (placed) transform.position = new Vector3(transform.position.x, floorY, transform.position.z);
            }

            // Head pose is zero for the first frames while tracking starts.
            if (!placed && head != null && head.position != Vector3.zero)
            {
                PlaceInFrontOfViewer();
            }
        }

        public void PlaceInFrontOfViewer()
        {
            Vector3 forward = ViewerForward();
            Vector3 right = Vector3.Cross(Vector3.up, forward);
            Vector3 spot = place switch
            {
                Place.Beside => head.position + right * besideOffset.x + forward * besideOffset.y,
                Place.Ahead => head.position + forward * aheadDistance,
                _ => head.position + forward * distance,
            };
            PlaceAt(spot);
            PlacedForViewer?.Invoke(forward);
        }

        // Stands the person on the floor below the point: facing the viewer, or (beside / ahead) facing the viewer's way.
        public void PlaceAt(Vector3 point)
        {
            var spot = new Vector3(point.x, floorY, point.z);
            Vector3 front;
            if (place != Place.Facing && head != null) front = ViewerForward();
            else
            {
                front = head != null ? Vector3.ProjectOnPlane(head.position - spot, Vector3.up) : Vector3.back;
                if (front.sqrMagnitude < 1e-4f) front = transform.forward;
            }
            transform.SetPositionAndRotation(spot, Quaternion.LookRotation(front.normalized, Vector3.up));
            placed = true;
        }

        Vector3 ViewerForward()
        {
            Vector3 forward = Vector3.ProjectOnPlane(head.forward, Vector3.up);
            if (forward.sqrMagnitude < 1e-4f) forward = Vector3.ProjectOnPlane(head.up, Vector3.up);
            return forward.normalized;
        }

        // Moves along the floor and turns about the vertical axis; height always stays on the floor.
        public void MoveTo(Vector3 point, float yawDegrees)
        {
            transform.SetPositionAndRotation(new Vector3(point.x, floorY, point.z), Quaternion.Euler(0f, yawDegrees, 0f));
            placed = true;
        }

        // Without a scanned floor, the XR Origin's floor-level tracking puts the floor at its own y.
        bool TryFindFloor(out float y)
        {
            y = 0f;
            if (planes == null) return false;
            bool found = false;
            foreach (var plane in planes.trackables)
            {
                if ((plane.classifications & PlaneClassifications.Floor) == 0) continue;
                // The lowest floor plane wins, so a rug or low table never lifts the person.
                if (!found || plane.center.y < y) y = plane.center.y;
                found = true;
            }
            return found;
        }

        // The person's file faces -Z. Mirroring Z turns that into the root's +Z, and the root looks back at the viewer.
        void ApplyHandedness()
        {
            if (person == null) return;
            var s = person.localScale;
            s.z = Mathf.Abs(s.z) * (sourceIsRightHanded ? -1f : 1f);
            person.localScale = s;
        }
    }
}
