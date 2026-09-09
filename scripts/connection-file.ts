import { writeFileSync } from "node:fs";
import { loadEnv } from "../src/env.js";

const env = loadEnv();
const version = process.env.npm_package_version ?? "0.1.0";

const connectionFile = {
  ConnectionFileVersion: "1.0",
  SiteName: `Traced (${new URL(env.CD_PUBLIC_URL).host})`,
  ApplicationName: "Traced content destination",
  ApplicationVersion: version,
  ContentDestinationAsNTPServer: false,
  AuthenticationTokenURI: [`${env.CD_PUBLIC_URL}/auth/v1.0`],
  BlobAPIKey: env.CD_PASSWORD,
  BlobAPIUserName: env.CD_USERNAME,
  ContainerType: "mp4",
  FullStoreAndReadSupport: false,
  WantEncryption: false,
};

const outPath = process.argv[2] ?? "traced-connection.json";
writeFileSync(outPath, JSON.stringify(connectionFile, null, 2));
console.log(JSON.stringify({ event: "connection_file_written", path: outPath, authUrl: connectionFile.AuthenticationTokenURI[0] }));
