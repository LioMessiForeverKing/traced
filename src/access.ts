import { randomBytes } from "node:crypto";
import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { and, eq } from "drizzle-orm";
import { authUsers } from "drizzle-orm/supabase";
import { type Db, createDb } from "./db/client.js";
import { type ProjectRole, platformAdmins, projectMembers, projects } from "./db/schema.js";
import type { Env } from "./env.js";

export interface GrantRequest {
  email: string;
  projectId?: string;
  password?: string;
  role?: ProjectRole;
}

export interface AdminRequest {
  email: string;
  password?: string;
}

export interface Account {
  id: string;
  email: string;
  created: boolean;
}

export interface Grant {
  project: { id: string; name: string };
  user: Account;
  membershipCreated: boolean;
  role: ProjectRole;
  previousRole: ProjectRole | null;
  password: string | null;
}

export interface AdminGrant {
  user: Account;
  adminCreated: boolean;
  password: string | null;
}

function generatedPassword(): string {
  return randomBytes(18).toString("base64url");
}

function normalisedEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!email.includes("@")) throw new Error(`not an email address: ${value}`);
  return email;
}

function connect(env: Env): { db: Db; admin: SupabaseClient } {
  return {
    db: createDb(env.DATABASE_URL),
    admin: createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    }),
  };
}

async function findOrCreateUser(
  db: Db,
  admin: SupabaseClient,
  email: string,
  chosenPassword: string | undefined,
): Promise<{ user: Account; password: string | null }> {
  const [existing] = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.email, email));

  if (existing) return { user: { id: existing.id, email, created: false }, password: null };

  const password = chosenPassword ?? generatedPassword();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  return { user: { id: data.user.id, email, created: true }, password };
}

export async function grantAccess(env: Env, request: GrantRequest): Promise<Grant> {
  const email = normalisedEmail(request.email);
  const projectId = request.projectId ?? env.PROJECT_ID;
  const role = request.role ?? "member";
  const { db, admin } = connect(env);

  try {
    const [project] = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw new Error(`no project ${projectId}; check PROJECT_ID or insert the row first`);

    const { user, password } = await findOrCreateUser(db, admin, email, request.password);

    const [membership] = await db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, user.id)));

    await db
      .insert(projectMembers)
      .values({ projectId: project.id, userId: user.id, role })
      .onConflictDoUpdate({
        target: [projectMembers.projectId, projectMembers.userId],
        set: { role, updatedAt: new Date() },
      });

    return {
      project,
      user,
      membershipCreated: membership === undefined,
      role,
      previousRole: membership && membership.role !== role ? membership.role : null,
      password,
    };
  } finally {
    await db.$client.end();
  }
}

export async function grantAdmin(env: Env, request: AdminRequest): Promise<AdminGrant> {
  const email = normalisedEmail(request.email);
  const { db, admin } = connect(env);

  try {
    const { user, password } = await findOrCreateUser(db, admin, email, request.password);

    const [existing] = await db
      .select({ userId: platformAdmins.userId })
      .from(platformAdmins)
      .where(eq(platformAdmins.userId, user.id));

    await db.insert(platformAdmins).values({ userId: user.id }).onConflictDoNothing();

    return { user, adminCreated: existing === undefined, password };
  } finally {
    await db.$client.end();
  }
}
