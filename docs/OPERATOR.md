# Running Traced on a real site

For the person who has the hardware in front of them: a W800 system controller, a docking
station, and at least one body worn camera. It takes you from an empty Supabase project to a
docked camera whose footage lands in the record.

It assumes you can run commands in a terminal and edit a file. It does not assume you have read
any of this repository's code.

## How to read the markers

**⚠ means nobody has ever performed this step.**

The server half of this document has been run many times against the live Supabase project,
including a real construction clip that went the whole way through to extracted events. The
hardware half has never been done. No W800, no docking station and no camera have ever been
touched by anyone working on this. Every step marked ⚠ is drawn from a published Axis document,
and the document it came from is named beside it.

If a marked step does not match what is actually on your screen, **the doc is wrong, not you.**
Write down what you saw and send it back — that is the single most valuable thing you can give
this project right now. See [What we want to hear back](#what-we-want-to-hear-back).

---

## Before anything: the system locks to one destination

> "The body worn system is locked to a content destination once connected to it. To change to
> another content destination, you need to reset the body worn system first."
>
> — [AXIS body worn solution, user manual](https://help.axis.com/en-us/axis-body-worn-solution)

Read that twice. It is the only genuinely irreversible act in this whole procedure.

The moment the W800 accepts a connection file, that system belongs to that content destination.
Pointing it somewhere else later is not a settings change — it is a **factory reset of the entire
body worn system**, which means removing every camera and every extension controller first, and
starting over.

The same manual adds:

> "Never remove or reset the content destination before resetting the body worn system."

Two things follow, and they shape the order of everything below.

1. **Stand the intake up completely, and prove it, before the W800 ever sees it.** Part 1 finishes
   with a full end-to-end rehearsal that needs no camera. Do not skip it to save twenty minutes.
2. **The address in the connection file is close to permanent.** Whatever host and port you put in
   `CD_PUBLIC_URL` is what the controller will keep trying to reach, so decide it deliberately —
   see [Part 2](#part-2--put-it-somewhere-the-w800-can-reach). A laptop on DHCP is fine for a bench
   test and wrong for a site.

## What you need

**Hardware**

- An AXIS W800 system controller
- A docking station, connected to the **Docking stations** port on the controller
- At least one body worn camera (a W120 is what this was designed around)
- A computer on the same network as the controller
- An RFID reader, only if you want cameras self-assigned rather than fixed to a user

**Accounts and keys**

- A Supabase project. **On the free plan a single upload is capped at 50 MB and total storage at
  1 GB** — a real shift will blow through both and the upload will fail with a 500. A real
  deployment needs the Pro plan. A bench test with a short clip does not.
- An OpenAI API key, unless you set `ANALYSIS_ENABLED=false` and are only testing the offload.
- Node 22 or newer, and `git`.

**The one thing you do not need:** an Axis API key. There isn't one. This server is not a client of
Axis — the W800 is a client of *us*, and it authenticates with a username and password that you
mint yourself in Part 1.

---

## Part 1 — Stand up the intake

Nothing here involves the hardware, and all of it has been run for real.

### 1. Get the code and its dependencies

```bash
git clone https://github.com/LioMessiForeverKing/traced.git
cd traced
npm install
```

`ffmpeg` comes in with `npm install` via `ffmpeg-static`. You do not need a system one.

### 2. Create the Supabase project and a bucket

Create a project, then a **private** Storage bucket named `recordings`. Private matters: the
policies in this repo assume nothing is publicly readable, and a public bucket would hand a URL to
anyone who guessed a recording name.

### 3. Fill in the configuration

```bash
cp .env.example .env.local
```

Then edit `.env.local`. The values that need thought:

| Variable | What to put in it |
|---|---|
| `CD_PUBLIC_URL` | The address **the W800 will use**, not `localhost`. Settled in [Part 2](#part-2--put-it-somewhere-the-w800-can-reach). |
| `CD_USERNAME` / `CD_PASSWORD` | Invent them. These are the credentials the controller uses to log in to you. The password must be at least 8 characters and goes into the connection file in clear text, so treat that file as a secret. |
| `CD_TOKEN_SECRET` | A random string of at least 16 characters. It signs the 15-minute session tokens the controller gets. Never reuse one across sites. |
| `PROJECT_ID` | The construction site this intake serves. See below. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` | From the Supabase dashboard. The service-role key is a full-access credential — it lives only here, on the server, and never goes near a browser. |
| `OPENAI_API_KEY` | Required unless `ANALYSIS_ENABLED=false`. |

`.env.local` is gitignored. Keep it that way.

**About `PROJECT_ID`.** The Axis protocol has no concept of a construction site, so it cannot be
read off the wire — this intake stamps its own project onto every row it writes. **One deployment
serves one W800, which serves one site.** The migrations seed a `Bootstrap project` at
`00000000-0000-4000-8000-000000000001`, which is fine for a bench test. A real site gets its own
row:

```sql
insert into projects (name) values ('Riverside Tower — Phase 2') returning id;
```

Put that id in `PROJECT_ID`.

### 4. Apply the migrations

The SQL in `drizzle/` runs in numeric order against your project's database. Apply `0000` through
`0006`. Afterwards every table has row level security on with exactly one `SELECT` policy, and the
`recordings` bucket has a matching one.

### 5. Start it

```bash
npm run dev
```

It logs to stdout as newline-delimited JSON. Leave it running.

### 6. Rehearse the entire offload, with no camera

**This is the step that makes the hardware step safe, and it is the reason Part 1 exists.**

```bash
npm run fake-w800 -- http://localhost:8080 ./some-clip.mp4
```

`fake-w800` impersonates a system controller performing a complete offload: it authenticates, asks
for capabilities, registers a user and a device, creates a recording container, uploads a clip and
a GPS trail, and marks the recording `Complete`. It exercises the same code path a real W800 will.

Give it a real MP4. Any short video will do — construction footage if you have it, since that also
tells you something about the analysis. If you omit the path it sends synthetic bytes, which land
correctly but fail analysis with `moov atom not found`, because they are not a video.

**What success looks like:** a row in `recordings` with `analysis_status` moving `pending` →
`done`, two objects in the `recordings` bucket, and rows in `recording_events` describing what is
in the clip.

If this does not work, **stop**. A real camera will not fix it, and you would be spending the one
irreversible act of this procedure on a server you have not proved.

### 7. Let a person see it

Nothing browser-facing shows anything until a real account is a member of the project. `auth.users`
starts empty, and a member of nothing correctly sees nothing at all.

```bash
npm run grant-access -- site.manager@example.com
```

It creates the account, adds it to `PROJECT_ID`, and prints the generated password once. Sign in at
the dashboard with it and confirm the rehearsed recording is visible.

For the insurance side, who should see the record of the work but never the footage of the workers:

```bash
npm run grant-access -- insurance@example.com --role viewer
```

The difference between the two roles is in [the README](../README.md#who-can-read-what).

---

## Part 2 — Put it somewhere the W800 can reach

This is where a bench test and a site diverge, and it is the most likely thing to go wrong.

`CD_PUBLIC_URL` is not cosmetic. After the controller authenticates, **the server hands that URL
back as the address to upload to.** If it is wrong, the offload will authenticate successfully and
then hang trying to reach storage — which reads like a network fault and is actually a config
typo. It is also, per the lock described above, close to permanent.

**It must not be `localhost` or `127.0.0.1`.** Those mean "this machine" to whoever reads them, and
the machine reading them is the W800.

Choose one:

- **Bench test, same LAN.** Give the machine running the intake a static IP or a DHCP reservation,
  and use `http://<that-ip>:8080`. A laptop that changes address overnight will silently stop
  receiving offloads.
- **Real site.** A host with a stable name that the site network resolves and can route to. This is
  a long-running Node process holding a single HTTP PUT of hundreds of megabytes — **it cannot be
  deployed to Vercel or any serverless platform**, which cap request bodies in single-digit
  megabytes. A small always-on box is the right shape.

Confirm from a *different* machine on the same network as the controller, before going further:

```bash
curl -i http://<host>:8080/auth/v1.0
```

A `401` is the correct and healthy answer — it means you reached the intake and it asked who you
are. A timeout or "connection refused" means the W800 will not get through either. Fix that now.

### About HTTP

This intake currently speaks plain HTTP. The Axis specification is direct about it:

> "We strongly recommend using HTTPS for all production purposes and only use HTTP for
> development/debugging."
>
> — [Body Worn Integration API](https://github.com/AxisCommunications/body-worn-integration-api)

TLS works by putting a base64 X.509 certificate in the connection file's `HTTPSCertificate` field,
which the controller then validates. **`npm run connection-file` does not emit that field yet**, so
every connection file this repo produces is an HTTP one. That is a known gap, recorded in the
README, and it is the next piece of work on the intake.

⚠ **Whether a shipping W800 will actually accept a plain-HTTP content destination is unknown to
us.** The spec permits it for development; no one here has watched a real controller decide. If it
refuses, that is a finding worth reporting immediately — it blocks every hardware test until TLS
lands.

---

## Part 3 — Connect the W800

> **Everything in this part is ⚠.** The steps come from the
> [AXIS body worn solution user manual](https://help.axis.com/en-us/axis-body-worn-solution) and
> the [Body Worn Integration API](https://github.com/AxisCommunications/body-worn-integration-api).
> Nobody working on this repository has performed any of it.

### 1. Generate the connection file — before you start the wizard

```bash
npm run connection-file
```

This writes `traced-connection.json` from your `.env.local`. Generate it **now**, because the
content destination is configured *inside* the first-run setup wizard, and you do not want to be
hunting for a terminal halfway through the one irreversible step.

It contains your `CD_PASSWORD` in clear text. Move it like a password.

What the file says, and why:

| Field | Value | Meaning |
|---|---|---|
| `AuthenticationTokenURI` | `<CD_PUBLIC_URL>/auth/v1.0` | Where the controller logs in. The one address that must be right. |
| `BlobAPIUserName` / `BlobAPIKey` | your `CD_USERNAME` / `CD_PASSWORD` | How it logs in. |
| `ContainerType` | `mp4` | The spec defaults to `mkv`; the analysis wants `mp4`. |
| `ContentDestinationAsNTPServer` | `false` | We do not serve time. See the clock warning below. |
| `WantEncryption` | `false` | No end-to-end content encryption. |
| `FullStoreAndReadSupport` | `false` | The system cannot read recordings back out of us. |
| `HTTPSCertificate` | *absent* | Hence HTTP. See above. |

### 2. Cable it up

⚠ Connect the system controller to the network, the docking station to the **Docking stations**
port on the controller, the RFID reader if you are using self-assignment, and your computer to the
same network. Power everything on.

### 3. Find the controller and open AXIS Body Worn Manager

⚠ Locate the system controller on the network with **AXIS IP Utility**, then open it in a browser.
The setup assistant starts on its own the first time.

### 4. Work through the setup wizard

⚠ The manual gives this order:

1. **Create a new system** (not *Extend an existing system*).
2. Choose **Standard** or **Evaluation** mode.
3. Create the administrator account. The username is `root`.
4. Install the latest device software.
5. Name the system.
6. Configure network settings.
7. **Connect to content destination** — this is the step this whole document exists for. Upload
   `traced-connection.json` here. **This is the irreversible one.**
8. Set the **Super admin passphrase**.
9. **Download the System restore key.** Keep it somewhere you will still have it in a year; without
   it, some recovery paths are closed.
10. Select country and power line frequency.
11. Choose the camera assignment method — **Fixed** (a camera belongs to one user) or **Self-assign**
    (a worker taps an RFID tag and gets whichever camera is free).
12. Set date and time.

**Watch the clock step.** ⚠ By default the system takes time from an NTP server provided by DHCP.
Our connection file sets `ContentDestinationAsNTPServer: false`, so we are not that server, and
nothing in this repo corrects a controller whose clock is wrong. Every timestamp in the record —
the recording name, the event offsets, the whole evidentiary value of the thing — inherits that
clock. **A record with the wrong time on it is worse than no record**, because it is confidently
wrong. Confirm the site has working NTP before you accept this screen.

### 5. Add cameras, users, and assignments

⚠ After the wizard, in AXIS Body Worn Manager:

1. **Add cameras** — dock them, then add them in the manager.
2. **Add users** — create or import them. These are Axis identities for the people wearing the
   cameras. They are *not* logins for the dashboard, and they have no relation to the accounts
   `grant-access` creates. They land in this system as `camera_users`.
3. **Assign users to cameras** — for fixed assignment: **Cameras**, open a camera, pick a user from
   the **Assigned user** list. For self-assign, the worker taps their RFID tag instead.
4. **Edit camera profiles** if you need to.

### Changing the connection file later

⚠ If the intake's address changes — and note again that this does not let you change *destinations*,
only update the file for the same one:

> "Go to **Settings**. Click [the configuration icon] under **Configuration** for your content
> destination. Upload the new connection file. Click **Save**."

---

## Part 4 — The first real offload

Record something short and deliberate. Thirty seconds of someone walking a corridor is plenty for a
first test, and it is far easier to check an extracted event against footage you remember shooting.

Then **dock the camera** and watch the intake's stdout.

What should happen, in order:

1. The controller authenticates at `/auth/v1.0` and gets a token good for 15 minutes.
2. It registers its system, the device and the camera user.
3. It creates a recording container, then `PUT`s the clip — one long request, hundreds of megabytes
   for a real shift.
4. A GPS trail follows, if the camera recorded one.
5. It marks the recording `Status: Complete`.
6. Within `ANALYSIS_POLL_MS` (15 seconds by default) the analysis loop claims the row, pulls frames,
   sends them to OpenAI, and writes `recording_events`.

Then sign in to the dashboard and open it. If there are events on the timeline that match what you
filmed, the whole chain works and you are the first person to have proved it.

### What to check while you are there

- Does **`LENGTH` match the actual clip**? It shows the duration the W800 *declares* in metadata,
  and nothing in this repo yet checks that against the video's real duration. A record whose stated
  length contradicts its own footage is exactly what an opposing expert would enjoy finding. If
  they disagree, say so.
- **Are the events any good?** They have been checked against exactly one real construction clip.
  Your footage is the second data point in existence, and the honest answer for body worn video
  from a moving worker is that nobody knows yet.
- **Is the frame sampling covering the clip?** Body worn footage is one continuous shot and never
  cuts, so scene detection alone finds almost nothing in it. Frames are also taken at
  `duration ÷ ANALYSIS_MAX_FRAMES` intervals, which is what covers the whole recording. The default
  `ANALYSIS_SCENE_THRESHOLD` of `0.4` is ffmpeg's conventional scene-cut figure, calibrated for
  footage with hard cuts, which this is not — so it contributes almost nothing on body worn video
  and the interval does the work. Lowering it is safe but it is not the fix for a long clip that
  produced events only near the start. Report that symptom rather than tuning it away — on real body
  worn footage nobody has seen it yet, and what it means is worth knowing.

---

## When it goes wrong

| What you see | What it usually is | What to do |
|---|---|---|
| Controller authenticates, then the upload hangs or times out | `CD_PUBLIC_URL` is wrong or unreachable — the single most common failure | `curl -i http://<host>:8080/auth/v1.0` from another machine on the controller's network. A `401` is correct; anything else is the problem. |
| `401` when the controller tries to log in | `CD_USERNAME` / `CD_PASSWORD` no longer match the connection file | Regenerate with `npm run connection-file` and re-upload it. |
| Upload fails around 50 MB | Supabase free plan's per-upload cap | Upgrade to Pro. No code change helps. |
| `analysis_status` is `failed` | Almost never the clip. An OpenAI outage, a network blip, a timeout | Nothing to do. It retries three times, ten minutes apart; `analysis_attempts` counts them. **The footage is intact in Storage either way** — a failed analysis never means lost evidence. |
| `moov atom not found` | Not a real video — usually `fake-w800` with no clip argument | Pass a real MP4. |
| Dashboard is empty but rows exist in Supabase | The signed-in account is a member of nothing, or of a different project | `npm run grant-access -- <email>`. It defaults to `PROJECT_ID`, which is the project this intake is actually stamping on its rows. |
| A `viewer` cannot play a clip | Working as designed | Viewers read the record and never reach the footage. Grant `member` if that person should see video. |
| Events are all `zone: null` | Also working as designed | Zone is only ever read off a sign or level marker visible in frame. The model is instructed not to invent one. |

For a deeper check of the access rules against your live project:

```bash
npm run test:rls
```

Three live suites, 19 tests. It needs real credentials, which is why it is not in CI. Run it after
any policy change, and before trusting a deployment with anything real.

---

## What we want to hear back

You are the first person to run this against hardware. The most useful things you can report, in
order:

1. **Did a shipping W800 accept a plain-HTTP content destination?** If not, TLS becomes the blocking
   piece of work and everything else waits.
2. **Every ⚠ step that did not match your screen.** Menu names, ordering, anything the wizard asked
   that is not listed here.
3. **Whether a W120 docks and offloads through this controller at all**, and what the logs said
   while it did.
4. **Whether the extracted events describe the work honestly.** Not whether they are impressive —
   whether they are *true*, and whether a claims adjuster would care about any of them.
5. **The declared `LENGTH` against the real clip duration.**

Anything that contradicts this document is more valuable than anything that confirms it.

---

## Related

- [README](../README.md) — what the intake is, how the analysis works, who can read what
- [AGENTS.md](../AGENTS.md) — the contract for changing this code
- [Body Worn Integration API](https://github.com/AxisCommunications/body-worn-integration-api) —
  the protocol specification this server implements
- [AXIS body worn solution user manual](https://help.axis.com/en-us/axis-body-worn-solution) —
  the source of every ⚠ step above
