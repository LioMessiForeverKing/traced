import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createOpenAiExtractor } from "./analysis/extractor.js";
import { sampleFrames } from "./analysis/frames.js";
import { createAnalysisLoop } from "./analysis/loop.js";
import { AUTH_PATH, STORAGE_PATH, createAxisApp } from "./axis/index.js";
import { loadEnv } from "./env.js";
import { createSupabaseStore } from "./stores/supabase.js";

const env = loadEnv();
const store = createSupabaseStore(env);
const axis = env.axis;

const app = axis.enabled
  ? createAxisApp({
      store,
      publicUrl: axis.publicUrl,
      username: axis.username,
      password: axis.password,
      tokenSecret: axis.tokenSecret,
      logging: true,
    })
  : new Hono();

if (env.analysis.enabled) {
  createAnalysisLoop({
    store,
    extractor: createOpenAiExtractor({ apiKey: env.analysis.apiKey, model: env.analysis.model }),
    sampler: sampleFrames,
    maxFrames: env.analysis.maxFrames,
    sceneThreshold: env.analysis.sceneThreshold,
    frameWidth: env.analysis.frameWidth,
    pollMs: env.analysis.pollMs,
  }).start();
}

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(
    JSON.stringify({
      event: "listening",
      port: info.port,
      authUrl: axis.enabled ? `${axis.publicUrl}${AUTH_PATH}` : false,
      storageUrl: axis.enabled ? `${axis.publicUrl}${STORAGE_PATH}` : false,
      analysis: env.analysis.enabled ? env.analysis.model : false,
    }),
  );
});
