import { grantAccess } from "../src/access.js";
import { type ProjectRole, projectRoles } from "../src/db/schema.js";
import { loadEnv } from "../src/env.js";

const argv = process.argv.slice(2);
const flagAt = argv.indexOf("--role");
const positional = flagAt === -1 ? argv : [...argv.slice(0, flagAt), ...argv.slice(flagAt + 2)];
const [email, projectId] = positional;

function usage(problem: string): never {
  console.error(problem);
  console.error(
    `usage: npm run grant-access -- <email> [projectId] [--role ${projectRoles.join("|")}]`,
  );
  process.exit(1);
}

function asRole(value: string | undefined): ProjectRole {
  const role = projectRoles.find((candidate) => candidate === value);
  if (!role) usage(`not a project role: ${value}`);
  return role;
}

if (!email) usage("an email address is required");

const grant = await grantAccess(loadEnv(), {
  email,
  projectId,
  role: flagAt === -1 ? undefined : asRole(argv[flagAt + 1]),
  password: process.env.GRANT_PASSWORD,
});

console.log(
  JSON.stringify({
    event: "access_granted",
    project: grant.project,
    user: grant.user,
    role: grant.role,
    previousRole: grant.previousRole,
    membershipCreated: grant.membershipCreated,
    password: grant.password,
  }),
);
