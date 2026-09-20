import { grantAccess, grantAdmin } from "../src/access.js";
import { loadEnv } from "../src/env.js";
import { USAGE, parseGrantArgs } from "./grant-access-args.js";

const args = parseGrantArgs(process.argv.slice(2));

if (args.kind === "invalid") {
  console.error(args.problem);
  console.error(USAGE);
  process.exit(1);
}

const env = loadEnv();
const password = process.env.GRANT_PASSWORD;

if (args.kind === "admin") {
  const grant = await grantAdmin(env, { email: args.email, password });
  console.log(
    JSON.stringify({
      event: "admin_granted",
      user: grant.user,
      adminCreated: grant.adminCreated,
      password: grant.password,
    }),
  );
} else {
  const grant = await grantAccess(env, {
    email: args.email,
    projectId: args.projectId,
    role: args.role,
    password,
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
}
