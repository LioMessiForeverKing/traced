import { describe, expect, it } from "vitest";
import { createApp, STORAGE_PATH } from "../src/app.js";
import { CAPABILITIES } from "../src/capabilities.js";
import { MemoryStore } from "../src/stores/memory.js";
import { runFakeW800 } from "../src/testing/fake-w800.js";
import { createHash } from "node:crypto";
import { CREDS, PUBLIC_URL } from "./credentials.js";

function harness(now = () => Date.parse("2026-09-08T18:00:00Z")) {
  const store = new MemoryStore();
  const app = createApp({ store, publicUrl: PUBLIC_URL, ...CREDS, now });
  const fetchLike = async (url: string, init?: RequestInit) => app.request(url, init);
  return { store, app, fetchLike };
}

async function authenticate(app: ReturnType<typeof createApp>) {
  const response = await app.request(`${PUBLIC_URL}/auth/v1.0`, {
    headers: { "X-Auth-User": CREDS.username, "X-Auth-Key": CREDS.password },
  });
  return { response, token: response.headers.get("x-auth-token") ?? "" };
}

describe("auth", () => {
  it("rejects wrong credentials", async () => {
    const { app } = harness();
    const response = await app.request(`${PUBLIC_URL}/auth/v1.0`, {
      headers: { "X-Auth-User": CREDS.username, "X-Auth-Key": "wrong" },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("x-auth-token")).toBeNull();
  });

  it("returns a token and the storage url the W800 will use", async () => {
    const { app } = harness();
    const { response, token } = await authenticate(app);
    expect(response.status).toBe(200);
    expect(token).not.toBe("");
    expect(response.headers.get("x-storage-url")).toBe(`${PUBLIC_URL}${STORAGE_PATH}`);
  });

  it("rejects storage calls without a valid token", async () => {
    const { app } = harness();
    const missing = await app.request(`${PUBLIC_URL}${STORAGE_PATH}/System/Capabilities.json`);
    expect(missing.status).toBe(401);
    const forged = await app.request(`${PUBLIC_URL}${STORAGE_PATH}/System/Capabilities.json`, {
      headers: { "X-Auth-Token": "9999999999999.forged" },
    });
    expect(forged.status).toBe(401);
  });

  it("expires tokens after fifteen minutes", async () => {
    let clock = Date.parse("2026-09-08T18:00:00Z");
    const { app } = harness(() => clock);
    const { token } = await authenticate(app);
    clock += 16 * 60 * 1000;
    const response = await app.request(`${PUBLIC_URL}${STORAGE_PATH}/System/Capabilities.json`, {
      headers: { "X-Auth-Token": token },
    });
    expect(response.status).toBe(401);
  });
});

describe("capabilities", () => {
  it("serves Capabilities.json with an md5 Etag", async () => {
    const { app } = harness();
    const { token } = await authenticate(app);
    const response = await app.request(`${PUBLIC_URL}${STORAGE_PATH}/System/Capabilities.json`, {
      headers: { "X-Auth-Token": token },
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual(CAPABILITIES);
    expect(response.headers.get("etag")).toBe(createHash("md5").update(body).digest("hex"));
  });

  it("refuses reads of anything outside System", async () => {
    const { app } = harness();
    const { token } = await authenticate(app);
    const response = await app.request(`${PUBLIC_URL}${STORAGE_PATH}/Users/anything`, {
      headers: { "X-Auth-Token": token },
    });
    expect(response.status).toBe(403);
  });
});

describe("a docked camera offloading one recording", () => {
  it("lands the recording, its clip and its GPS trail, then marks it complete", async () => {
    const { store, fetchLike } = harness();
    const triggerOn = new Date("2026-09-08T17:12:09Z");
    const result = await runFakeW800({ baseUrl: PUBLIC_URL, ...CREDS, fetch: fetchLike, triggerOn });

    expect(result.statuses.every((status) => status < 300)).toBe(true);

    expect(store.cameraUsers.get(result.userId)).toMatchObject({ name: "Fake Worker", userid: "EMP-001" });
    expect(store.devices.get(result.deviceSerial)).toMatchObject({ model: "W120" });
    expect(store.systems.size).toBe(1);

    const recording = store.recordings.get(result.recordingName);
    expect(recording).toBeDefined();
    expect(recording?.userId).toBe(result.userId);
    expect(recording?.deviceSerial).toBe(result.deviceSerial);
    expect(recording?.triggerOnTime?.toISOString()).toBe(triggerOn.toISOString());
    expect(recording?.status).toBe("complete");
    expect(recording?.completedAt).toBeInstanceOf(Date);
    expect(recording?.meta.triggeroff).toBe("Button");

    const objects = store.objects.get(result.recordingName);
    expect(objects?.size).toBe(2);

    const clip = objects?.get(result.clipName);
    expect(clip?.kind).toBe("clip");
    expect(clip?.contentType).toBe("video/mp4");
    expect(clip?.sizeBytes).toBe(result.clipBytes.byteLength);
    expect(Buffer.from(clip!.bytes).equals(Buffer.from(result.clipBytes))).toBe(true);
    expect(clip?.meta.containertype).toBe("mp4");

    const trail = objects?.get(result.gpsTrailName);
    expect(trail?.kind).toBe("gps_trail");
    expect(JSON.parse(trail!.bytes.toString("utf8"))).toEqual(result.gpsTrail);
  });

  it("returns 400 for a container name that is not a recording", async () => {
    const { app } = harness();
    const { token } = await authenticate(app);
    const response = await app.request(`${PUBLIC_URL}${STORAGE_PATH}/not-a-recording`, {
      method: "PUT",
      headers: { "X-Auth-Token": token },
    });
    expect(response.status).toBe(400);
  });

  it("returns 404 for a clip whose recording was never created", async () => {
    const { app } = harness();
    const { token } = await authenticate(app);
    const name = "6f1d2c3b-4a5e-4f60-8a9b-0c1d2e3f4a5b_B8A44F000001_20260908T171209Z";
    const response = await app.request(`${PUBLIC_URL}${STORAGE_PATH}/${name}/20260908_171139_1234.mp4`, {
      method: "PUT",
      headers: { "X-Auth-Token": token },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(response.status).toBe(404);
  });

  it("accepts rejected-content containers", async () => {
    const { app, store } = harness();
    const { token } = await authenticate(app);
    const name = "RejectedContent_20260908T171209Z_6f1d2c3b-4a5e-4f60-8a9b-0c1d2e3f4a5b";
    const response = await app.request(`${PUBLIC_URL}${STORAGE_PATH}/${name}`, {
      method: "PUT",
      headers: { "X-Auth-Token": token, "X-Container-Meta-RejectedContentReason": "corrupt%20clip" },
    });
    expect(response.status).toBe(201);
    expect(store.recordings.get(name)?.status).toBe("rejected");
    expect(store.recordings.get(name)?.meta.rejectedcontentreason).toBe("corrupt clip");
  });
});
