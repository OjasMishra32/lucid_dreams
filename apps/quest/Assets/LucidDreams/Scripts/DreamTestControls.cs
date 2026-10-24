using UnityEngine;
using UnityEngine.InputSystem;

namespace LucidDreams
{
    // Controller and keyboard playback controls until the in-headset UI lands.
    // Right controller: A play/pause, B speed (0.25 / 0.5 / 1x), thumbstick left/right scrubs, trigger re-places in front of you.
    // Keyboard (editor): Space play/pause, S speed, arrows step a frame, P re-place.
    public class DreamTestControls : MonoBehaviour
    {
        public DreamSequencePlayer player;
        public DreamPlacer placer;
        [Tooltip("Seconds of footage scrubbed per second at full thumbstick.")]
        public float scrubRate = 1f;

        InputAction playPause, speed, scrub, place;

        void OnEnable()
        {
            playPause = Bind("<XRController>{RightHand}/primaryButton", "<Keyboard>/space");
            speed = Bind("<XRController>{RightHand}/secondaryButton", "<Keyboard>/s");
            place = Bind("<XRController>{RightHand}/triggerPressed", "<Keyboard>/p");
            scrub = new InputAction("Scrub", InputActionType.Value, "<XRController>{RightHand}/thumbstick/x");
            scrub.AddCompositeBinding("1DAxis").With("Negative", "<Keyboard>/leftArrow").With("Positive", "<Keyboard>/rightArrow");
            scrub.Enable();
        }

        static InputAction Bind(string xr, string key)
        {
            var action = new InputAction(type: InputActionType.Button, binding: xr);
            action.AddBinding(key);
            action.Enable();
            return action;
        }

        void OnDisable()
        {
            playPause?.Dispose();
            speed?.Dispose();
            scrub?.Dispose();
            place?.Dispose();
        }

        void Update()
        {
            if (place.WasPressedThisFrame() && placer != null) placer.PlaceInFrontOfViewer();
            if (player == null || !player.IsReady) return;

            if (playPause.WasPressedThisFrame()) player.TogglePlay();
            if (speed.WasPressedThisFrame()) player.CycleSpeed();

            float axis = scrub.ReadValue<float>();
            if (Keyboard.current != null && (Keyboard.current.leftArrowKey.wasPressedThisFrame || Keyboard.current.rightArrowKey.wasPressedThisFrame))
                player.Step(axis > 0 ? 1 : -1);
            else if (Mathf.Abs(axis) > 0.2f && player.Duration > 0)
            {
                player.Pause();
                player.Scrub(player.NormalizedTime + axis * scrubRate * Time.deltaTime / player.Duration);
            }
        }
    }
}
