import { Hono } from "hono";
import { logger } from "hono/logger";
import { createHash } from "node:crypto";
import { credentialsMatch, mintToken, verifyToken } from "./auth.js";
import { CAPABILITIES, CATEGORIES } from "./capabilities.js";
import type { AxisIngestStore } from "./store.js";
import { classifyObject, FIXED_CONTAINERS, parseMeta, parseRecordingName } from "./swift.js";

export const ACCOUNT = "traced";
export const STORAGE_PATH = `/v1/${ACCOUNT}`;
export const AUTH_PATH = "/auth/v1.0";

export interface AxisAppDeps {
  store: AxisIngestStore;
  publicUrl: string;
  username: string;
  password: string;
  tokenSecret: string;
  now?: () => number;
  logging?: boolean;
}

const SYSTEM_DOCUMENTS: Record<string, unknown> = {
  "Capabilities.json": CAPABILITIES,
  "Categories.json": CATEGORIES,
};

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

function sizeFrom(header: string | undefined): number | null {
  if (!header || !/^\d+$/.test(header)) return null;
  return Number(header);
}

export function createAxisApp(deps: AxisAppDeps) {
  const now = deps.now ?? Date.now;
  const app = new Hono();
  if (deps.logging) app.use(logger());

  app.get(AUTH_PATH, (c) => {
    const user = c.req.header("x-auth-user");
    const key = c.req.header("x-auth-key");
    if (!user || !key || !credentialsMatch(user, key, deps.username, deps.password)) {
      return c.text("Unauthorized", 401);
    }
    return c.body(null, 200, {
      "X-Auth-Token": mintToken(deps.tokenSecret, now()),
      "X-Storage-Url": `${deps.publicUrl}${STORAGE_PATH}`,
    });
  });

  app.use(`${STORAGE_PATH}/*`, async (c, next) => {
    if (!verifyToken(c.req.header("x-auth-token"), deps.tokenSecret, now())) {
      return c.text("Unauthorized", 401);
    }
    await next();
  });

  app.get(`${STORAGE_PATH}/:container/:object{.+}`, (c) => {
    const { container, object } = c.req.param();
    if (container !== "System") return c.text("Forbidden", 403);
    const document = SYSTEM_DOCUMENTS[object];
    if (document === undefined) return c.text("Not Found", 404);
    const json = JSON.stringify(document);
    return c.body(json, 200, { "Content-Type": "application/json", Etag: md5(json) });
  });

  app.put(`${STORAGE_PATH}/:container`, async (c) => {
    const { container } = c.req.param();
    if (FIXED_CONTAINERS.has(container)) return c.body(null, 202);
    const recording = parseRecordingName(container);
    if (!recording) return c.text("Bad Request", 400);
    const result = await deps.store.createRecording(recording, parseMeta(c.req.raw.headers));
    return c.body(null, result === "created" ? 201 : 202);
  });

  app.post(`${STORAGE_PATH}/:container`, async (c) => {
    const { container } = c.req.param();
    if (FIXED_CONTAINERS.has(container)) return c.body(null, 204);
    const updated = await deps.store.updateRecording(container, parseMeta(c.req.raw.headers));
    return updated ? c.body(null, 204) : c.text("Not Found", 404);
  });

  app.put(`${STORAGE_PATH}/:container/:object{.+}`, async (c) => {
    const { container, object } = c.req.param();
    const meta = parseMeta(c.req.raw.headers);
    if (container === "System") {
      await deps.store.upsertSystem(object, meta);
      return c.body(null, 201);
    }
    if (container === "Users") {
      await deps.store.upsertCameraUser(object, meta);
      return c.body(null, 201);
    }
    if (container === "Devices") {
      await deps.store.upsertDevice(object, meta);
      return c.body(null, 201);
    }
    const result = await deps.store.putObject({
      recording: container,
      name: object,
      kind: classifyObject(object),
      meta,
      body: c.req.raw.body,
      contentType: c.req.header("content-type"),
      sizeBytes: sizeFrom(c.req.header("content-length")),
    });
    return result === "created" ? c.body(null, 201) : c.text("Not Found", 404);
  });

  app.post(`${STORAGE_PATH}/:container/:object{.+}`, async (c) => {
    const { container, object } = c.req.param();
    const meta = parseMeta(c.req.raw.headers);
    if (container === "System") {
      await deps.store.upsertSystem(object, meta);
      return c.body(null, 202);
    }
    if (container === "Users") {
      await deps.store.upsertCameraUser(object, meta);
      return c.body(null, 202);
    }
    if (container === "Devices") {
      await deps.store.upsertDevice(object, meta);
      return c.body(null, 202);
    }
    const updated = await deps.store.updateObject(container, object, meta);
    return updated ? c.body(null, 202) : c.text("Not Found", 404);
  });

  return app;
}
