import { z } from "zod";

const blankAsAbsent = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const booleanish = z.preprocess(
  blankAsAbsent,
  z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
);

function optionalText<T extends z.ZodType>(inner: T) {
  return z.preprocess(blankAsAbsent, inner.optional());
}

const AXIS_FIELDS = {
  CD_PUBLIC_URL: z.url(),
  CD_USERNAME: z.string().min(1),
  CD_PASSWORD: z.string().min(8),
  CD_TOKEN_SECRET: z.string().min(16),
} as const;

const schema = z
  .object({
    PORT: z.coerce.number().int().positive().default(8080),
    AXIS_ENABLED: booleanish,
    CD_PUBLIC_URL: optionalText(z.string()),
    CD_USERNAME: optionalText(z.string()),
    CD_PASSWORD: optionalText(z.string()),
    CD_TOKEN_SECRET: optionalText(z.string()),
    PROJECT_ID: z.uuid(),
    SUPABASE_URL: z.url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    DATABASE_URL: z.string().min(1),
    RECORDINGS_BUCKET: z.string().min(1).default("recordings"),
    ANALYSIS_ENABLED: booleanish,
    ANALYSIS_POLL_MS: z.coerce.number().int().positive().default(15_000),
    ANALYSIS_MAX_FRAMES: z.coerce.number().int().positive().default(24),
    ANALYSIS_SCENE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.4),
    ANALYSIS_FRAME_WIDTH: z.coerce.number().int().positive().default(768),
    OPENAI_API_KEY: optionalText(z.string().min(1)),
    OPENAI_MODEL: z.string().min(1).default("gpt-5.5"),
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
