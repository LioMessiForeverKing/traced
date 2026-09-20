import { z } from "zod";

const blankAsAbsent = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

function setting<T extends z.ZodType>(inner: T) {
  return z.preprocess(blankAsAbsent, inner);
}

const booleanish = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const AXIS_FIELDS = {
  CD_PUBLIC_URL: z.url(),
  CD_USERNAME: z.string().min(1),
  CD_PASSWORD: z.string().min(8),
  CD_TOKEN_SECRET: z.string().min(16),
} as const;

const schema = z
  .object({
    PORT: setting(z.coerce.number().int().positive().default(8080)),
    AXIS_ENABLED: setting(booleanish),
    CD_PUBLIC_URL: setting(z.string().optional()),
    CD_USERNAME: setting(z.string().optional()),
    CD_PASSWORD: setting(z.string().optional()),
    CD_TOKEN_SECRET: setting(z.string().optional()),
    PROJECT_ID: z.uuid(),
    SUPABASE_URL: z.url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    DATABASE_URL: z.string().min(1),
    RECORDINGS_BUCKET: setting(z.string().min(1).default("recordings")),
    ANALYSIS_ENABLED: setting(booleanish),
    ANALYSIS_POLL_MS: setting(z.coerce.number().int().positive().default(15_000)),
    ANALYSIS_MAX_FRAMES: setting(z.coerce.number().int().positive().default(24)),
    ANALYSIS_SCENE_THRESHOLD: setting(z.coerce.number().min(0).max(1).default(0.4)),
    ANALYSIS_FRAME_WIDTH: setting(z.coerce.number().int().positive().default(768)),
    OPENAI_API_KEY: setting(z.string().optional()),
    OPENAI_MODEL: setting(z.string().min(1).default("gpt-5.5")),
  })
  .superRefine((env, ctx) => {
    if (env.AXIS_ENABLED) {
      for (const [key, field] of Object.entries(AXIS_FIELDS)) {
        const value = env[key as keyof typeof AXIS_FIELDS];
        if (value === undefined) {
          ctx.addIssue({
            code: "custom",
            message: `${key} is required unless AXIS_ENABLED=false`,
            path: [key],
          });
          continue;
        }
        const parsed = field.safeParse(value);
        if (parsed.success) continue;
        for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: [key] });
      }
    }
    if (env.ANALYSIS_ENABLED && !env.OPENAI_API_KEY) {
      ctx.addIssue({
        code: "custom",
        message: "OPENAI_API_KEY is required unless ANALYSIS_ENABLED=false",
        path: ["OPENAI_API_KEY"],
      });
    }
  })
  .transform((env) => ({
    ...env,
    axis:
      env.AXIS_ENABLED && env.CD_PUBLIC_URL && env.CD_USERNAME && env.CD_PASSWORD && env.CD_TOKEN_SECRET
        ? ({
            enabled: true,
            publicUrl: env.CD_PUBLIC_URL,
            username: env.CD_USERNAME,
            password: env.CD_PASSWORD,
            tokenSecret: env.CD_TOKEN_SECRET,
          } as const)
        : ({ enabled: false } as const),
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
