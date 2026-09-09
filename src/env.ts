import { z } from "zod";

const booleanish = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const schema = z
  .object({
    PORT: z.coerce.number().int().positive().default(8080),
    CD_PUBLIC_URL: z.url(),
    CD_USERNAME: z.string().min(1),
    CD_PASSWORD: z.string().min(8),
    CD_TOKEN_SECRET: z.string().min(16),
    SUPABASE_URL: z.url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    DATABASE_URL: z.string().min(1),
    RECORDINGS_BUCKET: z.string().min(1).default("recordings"),
    ANALYSIS_ENABLED: booleanish,
    ANALYSIS_POLL_MS: z.coerce.number().int().positive().default(15_000),
    ANALYSIS_MAX_FRAMES: z.coerce.number().int().positive().default(24),
    ANALYSIS_SCENE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.4),
    ANALYSIS_FRAME_WIDTH: z.coerce.number().int().positive().default(768),
    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_MODEL: z.string().min(1).default("gpt-5.5"),
  })
  .refine((env) => !env.ANALYSIS_ENABLED || Boolean(env.OPENAI_API_KEY), {
    message: "OPENAI_API_KEY is required unless ANALYSIS_ENABLED=false",
    path: ["OPENAI_API_KEY"],
  })
  .transform((env) => ({
    ...env,
    analysis:
      env.ANALYSIS_ENABLED && env.OPENAI_API_KEY
        ? ({
            enabled: true,
            apiKey: env.OPENAI_API_KEY,
            model: env.OPENAI_MODEL,
            pollMs: env.ANALYSIS_POLL_MS,
            maxFrames: env.ANALYSIS_MAX_FRAMES,
            sceneThreshold: env.ANALYSIS_SCENE_THRESHOLD,
            frameWidth: env.ANALYSIS_FRAME_WIDTH,
          } as const)
        : ({ enabled: false } as const),
  }));

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return schema.parse(source);
}
