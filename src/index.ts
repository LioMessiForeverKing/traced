import { serve } from "@hono/node-server";
import { createApp, STORAGE_PATH } from "./app.js";
import { loadEnv } from "./env.js";
import { createSupabaseStore } from "./stores/supabase.js";

const env = loadEnv();
const app = createApp({
  store: createSupabaseStore(env),
  publicUrl: env.CD_PUBLIC_URL,
  username: env.CD_USERNAME,
  password: env.CD_PASSWORD,
  tokenSecret: env.CD_TOKEN_SECRET,
  logging: true,
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(
    JSON.stringify({
      event: "listening",
      port: info.port,
      authUrl: `${env.CD_PUBLIC_URL}/auth/v1.0`,
      storageUrl: `${env.CD_PUBLIC_URL}${STORAGE_PATH}`,
    }),
  );
});
