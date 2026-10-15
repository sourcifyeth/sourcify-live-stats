#!/usr/bin/env bash
# Creates or updates the GCP resources for sourcify-live-stats in one
# environment. Safe to run again: each step checks what exists first.
#
# Usage:
#   scripts/setup-gcp.sh <staging|production> [--dry-run] [--image IMAGE]
#
#   --dry-run       Print the commands that change things, but do not run them.
#                   Read-only checks (describe) still run, so that the printed
#                   plan matches the current state.
#   --image IMAGE   The first image for the Cloud Run service. Needed only when
#                   the service does not exist yet. You can also set IMAGE.
#
# See README.md ("GCP setup") for the full story and the manual steps.
set -euo pipefail

PROJECT_ID="sourcify-project"
PROJECT_NUMBER="1019539084286"
REGION="europe-west1"
AR_REPO="docker"
WIF_POOL="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github"
GITHUB_REPO="sourcifyeth/sourcify-live-stats"

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

ENV_NAME=""
DRY_RUN=0
IMAGE="${IMAGE:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    staging | production) ENV_NAME="$1" ;;
    --dry-run) DRY_RUN=1 ;;
    --image)
      [[ $# -ge 2 ]] || usage
      IMAGE="$2"
      shift
      ;;
    -h | --help) usage ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
  shift
done
[[ -n "$ENV_NAME" ]] || usage

TOPIC="sourcify-${ENV_NAME}-new-match"
SINK="sourcify-${ENV_NAME}-new-match"
SUBSCRIPTION="sourcify-${ENV_NAME}-live-stats"
SERVICE="sourcify-${ENV_NAME}-live-stats"
SERVER_SERVICE="sourcify-${ENV_NAME}-server"
RUNTIME_SA_NAME="sourcify-${ENV_NAME}-live-stats"
RUNTIME_SA="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOY_SA_NAME="sourcify-live-stats-${ENV_NAME}-cd"
DEPLOY_SA="${DEPLOY_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
NEG="sourcify-${ENV_NAME}-live-stats-neg"
BACKEND="sourcify-${ENV_NAME}-live-stats-backend"
SERVER_BACKEND="sourcify-${ENV_NAME}-server-backend"
if [[ "$ENV_NAME" == "staging" ]]; then
  URL_MAP="sourcify-lb"
else
  URL_MAP="sourcify-production-lb"
fi
PATH_MATCHER="path-matcher-2"
WIF_PRINCIPAL="principalSet://iam.googleapis.com/${WIF_POOL}/attribute.repository/${GITHUB_REPO}"
SINK_FILTER="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVER_SERVICE}\" AND jsonPayload.message=\"Stored to SourcifyDatabase\""

# Prints a command, then runs it (or only prints it in dry-run mode).
run() {
  printf '+ %s\n' "$(printf '%q ' "$@")"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    "$@"
  fi
}

# Prints and runs a read-only check. Runs in dry-run mode too.
# Returns the exit code of the command and hides its output.
check() {
  printf '? %s\n' "$(printf '%q ' "$@")"
  "$@" >/dev/null 2>&1
}

step() {
  printf '\n=== %s\n' "$*"
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY RUN: commands marked '+' are only printed. Checks marked '?' run (read-only)."
fi
echo "Environment: ${ENV_NAME} (project ${PROJECT_ID}, region ${REGION})"

# ---------------------------------------------------------------------------
step "1. Pub/Sub topic ${TOPIC}"
if check gcloud pubsub topics describe "$TOPIC" --project="$PROJECT_ID"; then
  echo "Topic exists."
else
  run gcloud pubsub topics create "$TOPIC" --project="$PROJECT_ID"
fi

# ---------------------------------------------------------------------------
step "2. Logging sink ${SINK} -> topic ${TOPIC}"
SINK_DESTINATION="pubsub.googleapis.com/projects/${PROJECT_ID}/topics/${TOPIC}"
if check gcloud logging sinks describe "$SINK" --project="$PROJECT_ID"; then
  run gcloud logging sinks update "$SINK" "$SINK_DESTINATION" \
    --log-filter="$SINK_FILTER" --project="$PROJECT_ID"
else
  run gcloud logging sinks create "$SINK" "$SINK_DESTINATION" \
    --log-filter="$SINK_FILTER" --project="$PROJECT_ID"
fi
WRITER_IDENTITY="$(gcloud logging sinks describe "$SINK" --project="$PROJECT_ID" \
  --format='value(writerIdentity)' 2>/dev/null || true)"
if [[ -z "$WRITER_IDENTITY" ]]; then
  # Only possible in dry-run mode, when the sink does not exist yet.
  WRITER_IDENTITY="<writerIdentity of sink ${SINK}>"
fi
run gcloud pubsub topics add-iam-policy-binding "$TOPIC" \
  --member="$WRITER_IDENTITY" --role=roles/pubsub.publisher \
  --project="$PROJECT_ID"

# ---------------------------------------------------------------------------
step "3. Pull subscription ${SUBSCRIPTION}"
SUB_SETTINGS=(--ack-deadline=10 --message-retention-duration=10m --expiration-period=never)
if check gcloud pubsub subscriptions describe "$SUBSCRIPTION" --project="$PROJECT_ID"; then
  run gcloud pubsub subscriptions update "$SUBSCRIPTION" "${SUB_SETTINGS[@]}" \
    --project="$PROJECT_ID"
else
  run gcloud pubsub subscriptions create "$SUBSCRIPTION" --topic="$TOPIC" \
    "${SUB_SETTINGS[@]}" --project="$PROJECT_ID"
fi

# ---------------------------------------------------------------------------
step "4. Runtime service account ${RUNTIME_SA}"
if check gcloud iam service-accounts describe "$RUNTIME_SA" --project="$PROJECT_ID"; then
  echo "Service account exists."
else
  run gcloud iam service-accounts create "$RUNTIME_SA_NAME" \
    --display-name="sourcify-live-stats runtime (${ENV_NAME})" \
    --project="$PROJECT_ID"
fi
run gcloud pubsub subscriptions add-iam-policy-binding "$SUBSCRIPTION" \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/pubsub.subscriber \
  --project="$PROJECT_ID"

# ---------------------------------------------------------------------------
step "5. Deploy service account ${DEPLOY_SA} (used by GitHub Actions)"
if check gcloud iam service-accounts describe "$DEPLOY_SA" --project="$PROJECT_ID"; then
  echo "Service account exists."
else
  run gcloud iam service-accounts create "$DEPLOY_SA_NAME" \
    --display-name="sourcify-live-stats deploy from GitHub (${ENV_NAME})" \
    --project="$PROJECT_ID"
fi
# Only workflows of this one repository can act as the deploy account.
# The pool maps attribute.repository; it has no branch attribute, so the
# GitHub "production" environment must limit deploys to the main branch.
run gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
  --member="$WIF_PRINCIPAL" --role=roles/iam.workloadIdentityUser \
  --project="$PROJECT_ID"
# Deploying a revision that runs as the runtime account needs actAs on it.
run gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --member="serviceAccount:${DEPLOY_SA}" --role=roles/iam.serviceAccountUser \
  --project="$PROJECT_ID"
run gcloud artifacts repositories add-iam-policy-binding "$AR_REPO" \
  --location="$REGION" --member="serviceAccount:${DEPLOY_SA}" \
  --role=roles/artifactregistry.writer --project="$PROJECT_ID"

# ---------------------------------------------------------------------------
step "6. Cloud Run service ${SERVICE}"
RUN_SETTINGS=(
  --region="$REGION"
  --project="$PROJECT_ID"
  --service-account="$RUNTIME_SA"
  --min-instances=1
  --max-instances=1
  --no-cpu-throttling
  --cpu=1
  --memory=512Mi
  --concurrency=1000
  --timeout=3600
  --ingress=internal-and-cloud-load-balancing
  --set-env-vars="PUBSUB_SUBSCRIPTION=${SUBSCRIPTION},GOOGLE_CLOUD_PROJECT=${PROJECT_ID}"
)
if check gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID"; then
  run gcloud run services update "$SERVICE" "${RUN_SETTINGS[@]}" --quiet
  # `services update` has no --allow-unauthenticated flag. Grant it directly.
  run gcloud run services add-iam-policy-binding "$SERVICE" \
    --region="$REGION" --project="$PROJECT_ID" \
    --member=allUsers --role=roles/run.invoker
else
  if [[ -z "$IMAGE" ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      IMAGE="<IMAGE>"
      echo "NOTE: the service does not exist. A real run needs --image IMAGE."
    else
      echo "ERROR: ${SERVICE} does not exist. Pass --image IMAGE (or set IMAGE) for the first deploy." >&2
      exit 1
    fi
  fi
  run gcloud run deploy "$SERVICE" --image="$IMAGE" "${RUN_SETTINGS[@]}" \
    --allow-unauthenticated --quiet
fi
run gcloud run services add-iam-policy-binding "$SERVICE" \
  --region="$REGION" --project="$PROJECT_ID" \
  --member="serviceAccount:${DEPLOY_SA}" --role=roles/run.developer


# ---------------------------------------------------------------------------
step "7. Load balancer backend ${BACKEND}"
if check gcloud compute network-endpoint-groups describe "$NEG" \
  --region="$REGION" --project="$PROJECT_ID"; then
  echo "Serverless NEG exists."
else
  run gcloud compute network-endpoint-groups create "$NEG" \
    --region="$REGION" --network-endpoint-type=serverless \
    --cloud-run-service="$SERVICE" --project="$PROJECT_ID"
fi

# Use the same scheme as the server's backend, so both fit the same URL map.
printf '? %s\n' "gcloud compute backend-services describe ${SERVER_BACKEND} --global --format=value(loadBalancingScheme)"
SCHEME="$(gcloud compute backend-services describe "$SERVER_BACKEND" --global \
  --project="$PROJECT_ID" --format='value(loadBalancingScheme)' 2>/dev/null || true)"
if [[ -z "$SCHEME" ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    SCHEME="<scheme of ${SERVER_BACKEND}>"
    echo "NOTE: could not read the scheme of ${SERVER_BACKEND}."
  else
    echo "ERROR: could not read the load balancing scheme of ${SERVER_BACKEND}." >&2
    exit 1
  fi
fi
echo "Load balancing scheme: ${SCHEME}"

if check gcloud compute backend-services describe "$BACKEND" --global --project="$PROJECT_ID"; then
  echo "Backend service exists."
else
  run gcloud compute backend-services create "$BACKEND" --global \
    --load-balancing-scheme="$SCHEME" --no-enable-cdn --project="$PROJECT_ID"
fi
printf '? %s\n' "gcloud compute backend-services describe ${BACKEND} --global --format=value(backends[].group)"
BACKEND_GROUPS="$(gcloud compute backend-services describe "$BACKEND" --global \
  --project="$PROJECT_ID" --format='value(backends[].group)' 2>/dev/null || true)"
if [[ "$BACKEND_GROUPS" == *"/networkEndpointGroups/${NEG}"* ]]; then
  echo "The NEG is already a backend."
else
  run gcloud compute backend-services add-backend "$BACKEND" --global \
    --network-endpoint-group="$NEG" \
    --network-endpoint-group-region="$REGION" --project="$PROJECT_ID"
fi

# ---------------------------------------------------------------------------
BACKEND_URL="https://www.googleapis.com/compute/v1/projects/${PROJECT_ID}/global/backendServices/${BACKEND}"
cat <<EOF

=== 8. MANUAL: route /live/* to ${BACKEND} in URL map ${URL_MAP}
This script does not change the URL map. It is shared with the main site.
Do not use 'gcloud compute url-maps add-path-matcher': it replaces the whole
path matcher, which would drop the existing rules. Instead, export, edit and
import the URL map:

  gcloud compute url-maps export ${URL_MAP} --global --project=${PROJECT_ID} \\
    --destination=${URL_MAP}.yaml
  cp ${URL_MAP}.yaml ${URL_MAP}.backup.yaml

  # In ${URL_MAP}.yaml, find the pathMatchers entry with "name: ${PATH_MATCHER}"
  # and add this to its pathRules list:
  #
  #   - paths:
  #     - /live/*
  #     service: ${BACKEND_URL}
  #
  # (If that path matcher uses routeRules instead of pathRules, add a route
  # rule with a prefixMatch of /live/ and the same service.)

  diff ${URL_MAP}.backup.yaml ${URL_MAP}.yaml
  gcloud compute url-maps validate --global --project=${PROJECT_ID} \\
    --source=${URL_MAP}.yaml
  gcloud compute url-maps import ${URL_MAP} --global --project=${PROJECT_ID} \\
    --source=${URL_MAP}.yaml

To roll back, import ${URL_MAP}.backup.yaml the same way.

=== Summary (${ENV_NAME})
  Topic:              ${TOPIC}
  Logging sink:       ${SINK} (writer: ${WRITER_IDENTITY})
  Subscription:       ${SUBSCRIPTION}
  Runtime SA:         ${RUNTIME_SA}
  Deploy SA:          ${DEPLOY_SA}
  Cloud Run service:  ${SERVICE} (${REGION})
  Serverless NEG:     ${NEG}
  Backend service:    ${BACKEND} (${SCHEME})

=== Follow-up
  1. Add the /live/* path rule to ${URL_MAP} (see step 8).
  2. In GitHub (${GITHUB_REPO}), environment "${ENV_NAME}", set the variable
     GCP_DEPLOY_SERVICE_ACCOUNT=${DEPLOY_SA}
  3. The deploy SA trusts ${WIF_PRINCIPAL}.
     This works because the pool provider maps attribute.repository. It does
     not map the branch, so protect the "production" GitHub environment with
     a deployment branch rule that allows only main.
  4. Set up monitoring (see README "Monitoring").
EOF
