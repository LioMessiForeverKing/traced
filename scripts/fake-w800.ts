import { readFile } from "node:fs/promises";
import { runFakeW800 } from "../src/axis/testing/fake-w800.js";
import { loadEnv } from "../src/env.js";

const env = loadEnv();
const axis = env.axis;
if (!axis.enabled) {
  console.error("fake-w800 drives the Axis wire, so it needs AXIS_ENABLED=true and the four CD_ values.");
  process.exit(1);
}

const baseUrl = process.argv[2] ?? `http://localhost:${env.PORT}`;
const clipPath = process.argv[3];

const result = await runFakeW800({
  baseUrl,
  username: axis.username,
  password: axis.password,
  fetch: (url, init) => fetch(url, init),
  clipBytes: clipPath ? new Uint8Array(await readFile(clipPath)) : undefined,
});

console.log(
  JSON.stringify(
    {
      event: "fake_w800_complete",
      baseUrl,
      recording: result.recordingName,
      clip: result.clipName,
      clipBytes: result.clipBytes.byteLength,
      gpsTrail: result.gpsTrailName,
      statuses: result.statuses,
    },
    null,
    2,
  ),
);
