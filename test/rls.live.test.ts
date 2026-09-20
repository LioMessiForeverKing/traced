import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!databaseUrl || !supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "test:rls runs against the real project: DATABASE_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set",
  );
}

const stamp = `rls-test-${randomUUID()}`;
const prefix = `${stamp}%`;

const db = postgres(databaseUrl, { prepare: false });
const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

interface Visibility {
  projects: number;
  members: number;
  systems: number;
  cameraUsers: number;
  devices: number;
  recordings: number;
  objects: number;
  events: number;
}

const site = { a: "", b: "" };
const account = { alice: "", bob: "", viewer: "", outsider: "", boss: "" };

async function createAccount(label: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `${stamp}-${label}@traced.invalid`,
    password: randomUUID(),
    email_confirm: true,
  });
  if (error) throw error;
  return data.user.id;
}

async function seedSite(name: string): Promise<string> {
  const [project] = await db`
    insert into projects (name) values (${`${stamp} ${name}`}) returning id
  `;
  const projectId = project.id as string;
  const suffix = name.toLowerCase();
  await db`
    insert into bws_systems (id, project_id, meta)
    values (${`${stamp}-sys-${suffix}`}, ${projectId}, '{}'::jsonb)
  `;
  await db`
    insert into camera_users (id, project_id, meta)
    values (${`${stamp}-cu-${suffix}`}, ${projectId}, '{}'::jsonb)
  `;
  await db`
    insert into devices (serial, project_id, meta)
    values (${`${stamp}-dev-${suffix}`}, ${projectId}, '{}'::jsonb)
  `;
  const recording = `${stamp}-rec-${suffix}`;
  await db`
    insert into recordings (name, project_id, status, meta)
    values (${recording}, ${projectId}, 'complete', '{}'::jsonb)
  `;
  await db`
    insert into recording_objects (recording_name, name, kind, storage_path, meta)
    values (${recording}, 'clip.mp4', 'clip', ${`${recording}/clip.mp4`}, '{}'::jsonb)
  `;
  await db`
    insert into recording_events (recording_name, offset_seconds, description, confidence, frame_offsets)
    values (${recording}, 1.5, 'a worker ties off', 0.9, array[1.5])
  `;
  return projectId;
}

async function visibleTo(userId: string | null): Promise<Visibility> {
  return db.begin(async (tx) => {
    if (userId) {
      const claims = JSON.stringify({ sub: userId, role: "authenticated" });
      await tx`select set_config('request.jwt.claims', ${claims}, true)`;
      await tx`select set_config('role', 'authenticated', true)`;
    } else {
      await tx`select set_config('role', 'anon', true)`;
    }
    const [row] = await tx`
      select
        (select count(*) from projects where name like ${prefix}) as projects,
        (select count(*) from project_members where project_id in (${site.a}, ${site.b})) as members,
        (select count(*) from bws_systems where id like ${prefix}) as systems,
        (select count(*) from camera_users where id like ${prefix}) as camera_users,
        (select count(*) from devices where serial like ${prefix}) as devices,
        (select count(*) from recordings where name like ${prefix}) as recordings,
        (select count(*) from recording_objects where recording_name like ${prefix}) as objects,
        (select count(*) from recording_events where recording_name like ${prefix}) as events
    `;
    return {
      projects: Number(row.projects),
      members: Number(row.members),
      systems: Number(row.systems),
      cameraUsers: Number(row.camera_users),
      devices: Number(row.devices),
      recordings: Number(row.recordings),
      objects: Number(row.objects),
      events: Number(row.events),
    };
  });
}

const nothing: Visibility = {
  projects: 0,
  members: 0,
  systems: 0,
  cameraUsers: 0,
  devices: 0,
  recordings: 0,
  objects: 0,
  events: 0,
};

const oneSite: Visibility = {
  projects: 1,
  members: 1,
  systems: 1,
  cameraUsers: 1,
  devices: 1,
  recordings: 1,
  objects: 1,
  events: 1,
};

const sharedSite: Visibility = { ...oneSite, members: 2 };

const everySite: Visibility = {
  projects: 2,
  members: 3,
  systems: 2,
  cameraUsers: 2,
  devices: 2,
  recordings: 2,
  objects: 2,
  events: 2,
};

const theRecordOnly: Visibility = {
  projects: 1,
  members: 0,
  systems: 0,
  cameraUsers: 0,
  devices: 0,
  recordings: 1,
  objects: 0,
  events: 1,
};

beforeAll(async () => {
  account.alice = await createAccount("alice");
  account.bob = await createAccount("bob");
  account.viewer = await createAccount("viewer");
  account.outsider = await createAccount("outsider");
  account.boss = await createAccount("boss");
  site.a = await seedSite("A");
  site.b = await seedSite("B");
  await db`
    insert into project_members (project_id, user_id, role)
    values
      (${site.a}, ${account.alice}, 'member'),
      (${site.b}, ${account.bob}, 'member'),
      (${site.a}, ${account.viewer}, 'viewer')
  `;
  await db`insert into platform_admins (user_id) values (${account.boss})`;
});

afterAll(async () => {
  await db`delete from platform_admins where user_id = ${account.boss}`;
  await db`delete from recordings where name like ${prefix}`;
  await db`delete from bws_systems where id like ${prefix}`;
  await db`delete from camera_users where id like ${prefix}`;
  await db`delete from devices where serial like ${prefix}`;
  await db`delete from project_members where project_id in (${site.a}, ${site.b})`;
  await db`delete from projects where name like ${prefix}`;
  for (const id of Object.values(account)) {
    if (id) await admin.auth.admin.deleteUser(id);
  }
  await db.end();
});

describe("row level security", () => {
  it("shows a member every table for their own project", async () => {
    expect(await visibleTo(account.alice)).toEqual(sharedSite);
  });

  it("hides another project entirely from a member", async () => {
    const [names, recordings] = await db.begin(async (tx) => {
      const claims = JSON.stringify({ sub: account.alice, role: "authenticated" });
      await tx`select set_config('request.jwt.claims', ${claims}, true)`;
      await tx`select set_config('role', 'authenticated', true)`;
      return [
        await tx`select id from projects where name like ${prefix}`,
        await tx`select name from recordings where name like ${prefix}`,
      ];
    });
    expect(names.map((row) => row.id)).toEqual([site.a]);
    expect(recordings.map((row) => row.name)).toEqual([`${stamp}-rec-a`]);
  });

  it("shows the other member their own project and only theirs", async () => {
    expect(await visibleTo(account.bob)).toEqual(oneSite);
  });

  it("shows an insurance viewer the record and none of the site around it", async () => {
    expect(await visibleTo(account.viewer)).toEqual(theRecordOnly);
  });

  it("shows the viewer their own project, not the one next door", async () => {
    const [names] = await db.begin(async (tx) => {
      const claims = JSON.stringify({ sub: account.viewer, role: "authenticated" });
      await tx`select set_config('request.jwt.claims', ${claims}, true)`;
      await tx`select set_config('role', 'authenticated', true)`;
      return [await tx`select id from projects where name like ${prefix}`];
    });
    expect(names.map((row) => row.id)).toEqual([site.a]);
  });

  it("shows a platform admin every project, without a membership row anywhere", async () => {
    expect(await visibleTo(account.boss)).toEqual(everySite);

    const [memberships] = await db`
      select count(*) as count from project_members where user_id = ${account.boss}
    `;
    expect(Number(memberships.count)).toBe(0);
  });

  it("shows an admin the admin roster, and shows a member none of it", async () => {
    const seen = async (userId: string) =>
      db.begin(async (tx) => {
        const claims = JSON.stringify({ sub: userId, role: "authenticated" });
        await tx`select set_config('request.jwt.claims', ${claims}, true)`;
        await tx`select set_config('role', 'authenticated', true)`;
        const [row] = await tx`
          select count(*) as count from platform_admins where user_id = ${account.boss}
        `;
        return Number(row.count);
      });

    expect(await seen(account.boss)).toBe(1);
    expect(await seen(account.alice)).toBe(0);
    expect(await seen(account.viewer)).toBe(0);
  });

  it("refuses a platform admin's write, because only the service role writes", async () => {
    await expect(
      db.begin(async (tx) => {
        const claims = JSON.stringify({ sub: account.boss, role: "authenticated" });
        await tx`select set_config('request.jwt.claims', ${claims}, true)`;
        await tx`select set_config('role', 'authenticated', true)`;
        await tx`
          insert into recording_events (recording_name, offset_seconds, description, confidence, frame_offsets)
          values (${`${stamp}-rec-a`}, 3.0, 'invented by the admin browser', 1.0, array[3.0])
        `;
      }),
    ).rejects.toThrow();
  });

  it("shows a signed-in non-member nothing", async () => {
    expect(await visibleTo(account.outsider)).toEqual(nothing);
  });

  it("shows an anonymous visitor nothing", async () => {
    expect(await visibleTo(null)).toEqual(nothing);
  });

  it("refuses a member's write, because only the service role writes", async () => {
    await expect(
      db.begin(async (tx) => {
        const claims = JSON.stringify({ sub: account.alice, role: "authenticated" });
        await tx`select set_config('request.jwt.claims', ${claims}, true)`;
        await tx`select set_config('role', 'authenticated', true)`;
        await tx`
          insert into recording_events (recording_name, offset_seconds, description, confidence, frame_offsets)
          values (${`${stamp}-rec-a`}, 2.0, 'invented by the browser', 1.0, array[2.0])
        `;
      }),
    ).rejects.toThrow();
  });
});
