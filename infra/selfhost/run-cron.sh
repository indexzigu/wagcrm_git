#!/usr/bin/env bash
set -euo pipefail

# 크론 잡 1개를 호출하는 래퍼. crontab 은 이 스크립트만 부른다.
# macOS cron 은 `.env` 를 읽지 않으므로 이 래퍼가 `infra/selfhost/.env` 를
# 직접 source 해서 CRON_SECRET 을 확보한다.
JOB="${1:?usage: run-cron.sh <job-name>}"
cd "$(dirname "$0")/../.."
set -a; . infra/selfhost/.env; set +a
: "${CRON_SECRET:?CRON_SECRET 미설정 — fail-closed 계약(src/lib/cron-auth.ts)}"
LOG="$HOME/selfhost/logs/cron.log"
mkdir -p "$(dirname "$LOG")"
STAMP="$(date '+%Y-%m-%d %H:%M:%S')"
if OUT="$(curl -fsS -m 900 -H "Authorization: Bearer ${CRON_SECRET}" \
          "http://127.0.0.1:3000/api/cron/${JOB}" 2>&1)"; then
  echo "[$STAMP] OK  $JOB ${OUT:0:200}" >> "$LOG"
else
  echo "[$STAMP] FAIL $JOB ${OUT:0:400}" >> "$LOG"
  exit 1
fi
