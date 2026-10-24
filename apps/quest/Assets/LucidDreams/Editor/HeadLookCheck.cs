using System;
using Unity.Mathematics;
using UnityEditor;
using UnityEngine;

namespace LucidDreams.Editor
{
    // Checks HeadLook (eye contact) on an SMPL-X-shaped chain, the same cases as apps/webxr/scripts/check_look.ts: the
    // head ends up facing your eyes, stays within ±35° yaw and ±20° pitch, looks ahead again when you're behind,
    // settles within 300 ms, and the neck carries 30% of the turn.
    //   Unity -batchmode -projectPath apps/quest -executeMethod LucidDreams.Editor.HeadLookCheck.Run -quit
    public static class HeadLookCheck
    {
        static readonly int[] Parents = { -1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12 };
        const float Deg = 180f / math.PI;
        static int failed;

        [MenuItem("Lucid Dreams/Check Eye Contact")]
        public static void Run()
        {
            failed = 0;
            var rest = new float3[Parents.Length];
            for (int j = 0; j < rest.Length; j++) rest[j] = new float3(0f, 0.1f * j, 0f);
            rest[0] = new float3(0f, 0.95f, 0f);
            rest[3] = new float3(0f, 1.05f, 0f);
            rest[6] = new float3(0f, 1.2f, 0f);
            rest[9] = new float3(0f, 1.35f, 0f);
            rest[12] = new float3(0f, 1.5f, 0f);
            rest[15] = new float3(0f, 1.62f, 0.02f);

            {
                var eye = new float3(0.4f, 1.7f, -1.8f);
                var r = Look(rest, eye, 2f, new HeadLook());
                float off = Angle(r.forward, math.normalize(eye - r.pos));
                Check("faces your eyes", off < 0.5f, $"{off:F2}° off");
            }
            {
                var r = Look(rest, new float3(2f, 1.62f, -0.4f), 2f, new HeadLook());
                float yaw = Angle(Flat(r.forward), new float3(0f, 0f, -1f));
                Check("yaw stops at 35°", math.abs(yaw - 35f) < 0.5f, $"{yaw:F2}°");
                Check("turns toward you (+X)", r.forward.x > 0f, $"forward.x {r.forward.x:F3}");
            }
            {
                var r = Look(rest, new float3(0f, 3.5f, -1f), 2f, new HeadLook());
                float pitch = math.asin(r.forward.y) * Deg;
                Check("pitch stops at 20°", math.abs(pitch - 20f) < 0.5f, $"{pitch:F2}°");
            }
            {
                var look = new HeadLook();
                Look(rest, new float3(1f, 1.7f, -1.5f), 2f, look);
                var r = Look(rest, new float3(0.1f, 1.62f, 2f), 2f, look);
                float off = Angle(r.forward, new float3(0f, 0f, -1f));
                Check("looks ahead again when you're behind", off < 0.5f, $"{off:F2}° off ahead");
                Look(rest, null, 2f, look);
                Check("eases back to rest without a viewer", look.Resting, $"yaw {look.Yaw}, pitch {look.Pitch}");
            }
            {
                var r = Look(rest, new float3(math.tan(20f / Deg) * 1.8f, 1.62f, -1.8f), 0.3f, new HeadLook());
                float yaw = Angle(Flat(r.forward), new float3(0f, 0f, -1f));
                Check("settles within 300 ms", yaw / 20f > 0.94f, $"{yaw / 20f * 100f:F1}% of 20° after 0.3 s");
            }
            {
                var r = Look(rest, new float3(math.tan(30f / Deg) * 1.8f, 1.62f, -1.8f), 2f, new HeadLook());
                float neck = 2f * math.acos(math.min(1f, math.abs(r.local[HeadLook.Neck].value.w))) * Deg;
                Check("neck carries 30%", math.abs(neck - 9f) < 0.5f, $"neck {neck:F2}° of a 30° turn");
            }

            Debug.Log(failed == 0 ? "[HeadLookCheck] LOOK_OK" : $"[HeadLookCheck] {failed} failed");
            if (Application.isBatchMode) EditorApplication.Exit(failed == 0 ? 0 : 1);
        }

        // The motion: standing, turned to face -Z (the bundle's front), as every avatar's root_q does.
        static quaternion[] Motion()
        {
            var local = new quaternion[Parents.Length];
            for (int j = 0; j < local.Length; j++) local[j] = quaternion.identity;
            local[0] = quaternion.AxisAngle(new float3(0f, 1f, 0f), math.PI);
            return local;
        }

        static (float3 forward, float3 pos, quaternion[] local) Look(float3[] rest, float3? eye, float seconds, HeadLook look)
        {
            var local = Motion();
            for (float t = 0f; t < seconds; t += 1f / 72f)
            {
                local = Motion();
                look.Step(local, Parents, rest, float3.zero, eye, 1f / 72f);
                look.Apply(local);
            }
            look.HeadPose(local, Parents, rest, float3.zero, out var rot, out var pos);
            return (math.rotate(rot, new float3(0f, 0f, 1f)), pos, local);
        }

        static float Angle(float3 a, float3 b) => math.acos(math.clamp(math.dot(math.normalize(a), math.normalize(b)), -1f, 1f)) * Deg;
        static float3 Flat(float3 v) => math.normalize(new float3(v.x, 0f, v.z));

        static void Check(string name, bool ok, string detail)
        {
            Debug.Log($"[HeadLookCheck] {(ok ? "ok  " : "FAIL")} {name}: {detail}");
            if (!ok) failed++;
        }
    }
}
