import { describe, expect, it } from "vitest";
import { parseCompactUtc, parseRecordingName } from "../src/axis/swift.js";
import { UPLOAD_NAME_PREFIX, uploadRecordingName } from "../src/uploads.js";

const AT = new Date("2026-09-20T14:32:16.482Z");

describe("upload recording name", () => {
  it("carries the prefix the insert policy requires", () => {
    expect(uploadRecordingName(AT).startsWith(UPLOAD_NAME_PREFIX)).toBe(true);
  });

  it("is a name the Axis wire can never produce", () => {
    expect(parseRecordingName(uploadRecordingName(AT))).toBeNull();
    expect(parseRecordingName(`${UPLOAD_NAME_PREFIX}00000000_20260920T143216Z`)).toBeNull();
  });

  it("ends in the same compact UTC stamp an Axis name ends in", () => {
    const stamp = uploadRecordingName(AT).split("_").at(-1)!;
    expect(parseCompactUtc(stamp)).toEqual(new Date("2026-09-20T14:32:16Z"));
  });

  it("does not collide when two uploads land in the same second", () => {
    const names = new Set(Array.from({ length: 200 }, () => uploadRecordingName(AT)));
    expect(names.size).toBe(200);
  });

  it("stays a single storage folder, whatever the clock says", () => {
    for (const at of [new Date(0), AT, new Date("2100-01-01T00:00:00Z")]) {
      expect(uploadRecordingName(at)).not.toContain("/");
    }
  });
});
