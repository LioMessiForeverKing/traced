import { loadEnv } from "../src/env.js";
import { runFakeW800 } from "../src/testing/fake-w800.js";

const env = loadEnv();
const baseUrl = process.argv[2] ?? `http://localhost:${env.PORT}`;

const result = await runFakeW800({
  baseUrl,
  username: env.CD_USERNAME,
  password: env.CD_PASSWORD,
  fetch: (url, init) => fetch(url, init),
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
