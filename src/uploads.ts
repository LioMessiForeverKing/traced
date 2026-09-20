import { randomBytes } from "node:crypto";

/** The prefix is the whole of how an uploaded recording stays out of the Axis namespace:
 * `parseRecordingName` accepts only a uuid or `RejectedContent_`, so neither side can mint
 * a name the other already holds, and the insert policy refuses anything else. */
export const UPLOAD_NAME_PREFIX = "upload_";

function compactUtc(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export function uploadRecordingName(at: Date = new Date()): string {
  return `${UPLOAD_NAME_PREFIX}${randomBytes(4).toString("hex")}_${compactUtc(at)}`;
}
