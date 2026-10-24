using Unity.Mathematics;

namespace LucidDreams
{
    // Eye contact: someone you're with (companion) or playing against turns their head toward you, the way a person
    // in the room would. Layered on the motion: the head (SMPL-X joint 15) takes 70% of the turn and the neck (12)
    // 30%, within ±35° yaw and ±20° pitch, eased so it settles in about 300 ms. More than 110° off their face (you
    // walked behind them) they give up and look ahead again rather than twist round. WebXR's look.ts is the same maths.
    public sealed class HeadLook
    {
        public const int Neck = 12, Head = 15;
        const float MaxYaw = 35f * math.PI / 180f, MaxPitch = 20f * math.PI / 180f, GiveUp = 110f * math.PI / 180f;
        const float NeckShare = 0.3f;
        const float EaseS = 0.1f; // time constant: 95% of the way in 300 ms

        // The turn applied now, in the head's own frame (rest pose faces +Z, +Y up): yaw toward +X, pitch up.
        public float Yaw { get; private set; }
        public float Pitch { get; private set; }
        public bool Resting => Yaw == 0f && Pitch == 0f;

        int[] chain;

        // Eases toward eye (the viewer's eyes in the bundle's space, or null to look ahead again) by dt seconds, for
        // the motion pose given by local.
        public void Step(quaternion[] local, int[] parents, float3[] rest, float3 rootT, float3? eye, float dt)
        {
            float yawT = 0f, pitchT = 0f;
            if (eye is float3 e)
            {
                HeadPose(local, parents, rest, rootT, out var rot, out var pos);
                var d = math.rotate(math.inverse(rot), e - pos); // head frame: forward +Z, up +Y
                float yaw = math.atan2(d.x, d.z);
                if (math.abs(yaw) < GiveUp)
                {
                    yawT = math.clamp(yaw, -MaxYaw, MaxYaw);
                    pitchT = math.clamp(math.atan2(d.y, math.length(d.xz)), -MaxPitch, MaxPitch);
                }
            }
            float k = 1f - math.exp(-math.max(dt, 0f) / EaseS);
            Yaw += (yawT - Yaw) * k;
            Pitch += (pitchT - Pitch) * k;
            if (eye == null && math.abs(Yaw) < 1e-4f && math.abs(Pitch) < 1e-4f) Yaw = Pitch = 0f;
        }

        // Turns the neck and head of a motion pose by the current yaw and pitch. The neck turns about the head's own
        // axes (local'_12 = local_12 · local_15 · D · local_15⁻¹), then the head takes the rest, so the head ends up
        // turned by the whole yaw and pitch.
        public void Apply(quaternion[] local)
        {
            if (Resting) return;
            var head = local[Head];
            local[Neck] = math.mul(local[Neck], math.mul(math.mul(head, Turn(NeckShare)), math.inverse(head)));
            local[Head] = math.mul(head, Turn(1f - NeckShare));
        }

        quaternion Turn(float share) =>
            math.mul(quaternion.AxisAngle(new float3(0f, 1f, 0f), share * Yaw), quaternion.AxisAngle(new float3(-1f, 0f, 0f), share * Pitch));

        // The head's rotation and position in the bundle's space for these joint rotations (the chain pelvis to head).
        public void HeadPose(quaternion[] local, int[] parents, float3[] rest, float3 rootT, out quaternion rot, out float3 pos)
        {
            if (chain == null)
            {
                var c = new System.Collections.Generic.List<int>();
                for (int j = Head; j >= 0; j = parents[j]) c.Insert(0, j);
                chain = c.ToArray();
            }
            rot = quaternion.identity;
            pos = rest[chain[0]];
            for (int i = 0; i < chain.Length; i++)
            {
                if (i > 0) pos += math.rotate(rot, rest[chain[i]] - rest[chain[i - 1]]);
                rot = math.mul(rot, local[chain[i]]);
            }
            pos += rootT;
        }
    }
}
