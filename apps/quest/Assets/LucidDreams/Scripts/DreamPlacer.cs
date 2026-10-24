using UnityEngine;
using UnityEngine.XR.ARFoundation;
using UnityEngine.XR.ARSubsystems;

namespace LucidDreams
{
    // Stands the dream on the real floor, life size, facing the viewer. Never scales the person.
    // Bundle space (AGENTS.md): meters, +Y up, feet at y = 0, centred on x = z = 0, front faces -Z.
    public class DreamPlacer : MonoBehaviour
    {
        public Transform head;
        public ARPlaneManager planes;
        public Transform person;

        [Tooltip("How far in front of the viewer the person stands, in meters.")]
        public float distance = 1.5f;

        [Tooltip("Pipeline exports are right-handed; mirror Z so the person isn't flipped in Unity's left-handed space.")]
        public bool sourceIsRightHanded = true;

        public float FloorY => floorY;
        public bool IsPlaced => placed;

        float floorY;
        bool placed;
        bool floorFromPlane;

        void Start()
        {
            ApplyHandedness();
        }

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
            Vector3 forward = Vector3.ProjectOnPlane(head.forward, Vector3.up);
            if (forward.sqrMagnitude < 1e-4f) forward = Vector3.ProjectOnPlane(head.up, Vector3.up);
            PlaceAt(head.position + forward.normalized * distance);
        }

        // Stands the person on the floor below the point, turned to face the viewer.
        public void PlaceAt(Vector3 point)
        {
            var spot = new Vector3(point.x, floorY, point.z);
            Vector3 toViewer = head != null ? Vector3.ProjectOnPlane(head.position - spot, Vector3.up) : Vector3.back;
            if (toViewer.sqrMagnitude < 1e-4f) toViewer = transform.forward;
            transform.SetPositionAndRotation(spot, Quaternion.LookRotation(toViewer.normalized, Vector3.up));
            placed = true;
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
