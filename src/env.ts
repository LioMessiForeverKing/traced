import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  CD_PUBLIC_URL: z.url(),
  CD_USERNAME: z.string().min(1),
  CD_PASSWORD: z.string().min(8),
  CD_TOKEN_SECRET: z.string().min(16),
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  RECORDINGS_BUCKET: z.string().min(1).default("recordings"),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return schema.parse(source);
}
