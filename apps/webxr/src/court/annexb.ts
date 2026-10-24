// H.264 Annex B demuxing for the show stream, DOM-free: split the byte stream into access units (one per show frame)
// at each access unit delimiter, mark the IDRs, and read the profile and level from the SPS (to check the codec
// string). Used by video.ts (stream D), the stand-in's self-check and the e2e decode probe. Integrator, T0 (from S6).

/** One show frame's coded bytes. `key` is true for an IDR (where a decoder may start). */
export interface AccessUnit {
  data: Uint8Array;
  key: boolean;
}

/** Splits an Annex B stream into access units at each access unit delimiter (NAL type 9; the bake writes one per frame). */
export function splitAnnexB(bytes: Uint8Array): AccessUnit[] {
  const units: AccessUnit[] = [];
  let auStart = -1;
  let key = false;
  const n = bytes.length;
  for (let i = 0; i + 3 < n; i++) {
    // no start code can begin at i, i+1 or i+2 unless bytes[i+2] is 0 or 1
    if (bytes[i + 2] > 1) {
      i += 2;
      continue;
    }
    if (bytes[i] !== 0 || bytes[i + 1] !== 0 || bytes[i + 2] !== 1) continue;
    const start = i > 0 && bytes[i - 1] === 0 ? i - 1 : i; // a four-byte start code
    const type = bytes[i + 3] & 0x1f;
    if (type === 9) {
      if (auStart >= 0) units.push({ data: bytes.subarray(auStart, start), key });
      auStart = start;
      key = false;
    } else if (type === 5) key = true;
    i += 3;
  }
  if (auStart >= 0) units.push({ data: bytes.subarray(auStart), key });
  return units;
}

/** The first SPS's profile_idc, constraint flags and level_idc, and the WebCodecs codec string they make ("avc1.640034"). */
export function spsCodec(bytes: Uint8Array): { profile: number; constraints: number; level: number; codec: string } | null {
  for (let i = 0; i + 6 < bytes.length; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1 && (bytes[i + 3] & 0x1f) === 7) {
      const [profile, constraints, level] = [bytes[i + 4], bytes[i + 5], bytes[i + 6]];
      const hex = (x: number) => x.toString(16).padStart(2, "0");
      return { profile, constraints, level, codec: `avc1.${hex(profile)}${hex(constraints)}${hex(level)}` };
    }
  }
  return null;
}
