import { grantAccess } from "../src/access.js";
import { loadEnv } from "../src/env.js";

const [email, projectId] = process.argv.slice(2);
if (!email) {
  console.error("usage: npm run grant-access -- <email> [projectId]");
  process.exit(1);
}

const grant = await grantAccess(loadEnv(), {
  email,
  projectId,
  password: process.env.GRANT_PASSWORD,
});

console.log(
  JSON.stringify({
    event: "access_granted",
    project: grant.project,
    user: grant.user,
    membershipCreated: grant.membershipCreated,
    password: grant.password,
  }),
);
