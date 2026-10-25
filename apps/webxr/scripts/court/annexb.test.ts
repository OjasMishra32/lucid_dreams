// annexb.ts: access units split at each delimiter, IDRs marked, the codec string read from the SPS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitAnnexB, spsCodec } from "../../src/court/annexb.ts";

const AUD = [0, 0, 0, 1, 0x09, 0xf0];
const SPS = [0, 0, 0, 1, 0x67, 0x64, 0x00, 0x34, 0xac];
const PPS = [0, 0, 1, 0x68, 0xee];
const IDR = [0, 0, 1, 0x65, 0x88, 0x84, 0x00];
const P = [0, 0, 1, 0x41, 0x9a, 0x02];

test("three frames: an IDR with its headers, then two P frames", () => {
  const bytes = new Uint8Array([...AUD, ...SPS, ...PPS, ...IDR, ...AUD, ...P, ...AUD, ...P]);
  const units = splitAnnexB(bytes);
  assert.deepEqual(units.map((u) => u.key), [true, false, false]);
  assert.equal(units.reduce((n, u) => n + u.data.length, 0), bytes.length);
  assert.deepEqual([...units[1].data.subarray(0, 6)], AUD);
});

test("the SPS gives avc1.640034 (High, level 5.2)", () => {
  const sps = spsCodec(new Uint8Array([...AUD, ...SPS, ...PPS]));
  assert.deepEqual(sps, { profile: 100, constraints: 0, level: 52, codec: "avc1.640034" });
  assert.equal(spsCodec(new Uint8Array([...AUD, ...P])), null);
});
