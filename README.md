# Traced

A content destination for Axis body worn cameras. A worker wears the camera in a vest; when the
camera docks, the AXIS W800 system controller pushes every recording here, and it lands in
Supabase — the clip in Storage, the who/when/where in Postgres.

Recordings are not live-streamed. The W800 offloads them after docking, one HTTPS push at a time,
speaking a small subset of the OpenStack Swift API. This service is that server.

## Run it

```bash
cp .env.example .env.local        # then fill in the blanks
npm install
npm run dev
```

`CD_PUBLIC_URL` must be the address the W800 can reach on your network, not `localhost`.

## Connect a W800

```bash
npm run connection-file           # writes traced-connection.json
```

Upload that file in AXIS Body Worn Manager under **Content destination**. From then on, every
docked camera offloads to this service.

## Prove it without a camera

```bash
npm run dev                       # terminal 1
npm run fake-w800                 # terminal 2
```

`fake-w800` behaves like a system controller offloading one recording: it authenticates, registers
a user and a device, creates a recording, uploads a clip and a GPS trail, and marks it complete.
Check `recordings` and `recording_objects` in Supabase afterwards.

## Verify

```bash
npm run typecheck
npm test
npm run audit:comments
```

## Known limits of this slice

- HTTP only. The connection file carries no certificate, which the Axis spec allows for
  development and warns against for production. TLS is the next slice.
- No content encryption (`WantEncryption: false`).
- Supabase Storage on the free plan caps a single upload at 50 MB. Long clips will 500 until the
  plan or the upload path changes.
- Nothing analyses the footage yet. That is what the recording rows are for.
