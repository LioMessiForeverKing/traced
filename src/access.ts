import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { authUsers } from "drizzle-orm/supabase";
import { createDb } from "./db/client.js";
import { projectMembers, projects } from "./db/schema.js";
import type { Env } from "./env.js";

export interface GrantRequest {
  email: string;
  projectId?: string;
  password?: string;
}

export interface Grant {
  project: { id: string; name: string };
  user: { id: string; email: string; created: boolean };
  membershipCreated: boolean;
  password: string | null;
}

function generatedPassword(): string {
  return randomBytes(18).toString("base64url");
}

export async function grantAccess(env: Env, request: GrantRequest): Promise<Grant> {
  const email = request.email.trim().toLowerCase();
  if (!email.includes("@")) throw new Error(`not an email address: ${request.email}`);

  const projectId = request.projectId ?? env.PROJECT_ID;
  const db = createDb(env.DATABASE_URL);
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  try {
    const [project] = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw new Error(`no project ${projectId}; check PROJECT_ID or insert the row first`);

    const [existing] = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.email, email));

    let userId = existing?.id;
    let password: string | null = null;
    if (!userId) {
      password = request.password ?? generatedPassword();
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (error) throw error;
      userId = data.user.id;
    }

    const inserted = await db
      .insert(projectMembers)
      .values({ projectId: project.id, userId })
      .onConflictDoNothing()
      .returning({ userId: projectMembers.userId });

    return {
      project,
      user: { id: userId, email, created: password !== null },
      membershipCreated: inserted.length > 0,
      password,
    };
  } finally {
    await db.$client.end();
  }
}
