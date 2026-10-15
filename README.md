# sourcify-live-stats

This service sends live verification data to the Sourcify landing page
(sourcify.dev). The page uses it to show two things:

- A counter of verified contracts that goes up in real time.
- A feed such as "0xab…cd on Base just verified".

The service sends the data to browsers with Server-Sent Events (SSE). SSE is a
plain HTTP response that stays open. The server writes small text events into
it, and the browser `EventSource` API reads them.

## How it works

The Sourcify server writes a log line each time it stores a new match. A
"match" is a verified contract. Google Cloud copies these log lines to a
Pub/Sub topic. Pub/Sub is the Google Cloud message queue. This service reads
the messages and sends events to browsers.

```
sourcify-<env>-server (Cloud Run, 8-13 instances)
  │ logs "Stored to SourcifyDatabase" after each new match
  ▼
Cloud Logging sink  sourcify-<env>-new-match
  │ copies only the matching log entries
  ▼
Pub/Sub topic       sourcify-<env>-new-match
  ▼
Pull subscription   sourcify-<env>-live-stats
  │ streaming pull
  ▼
THIS SERVICE        Cloud Run sourcify-<env>-live-stats (exactly 1 instance)
  │ GET /live/stream (SSE), through the load balancer
  ▼
Browsers on sourcify.dev
```

`<env>` is `staging` or `production`. All resources are in the GCP project
`sourcify-project`, region `europe-west1`.

The service keeps all data in memory. Nothing is stored on disk or in a
database. That is why it runs as exactly one instance: each instance would
otherwise have its own count.

### The total

Each match has an id from a Postgres sequence. The sequence only goes up. So
the newest match id is the number of matches. The service uses it as the
total. The total can be a little too high, because a sequence can skip
numbers. We accept that.

Messages from many server instances arrive out of order. The service keeps the
highest id that it saw. The total never goes down.

### Throttling

At busy times the server stores more than 100 matches per second. A browser
does not need that many events. So the service sends at most one event every
500 ms:

1. New matches go into a buffer.
2. Every 500 ms, if the buffer is not empty, the service picks one match. It
   prefers a match on a chain that is not in the last 5 shown items. If all
   chains in the buffer were shown recently, it picks the newest match.
3. The service clears the buffer and sends one event to all browsers.
4. If the buffer is empty, it sends nothing.

Each event carries the current total, so the counter stays correct even when
the feed skips matches.

## Log contract (input)

The Sourcify server writes this log entry after it stores a new match. The
code that writes it in the Sourcify server has a comment that points to this
repository. If you change the log message or its fields, change this service
too.

The logging sink selects entries with this filter:

```
resource.type="cloud_run_revision"
AND resource.labels.service_name="sourcify-<env>-server"
AND jsonPayload.message="Stored to SourcifyDatabase"
```

The Pub/Sub message body is the full Cloud Logging entry as JSON:

```json
{
  "jsonPayload": {
    "message": "Stored to SourcifyDatabase",
    "matchId": "56150969",
    "address": "0x0d89Cb4f4220B7BECB5A54f9e16De41a615987FC",
    "chainId": "8453",
    "runtimeMatch": "match",
    "creationMatch": null,
    "match": "match",
    "verifiedAt": "2026-10-15T09:57:56Z",
    "name": "MyToken",
    "service": "server",
    "timestamp": "2026-10-15T09:57:56.579Z"
  },
  "resource": {
    "type": "cloud_run_revision",
    "labels": { "service_name": "sourcify-staging-server" }
  },
  "timestamp": "2026-10-15T09:57:56.580196Z"
}
```

The service uses these fields from `jsonPayload`:

| Field        | Required | Notes                                                                           |
| ------------ | -------- | ------------------------------------------------------------------------------- |
| `matchId`    | yes      | A string or a number of digits.                                                 |
| `address`    | yes      | The contract address.                                                           |
| `chainId`    | yes      | A number or a string of digits.                                                 |
| `match`      | no       | `"exact_match"` or `"match"`.                                                   |
| `verifiedAt` | no       | The database time of the match. If it is missing, the service uses `timestamp`. |
| `timestamp`  | no       | If it is missing, the service uses the entry `timestamp`.                       |
| `name`       | no       | The contract name. Older server versions do not log it.                         |

If a message is not valid JSON, or if a required field is missing, the service
logs a warning and skips it. The service acknowledges ("acks") every message
at once, also the bad ones. An ack tells Pub/Sub not to send the message
again.

## SSE contract (output)

### `GET /live/stream`

Response headers:

```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
Access-Control-Allow-Origin: *
```

The data is public and read-only. The `Access-Control-Allow-Origin: *` header
lets a UI on `localhost` use the staging stream.

The stream starts with `retry: 5000`. This tells the browser to wait 5 seconds
before it connects again after a disconnect.

Each event uses the default event type (there is no `event:` line):

```
id: 56150969
data: {"total":56150969,"items":[{"matchId":"56150969","chainId":"8453","address":"0x0d89Cb4f4220B7BECB5A54f9e16De41a615987FC","match":"exact_match","verifiedAt":"2026-10-15T09:57:56Z","name":"MyToken"}]}
```

- `id` and `total` are the newest match id.
- `matchId` and `chainId` are strings.
- `verifiedAt` is an ISO 8601 time, or `null`. It has whole seconds when the
  server log has `verifiedAt`, and milliseconds when the service uses a log
  timestamp. So parse it as a date, and do not expect a fixed length.
- `name` is the contract name, or `null`. It is `null` when the log line has
  no name, or when the name is not a non-empty string. Log lines from older
  server versions have no name. The field is always in the item.

When a browser connects, and the total is known, the service sends one event at
once. That event has the last 30 shown items, newest first. After that, each
event has exactly one item.

After a restart the total is unknown until the first new match arrives. During
that time the service sends no events. The UI has a fallback for this case.

Every 20 seconds the service sends a comment line `: ping`. This keeps proxies
from closing an idle connection. `EventSource` ignores comments.

If the number of open streams reaches `MAX_CONNECTIONS`, the service answers
`503 Service Unavailable`. The browser tries again later.

Cloud Run closes each request after 1 hour (`--timeout=3600`). The browser then
connects again by itself.

### `GET /live/health`

```json
{
  "ok": true,
  "newestId": 56150969,
  "lastMessageAt": "2026-10-15T09:57:57.012Z",
  "connections": 42,
  "uptimeSeconds": 3600
}
```

It always returns `200` while the process runs. `newestId` and `lastMessageAt`
are `null` until the first message arrives.

## Environment variables

| Name                   | Default            | Description                                                                             |
| ---------------------- | ------------------ | --------------------------------------------------------------------------------------- |
| `PUBSUB_SUBSCRIPTION`  | (required)         | Short name (`sourcify-staging-live-stats`) or full name (`projects/…/subscriptions/…`). |
| `GOOGLE_CLOUD_PROJECT` | `sourcify-project` | The GCP project of the subscription.                                                    |
| `PORT`                 | `8080`             | The HTTP port.                                                                          |
| `MAX_CONNECTIONS`      | `1000`             | The maximum number of open streams.                                                     |
| `LOG_LEVEL`            | `info`             | `error`, `warn`, `info`, `debug` or `silly`.                                            |

The service writes JSON logs to stdout. Each line has a `severity` field, so
Cloud Logging shows the correct level. It does not log each message at `info`
level.

## Code layout

```
src/index.ts        Starts everything and handles SIGTERM.
src/config.ts       Reads the environment variables.
src/pubsub.ts       Parses a log entry and runs the Pub/Sub streaming pull.
src/state.ts        Keeps the total, the buffer and the last 30 items. Picks the next item.
src/broadcaster.ts  Runs the 500 ms tick and the 20 s ping. Writes to all streams.
src/http.ts         The Express app with /live/stream and /live/health.
src/logger.ts       JSON logger (winston).
src/types.ts        Shared types.
scripts/emulator.ts Local helpers for the Pub/Sub emulator.
scripts/setup-gcp.sh Creates the GCP resources.
```

## Local development

You need Node.js 22 (see `.nvmrc`).

```sh
npm ci
npm run build
npm run lint
npm test
```

`npm test` runs the unit tests. It also runs the Pub/Sub integration test, but
only if `PUBSUB_EMULATOR_HOST` is set. If it is not set, the test shows as
skipped, with a message.

### Run with the Pub/Sub emulator

The Pub/Sub emulator is a local fake of Pub/Sub. It does not need a GCP
account.

1. Start the emulator. Use one of these:

   ```sh
   # With gcloud (needs the pubsub-emulator component and Java):
   gcloud beta emulators pubsub start --project=sourcify-project --host-port=localhost:8085

   # With Docker:
   docker run --rm -p 8085:8085 gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators \
     gcloud beta emulators pubsub start --project=sourcify-project --host-port=0.0.0.0:8085
   ```

2. In a second terminal, create the topic and the subscription:

   ```sh
   export PUBSUB_EMULATOR_HOST=localhost:8085
   export PUBSUB_SUBSCRIPTION=sourcify-staging-live-stats
   npm run emulator:setup
   ```

3. Start the service:

   ```sh
   npm run dev
   ```

4. In a third terminal, read the stream:

   ```sh
   curl -N http://localhost:8080/live/stream
   ```

5. Send a fake match. The arguments are optional: chain id (default `8453`)
   and match type (default `exact_match`).

   ```sh
   export PUBSUB_EMULATOR_HOST=localhost:8085
   npm run emulator:publish -- 1 match
   ```

The emulator scripts stop with an error if `PUBSUB_EMULATOR_HOST` is not set.
So they cannot send fake data to the real Pub/Sub.

To run the integration test:

```sh
PUBSUB_EMULATOR_HOST=localhost:8085 npm run test:integration
```

## Deploy

### Branches

- `staging` is the default branch. A push to `staging` deploys to the
  staging environment.
- `main` deploys to production.
- Both branches are protected. The `ci` check must pass before a merge.
- Flow: open a PR from a feature branch to `staging`. After it works on
  staging, open a PR from `staging` to `main`.

### Workflows

- `.github/workflows/ci.yml` runs `npm ci`, lint, build and test on each pull
  request and on each push to `staging` and `main`. The job name is `ci`. Use
  it as the required status check.
- `.github/workflows/deploy.yml` runs on each push to `staging` and `main`:
  1. It logs in to GCP with Workload Identity Federation. This lets a GitHub
     workflow act as a GCP service account without a stored key.
  2. It builds the Docker image and pushes it to
     `europe-west1-docker.pkg.dev/sourcify-project/docker/sourcify-live-stats`,
     with two tags: the commit SHA and the environment name.
  3. It runs `gcloud run deploy sourcify-<env>-live-stats` with the new image.

The deploy changes only the image. `scripts/setup-gcp.sh` owns all other
settings of the Cloud Run service. This keeps the settings in one place.

The deploy job uses the GitHub Environments `staging` and `production`. Each
environment has its own variable `GCP_DEPLOY_SERVICE_ACCOUNT`.

> **TODO before the first deploy:** set the variable
> `GCP_DEPLOY_SERVICE_ACCOUNT` in each GitHub Environment:
>
> - `staging`: `sourcify-live-stats-staging-cd@sourcify-project.iam.gserviceaccount.com`
> - `production`: `sourcify-live-stats-production-cd@sourcify-project.iam.gserviceaccount.com`
>
> Also give the `production` environment a deployment branch rule that
> allows only `main`. See "Why production needs a branch rule" below.

### Why production needs a branch rule

GCP trusts the deploy service accounts based on the GitHub repository name.
The Workload Identity pool maps only `attribute.actor`,
`attribute.repository`, `attribute.repository_owner` and `google.subject`.
It does not map the branch. So GCP cannot tell a workflow on `main` from a
workflow on any other branch of this repository.

Thus the GitHub `production` environment is the only guard. Its deployment
branch rule must allow only `main`. Then only a workflow on `main` can read
the production `GCP_DEPLOY_SERVICE_ACCOUNT` variable and deploy.

## GCP setup

`scripts/setup-gcp.sh` creates or updates all GCP resources for one
environment. You can run it again. Each step checks what exists first.

```sh
# Show what it would do. Only read-only "describe" commands run.
scripts/setup-gcp.sh staging --dry-run

# Do it. The first run needs an image for the new Cloud Run service.
scripts/setup-gcp.sh staging --image europe-west1-docker.pkg.dev/sourcify-project/docker/sourcify-live-stats:<sha>
```

On the first run there is no image yet. You can build and push one by hand.
You can also use a placeholder such as `us-docker.pkg.dev/cloudrun/container/hello`;
the first deploy from GitHub then replaces it.

The script prints each command before it runs it. It does these steps:

1. Creates the Pub/Sub topic `sourcify-<env>-new-match`.
2. Creates or updates the logging sink `sourcify-<env>-new-match` with the
   filter from "Log contract". It lets the sink's writer identity publish to
   the topic.
3. Creates or updates the pull subscription `sourcify-<env>-live-stats`: ack
   deadline 10 s, message retention 10 minutes, no expiry.
4. Creates the runtime service account `sourcify-<env>-live-stats`. It can
   only read from that one subscription (`roles/pubsub.subscriber`).
5. Creates the deploy service account `sourcify-live-stats-<env>-cd`. It
   gives it:
   - `roles/iam.workloadIdentityUser` for
     `principalSet://iam.googleapis.com/projects/1019539084286/locations/global/workloadIdentityPools/github/attribute.repository/sourcifyeth/sourcify-live-stats`
     (only this repository).
   - `roles/iam.serviceAccountUser` on the runtime service account.
   - `roles/artifactregistry.writer` on the Artifact Registry repository
     `docker`.
   - `roles/run.developer` on its own Cloud Run service (after step 6).
6. Creates or updates the Cloud Run service `sourcify-<env>-live-stats`:
   1 instance (min and max), CPU always on, 1 CPU, 512 MiB, 1000 requests per
   instance, 1 hour timeout. Ingress is `internal-and-cloud-load-balancing`,
   so the public reaches it only through the load balancer.
7. Creates a serverless NEG and a backend service for the load balancer. A
   serverless NEG (network endpoint group) connects a load balancer to a
   Cloud Run service. The backend service uses the same load balancing scheme
   as `sourcify-<env>-server-backend`. CDN is off.
8. Prints the manual steps for the URL map (see below) and a summary.

## Remaining manual steps

### 1. Add the `/live/*` path rule to the URL map

The URL map sends each request path to a backend. It is `sourcify-lb` for
staging and `sourcify-production-lb` for production. The path matcher is
`path-matcher-2`.

Do not use `gcloud compute url-maps add-path-matcher`. It replaces the whole
path matcher, so you lose the existing rules. Export, edit and import the
URL map instead (example for staging):

```sh
gcloud compute url-maps export sourcify-lb --global --project=sourcify-project \
  --destination=sourcify-lb.yaml
cp sourcify-lb.yaml sourcify-lb.backup.yaml
```

In `sourcify-lb.yaml`, find the entry in `pathMatchers` with
`name: path-matcher-2`. Add this to its `pathRules`:

```yaml
- paths:
    - /live/*
  service: https://www.googleapis.com/compute/v1/projects/sourcify-project/global/backendServices/sourcify-staging-live-stats-backend
```

If that path matcher uses `routeRules` instead of `pathRules`, add a route rule
with `prefixMatch: /live/` and the same service.

Then check and import:

```sh
diff sourcify-lb.backup.yaml sourcify-lb.yaml
gcloud compute url-maps validate --global --project=sourcify-project --source=sourcify-lb.yaml
gcloud compute url-maps import sourcify-lb --global --project=sourcify-project --source=sourcify-lb.yaml
```

To roll back, import `sourcify-lb.backup.yaml`.

### 2. Set up GitHub

- Set `GCP_DEPLOY_SERVICE_ACCOUNT` in the `staging` and `production`
  environments (see "Deploy").
- Add a deployment branch rule to `production` that allows only `main`.
- Protect the `staging` and `main` branches. Require the `ci` check.

### 3. Monitoring

- **Uptime check** on `https://<host>/live/health`, where `<host>` is the
  host that `path-matcher-2` serves. Use the load balancer host: the Cloud Run
  URL is not public because of the ingress setting.
- **Alert in production** if the subscription `sourcify-production-live-stats`
  receives nothing for 30 minutes. Use a "metric absence" condition on
  `pubsub.googleapis.com/subscription/sent_message_count` for that
  subscription, with a 30 minute window. This alert fires if the server stops
  logging, if the sink breaks, or if this service stops pulling.
