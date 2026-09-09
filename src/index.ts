import { serve } from "@hono/node-server";
import { createAnalysisLoop } from "./analysis/loop.js";
import { createOpenAiExtractor } from "./analysis/extractor.js";
import { sampleFrames } from "./analysis/frames.js";
import { createApp, STORAGE_PATH } from "./app.js";
import { loadEnv } from "./env.js";
import { createSupabaseStore } from "./stores/supabase.js";

const env = loadEnv();
const store = createSupabaseStore(env);
const app = createApp({
  store,
  publicUrl: env.CD_PUBLIC_URL,
  username: env.CD_USERNAME,
  password: env.CD_PASSWORD,
  tokenSecret: env.CD_TOKEN_SECRET,
  logging: true,
});

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
      authUrl: `${env.CD_PUBLIC_URL}/auth/v1.0`,
      storageUrl: `${env.CD_PUBLIC_URL}${STORAGE_PATH}`,
      analysis: env.analysis.enabled ? env.analysis.model : false,
    }),
  );
});
