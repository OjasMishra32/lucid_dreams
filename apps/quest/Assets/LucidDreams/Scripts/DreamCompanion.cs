using UnityEngine;

namespace LucidDreams
{
    // A second person next to the first ("Bring in another" in the library): LeBron, and your own avatar doing his
    // shot beside him. They stand 1.5 m to the first person's left, facing the same way, under the same dream root, so
    // every placement, drag and turn moves the two together. They play on the first person's clock (the same moment,
    // pause, speed, lesson steps and your turn) and show the Reality check when the first one does. Their own voice
    // stays off: two people talking over each other is noise. Together they share one GPU budget.
    public class DreamCompanion : MonoBehaviour
    {
        [Tooltip("The first person's player: the clock the second one follows.")]
        public DreamSequencePlayer lead;
        [Tooltip("The second person's player, on its own Person object under this transform.")]
        public DreamSequencePlayer player;
        [Tooltip("How far to the first person's left they stand, in meters.")]
        public float spacing = 1.5f;

        public bool Present => player != null && !string.IsNullOrEmpty(player.bundle);
        public string Id { get; private set; }
        public string Name => player != null && player.Dream != null ? (string.IsNullOrEmpty(player.Dream.name) ? player.Dream.id : player.Dream.name) : null;

        void Start()
        {
            // The first person faces the root's +Z, so their right is +X and their left -X.
            transform.localPosition = new Vector3(-spacing, 0f, 0f);
            transform.localRotation = Quaternion.identity;
            if (player != null) player.follow = lead;
        }

        public void Load(string location, string id)
        {
            if (player == null) return;
            Id = id;
            player.follow = lead;
            if (lead != null) player.transform.localScale = lead.transform.localScale; // the same handedness mirror
            player.Load(location);
        }

        public void Dismiss()
        {
            if (player == null) return;
            player.Unload();
            Id = null;
        }

        void Update()
        {
            transform.localPosition = new Vector3(-spacing, 0f, 0f);
            if (lead == null || player == null || !player.IsReady || !lead.IsReady) return;
            // Seen vs imagined applies to everyone you're shown.
            if (player.HasReality && !player.RealityLoading && player.RealityError == null && player.ShowingReality != lead.ShowingReality)
                player.ToggleReality();
        }
    }
}
