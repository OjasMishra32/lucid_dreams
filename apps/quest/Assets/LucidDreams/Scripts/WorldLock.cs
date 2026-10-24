using UnityEngine;
using UnityEngine.XR.ARFoundation;
using UnityEngine.XR.ARSubsystems;

namespace LucidDreams
{
    // Keeps the person where you put them in your real room, as WebXR's xr/anchor.ts does: an AR anchor at their pose,
    // read back every frame, so a recenter or tracking drift never slides them across the floor. DreamPlacer locks after
    // every placement (Bring here included). Without anchor support (the editor, a headset without it) they stay put
    // in tracking space, as before.
    public class WorldLock : MonoBehaviour
    {
        public ARAnchorManager anchors;

        ARAnchor anchor;
        int asked;

        public bool Locked => anchor != null;

        // Pins this transform where it stands now.
        public async void Lock()
        {
            Release();
            if (anchors == null || anchors.subsystem == null || !anchors.subsystem.running) return;
            int id = asked;
            var result = await anchors.TryAddAnchorAsync(new Pose(transform.position, transform.rotation));
            if (!result.status.IsSuccess() || result.value == null) return; // no anchor here: it stays put in tracking space
            if (id != asked || this == null) anchors.TryRemoveAnchor(result.value); // placed again meanwhile
            else anchor = result.value;
        }

        public void Release()
        {
            asked++;
            if (anchor != null && anchors != null) anchors.TryRemoveAnchor(anchor);
            anchor = null;
        }

        void LateUpdate()
        {
            if (anchor == null || anchor.trackingState != TrackingState.Tracking) return;
            transform.SetPositionAndRotation(anchor.transform.position, anchor.transform.rotation);
        }

        void OnDestroy() => Release();
    }
}
