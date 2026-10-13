#!/usr/bin/env bash
# Upload PMBOK PDFs + Bedrock KB metadata sidecars, then run a KB ingestion job.
#
#   scripts/upload-pmbok.sh [options]
#
# Options:
#   --source-dir DIR        Folder with the PDFs (default: <repo>/pmbok-source)
#   --edition FILE=6|7      Edition for a PDF whose name doesn't say 6 or 7 (repeatable; FILE = basename)
#   --default-edition 6|7   Edition for any PDF that can't be inferred (instead of prompting)
#   --region REGION         AWS region (default: $AWS_REGION, $AWS_DEFAULT_REGION, or ap-northeast-1)
#   --profile PROFILE       AWS CLI profile (default: $AWS_PROFILE / default chain)
#   --no-ingest             Upload only; don't start an ingestion job
#   --no-wait               Start the ingestion job but don't poll it
#   --timeout SECONDS       Max time to wait for ingestion (default: 3600)
#   --dry-run               Show what would be uploaded; no writes to AWS
#   -h, --help
#
# Reads stack outputs (Pmbok-Data: DocsBucketName, Pmbok-Knowledge: KnowledgeBaseId, DataSourceId).
# Uploads to s3://<docs-bucket>/pmbok/<file>.pdf with sidecar <file>.pdf.metadata.json:
#   { "metadataAttributes": { "source": "pmbok", "edition": "7", "title": "PMBOK Guide 7th Edition" } }
#
# Compatible with macOS bash 3.2.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SOURCE_DIR="$REPO_ROOT/pmbok-source"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-1}}"
PROFILE_ARGS=()
EDITION_OVERRIDES=""   # newline-separated "basename=edition"
DEFAULT_EDITION=""
INGEST=1
WAIT=1
TIMEOUT=3600
DRY_RUN=0
POLL_SECONDS=15
DATA_STACK="${PMBOK_DATA_STACK:-Pmbok-Data}"
KNOWLEDGE_STACK="${PMBOK_KNOWLEDGE_STACK:-Pmbok-Knowledge}"
PREFIX="pmbok/"

log() { printf '%s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --source-dir) SOURCE_DIR="${2:?}"; shift 2 ;;
    --edition)
      case "${2:-}" in
        *=6|*=7) EDITION_OVERRIDES="${EDITION_OVERRIDES}${2}"$'\n' ;;
        *) die "--edition expects FILE=6 or FILE=7" ;;
      esac
      shift 2 ;;
    --default-edition)
      case "${2:-}" in 6|7) DEFAULT_EDITION="$2" ;; *) die "--default-edition expects 6 or 7" ;; esac
      shift 2 ;;
    --region) REGION="${2:?}"; shift 2 ;;
    --profile) PROFILE_ARGS=(--profile "${2:?}"); shift 2 ;;
    --no-ingest) INGEST=0; shift ;;
    --no-wait) WAIT=0; shift ;;
    --timeout) TIMEOUT="${2:?}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

aws_() { aws "${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"}" --region "$REGION" "$@"; }

# Edition from filename: a standalone 6 or 7 (e.g. "PMBOK_7th.pdf", "pmbok-guide-6.pdf", "PMBOK 6e").
# Digits inside years (2017, 2021) don't count. Prints 6, 7, or nothing (unknown/ambiguous).
infer_edition() {
  local name has6=0 has7=0
  name="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  name="${name%.pdf}"
  printf '%s' "$name" | grep -Eq '(^|[^0-9])6(th|e|ed)?([^0-9]|$)' && has6=1
  printf '%s' "$name" | grep -Eq '(^|[^0-9])7(th|e|ed)?([^0-9]|$)' && has7=1
  if [ "$has6" = 1 ] && [ "$has7" = 0 ]; then echo 6
  elif [ "$has7" = 1 ] && [ "$has6" = 0 ]; then echo 7
  fi
}

edition_for() {
  local base="$1" override inferred answer
  override="$(printf '%s' "$EDITION_OVERRIDES" | awk -F= -v f="$base" '$1==f {print $2}' | tail -n1)"
  if [ -n "$override" ]; then echo "$override"; return; fi
  inferred="$(infer_edition "$base")"
  if [ -n "$inferred" ]; then echo "$inferred"; return; fi
  if [ -n "$DEFAULT_EDITION" ]; then echo "$DEFAULT_EDITION"; return; fi
  if [ -t 0 ]; then
    while :; do
      read -r -p "Edition for \"$base\" (6 or 7): " answer
      case "$answer" in 6|7) echo "$answer"; return ;; esac
    done
  fi
  die "can't infer edition for \"$base\"; pass --edition \"$base=6|7\" or --default-edition"
}

stack_output() {
  local stack="$1" key="$2" value
  value="$(aws_ cloudformation describe-stacks --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue | [0]" --output text 2>/dev/null)" ||
    die "could not read stack $stack (deployed? right region/profile?)"
  [ -n "$value" ] && [ "$value" != "None" ] || die "output $key not found on stack $stack"
  echo "$value"
}

# --- preflight ---------------------------------------------------------------
command -v aws >/dev/null 2>&1 || die "AWS CLI v2 not found"
[ -d "$SOURCE_DIR" ] || die "source dir not found: $SOURCE_DIR"

PDFS=()
while IFS= read -r f; do PDFS+=("$f"); done < <(find "$SOURCE_DIR" -maxdepth 1 -type f -iname '*.pdf' | sort)
[ "${#PDFS[@]}" -gt 0 ] || die "no PDFs in $SOURCE_DIR"

log "Region: $REGION"
DOCS_BUCKET="$(stack_output "$DATA_STACK" DocsBucketName)"
KB_ID="$(stack_output "$KNOWLEDGE_STACK" KnowledgeBaseId)"
DS_ID="$(stack_output "$KNOWLEDGE_STACK" DataSourceId)"
log "Docs bucket: $DOCS_BUCKET   KB: $KB_ID   Data source: $DS_ID"

# --- metadata sidecars ---------------------------------------------------------
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pmbok-upload.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

for pdf in "${PDFS[@]}"; do
  base="$(basename "$pdf")"
  # S3 keys use the basename; avoid characters that make keys awkward.
  case "$base" in *'"'*|*'\'*) die "unsupported character in filename: $base" ;; esac
  edition="$(edition_for "$base")"
  title="PMBOK Guide ${edition}th Edition"
  cp "$pdf" "$WORK_DIR/$base"
  printf '{ "metadataAttributes": { "source": "pmbok", "edition": "%s", "title": "%s" } }\n' \
    "$edition" "$title" > "$WORK_DIR/$base.metadata.json"
  log "  $base -> edition $edition"
done

DEST="s3://$DOCS_BUCKET/$PREFIX"
if [ "$DRY_RUN" = 1 ]; then
  log "[dry-run] would sync to $DEST:"
  (cd "$WORK_DIR" && ls -1)
  for f in "$WORK_DIR"/*.metadata.json; do log "  $(basename "$f"): $(cat "$f")"; done
  log "[dry-run] would then start ingestion job (KB $KB_ID, data source $DS_ID)"
  exit 0
fi

# --- upload ------------------------------------------------------------------
# --delete keeps s3://.../pmbok/ in sync with the local folder (removed PDFs get removed from the KB on next ingestion).
log "Uploading to $DEST ..."
# WORK_DIR holds exactly the PDFs + sidecars.
aws_ s3 sync "$WORK_DIR/" "$DEST" --delete --only-show-errors
log "Upload complete."

[ "$INGEST" = 1 ] || { log "Skipping ingestion (--no-ingest)."; exit 0; }

# --- ingestion ------------------------------------------------------------------
JOB_ID="$(aws_ bedrock-agent start-ingestion-job --knowledge-base-id "$KB_ID" --data-source-id "$DS_ID" \
  --query 'ingestionJob.ingestionJobId' --output text)"
log "Started ingestion job $JOB_ID"
[ "$WAIT" = 1 ] || { log "Not waiting (--no-wait). Check: aws bedrock-agent get-ingestion-job --knowledge-base-id $KB_ID --data-source-id $DS_ID --ingestion-job-id $JOB_ID"; exit 0; }

start="$(date +%s)"
while :; do
  status="$(aws_ bedrock-agent get-ingestion-job --knowledge-base-id "$KB_ID" --data-source-id "$DS_ID" \
    --ingestion-job-id "$JOB_ID" --query 'ingestionJob.status' --output text)"
  elapsed=$(( $(date +%s) - start ))
  log "  [$((elapsed / 60))m$((elapsed % 60))s] $status"
  case "$status" in
    COMPLETE|FAILED|STOPPED) break ;;
  esac
  [ "$elapsed" -lt "$TIMEOUT" ] || die "timed out after ${TIMEOUT}s (job $JOB_ID still $status)"
  sleep "$POLL_SECONDS"
done

aws_ bedrock-agent get-ingestion-job --knowledge-base-id "$KB_ID" --data-source-id "$DS_ID" \
  --ingestion-job-id "$JOB_ID" --query 'ingestionJob.{status:status,statistics:statistics,failureReasons:failureReasons}' \
  --output json

[ "$status" = COMPLETE ] || die "ingestion job $JOB_ID ended with status $status"
log "Done. The knowledge base is ready."
