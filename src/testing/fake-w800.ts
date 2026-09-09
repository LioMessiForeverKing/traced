import { randomUUID } from "node:crypto";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FakeW800Options {
  baseUrl: string;
  username: string;
  password: string;
  fetch: FetchLike;
  triggerOn?: Date;
  clipSeconds?: number;
}

export interface FakeW800Result {
  userId: string;
  deviceSerial: string;
  recordingName: string;
  clipName: string;
  clipBytes: Uint8Array;
  gpsTrailName: string;
  gpsTrail: { CoordinateEntries: { LocationWKT: string; SecondsFromStart: number; Timestamp: string }[] };
  statuses: number[];
}

function compactUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function metaHeaders(scope: "Container" | "Object", meta: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(meta).map(([key, value]) => [`X-${scope}-Meta-${key}`, encodeURIComponent(value)]),
  );
}

export function fakeMp4(bytes: number): Uint8Array {
  const header = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const payload = Buffer.alloc(Math.max(0, bytes - header.length));
  for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 7919) % 251;
  return new Uint8Array(Buffer.concat([header, payload]));
}

export async function runFakeW800(options: FakeW800Options): Promise<FakeW800Result> {
  const statuses: number[] = [];
  const send = async (url: string, init: RequestInit): Promise<Response> => {
    const response = await options.fetch(url, init);
    statuses.push(response.status);
    if (!response.ok) throw new Error(`${init.method} ${url} -> ${response.status}`);
    return response;
  };

  const auth = await send(`${options.baseUrl}/auth/v1.0`, {
    method: "GET",
    headers: { "X-Auth-User": options.username, "X-Auth-Key": options.password },
  });
  const token = auth.headers.get("x-auth-token");
  const storageUrl = auth.headers.get("x-storage-url");
  if (!token || !storageUrl) throw new Error("auth response missing token or storage url");
  const authed = { "X-Auth-Token": token };

  const capabilities = await send(`${storageUrl}/System/Capabilities.json`, { method: "GET", headers: authed });
  await capabilities.json();

  const userId = randomUUID();
  const deviceSerial = "B8A44F" + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0").toUpperCase();
  const systemId = randomUUID();

  for (const fixed of ["System", "Users", "Devices"]) {
    await send(`${storageUrl}/${fixed}`, { method: "PUT", headers: authed });
  }
  await send(`${storageUrl}/System/${systemId}`, {
    method: "PUT",
    headers: { ...authed, ...metaHeaders("Object", { ConnectionId: randomUUID(), SystemName: "Traced fake W800" }) },
  });
  await send(`${storageUrl}/Users/${userId}`, {
    method: "PUT",
    headers: { ...authed, ...metaHeaders("Object", { Active: "True", Name: "Fake Worker", UserID: "EMP-001" }) },
  });
  await send(`${storageUrl}/Devices/${deviceSerial}`, {
    method: "PUT",
    headers: { ...authed, ...metaHeaders("Object", { Active: "True", Name: "Fake vest cam", Model: "W120" }) },
  });

  const triggerOn = options.triggerOn ?? new Date();
  const clipSeconds = options.clipSeconds ?? 90;
  const start = new Date(triggerOn.getTime() - 30_000);
  const stop = new Date(triggerOn.getTime() + clipSeconds * 1000);
  const recordingName = `${userId}_${deviceSerial}_${compactUtc(triggerOn)}`;
  const recordingId = Math.floor(Math.random() * 9000 + 1000);

  await send(`${storageUrl}/${recordingName}`, {
    method: "PUT",
    headers: {
      ...authed,
      ...metaHeaders("Container", {
        ContainerName: recordingName,
        BWCSerialNumber: deviceSerial,
        SCUSerialNumber: "ACCC8E000001",
        FirmwareVersion: "11.11.1",
        UserID: userId,
        TriggerOn: "Button",
        TriggerOnTime: String(Math.floor(triggerOn.getTime() / 1000)),
        TriggerOnTimeISO: triggerOn.toISOString(),
        StartTime: String(Math.floor(start.getTime() / 1000)),
        StartTimeISO: start.toISOString(),
        TimeZone: "America/Los_Angeles",
        BWCModel: "W120",
        Status: "Transferring",
      }),
    },
  });

  const clipName = `${compactUtc(start).replace("T", "_")}_${recordingId}.mp4`;
  const clipBytes = fakeMp4(64 * 1024);
  await send(`${storageUrl}/${recordingName}/${clipName}`, {
    method: "PUT",
    headers: {
      ...authed,
      "Content-Type": "video/mp4",
      "Content-Length": String(clipBytes.byteLength),
      ...metaHeaders("Object", {
        StartTime: String(Math.floor(start.getTime() / 1000)),
        StartTimeISO: start.toISOString(),
        StopTime: String(Math.floor(stop.getTime() / 1000)),
        StopTimeISO: stop.toISOString(),
        ContainerType: "mp4",
      }),
    },
    body: clipBytes,
  });

  const gpsTrail = {
    CoordinateEntries: [0, 30, 60].map((seconds) => ({
      LocationWKT: `POINT(${(-122.4194 + seconds / 100000).toFixed(6)} ${(37.7749 + seconds / 100000).toFixed(6)})`,
      SecondsFromStart: seconds,
      Timestamp: new Date(start.getTime() + seconds * 1000).toISOString(),
    })),
  };
  const gpsTrailName = `${compactUtc(start).replace("T", "_")}_${recordingId}_${deviceSerial}_gpstrail.json`;
  await send(`${storageUrl}/${recordingName}/${gpsTrailName}`, {
    method: "PUT",
    headers: { ...authed, "Content-Type": "application/json", ...metaHeaders("Object", { FileType: "json" }) },
    body: JSON.stringify(gpsTrail),
  });

  await send(`${storageUrl}/${recordingName}`, {
    method: "POST",
    headers: {
      ...authed,
      ...metaHeaders("Container", {
        TriggerOff: "Button",
        TriggerOffTime: String(Math.floor(stop.getTime() / 1000)),
        TriggerOffTimeISO: stop.toISOString(),
        StopTime: String(Math.floor(stop.getTime() / 1000)),
        StopTimeISO: stop.toISOString(),
        Status: "Complete",
      }),
    },
  });

  return { userId, deviceSerial, recordingName, clipName, clipBytes, gpsTrailName, gpsTrail, statuses };
}
