import { writeFileSync } from "node:fs";
import { AUTH_PATH } from "../src/axis/index.js";
import { loadEnv } from "../src/env.js";

const env = loadEnv();
const axis = env.axis;
if (!axis.enabled) {
  console.error("A connection file points a W800 at this server, so it needs AXIS_ENABLED=true and the four CD_ values.");
  process.exit(1);
}

const version = process.env.npm_package_version ?? "0.1.0";

const connectionFile = {
  ConnectionFileVersion: "1.0",
  SiteName: `Traced (${new URL(axis.publicUrl).host})`,
  ApplicationName: "Traced content destination",
  ApplicationVersion: version,
  ContentDestinationAsNTPServer: false,
  AuthenticationTokenURI: [`${axis.publicUrl}${AUTH_PATH}`],
  BlobAPIKey: axis.password,
  BlobAPIUserName: axis.username,
  ContainerType: "mp4",
  FullStoreAndReadSupport: false,
  WantEncryption: false,
};

const outPath = process.argv[2] ?? "traced-connection.json";
writeFileSync(outPath, JSON.stringify(connectionFile, null, 2));
console.log(JSON.stringify({ event: "connection_file_written", path: outPath, authUrl: connectionFile.AuthenticationTokenURI[0] }));
