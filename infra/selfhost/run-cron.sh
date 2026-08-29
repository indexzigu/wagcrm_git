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

# ── 응답 기록 상한이 둘인 이유 (실사고 2026-08-29) ───────────────────────────
# 종전에는 성공·실패를 가리지 않고 응답을 200자(실패는 400자)에서 잘랐다. 스토리
# 수집 잡이 대상 전원 실패한 날, 그 사유가 정확히 그 상한에서 잘려 로그에는
# `"errors":["fetch <handle>` 까지만 남았고 **원인을 특정할 수 없었다** — 전문이
# 남아 있는 곳은 프로덕션 DB(`SystemTaskLog.details`) 하나뿐이었다.
#
# 그렇다고 성공 응답까지 길게 남기면 안 된다. 이 파일은 하루치를 한눈에 훑는
# 용도라, 정상 줄이 부풀면 정작 읽어야 할 줄이 묻힌다. 그래서 상한을 푸는 것은
# **실패·부분실패 줄뿐**이다.
CRON_LOG_SUMMARY_MAX="${CRON_LOG_SUMMARY_MAX:-200}"   # 정상 줄 — 훑기 우선
CRON_LOG_DETAIL_MAX="${CRON_LOG_DETAIL_MAX:-4000}"    # 실패 줄 — 원인 특정 우선

# 응답을 로그 한 줄에 담는다. 상한을 넘으면 **잘렸다는 사실과 잘린 양을 함께**
# 남긴다 — 조용한 절단이 위 실사고의 정확한 지점이라, 무언의 말줄임표로 되돌리지
# 말 것. 줄바꿈은 공백으로 접는다(이 파일의 "실행 1회 = 한 줄" 불변식).
clip() {
  local text="${1//$'\n'/ }"
  local max="$2"
  text="${text//$'\r'/ }"
  if [ "${#text}" -le "$max" ]; then
    printf '%s' "$text"
    return
  fi
  printf '%s …[%s자 잘림 — 전문은 SystemTaskLog.details]' "${text:0:max}" "$(( ${#text} - max ))"
}

# 2xx 응답 안의 실패 신호를 가른다. HTTP 성공 ≠ 잡 성공이다 —
# `withSystemTaskStatus`(src/lib/system-task-status.ts)가 **2xx + `failed:true` 를
# ERROR 로 강등**하므로, 그 신호를 여기서도 보지 않으면 레이더는 빨강인데
# cron.log 만 `OK` 로 적는 어긋남이 생긴다(종전 동작이 그랬다).
# ⚠️ `"failed":0` 같은 **집계 카운터**를 실패로 읽지 말 것 — enrich-references ·
# price-monitoring 이 정상 응답에 그 모양의 요약 필드를 담는다. 그래서 참/거짓과
# 0 이 아닌 수를 따로 본다.
has_failure_signal() {
  local body="$1"
  local re_open_errors='"errors":\[[^]]'
  local re_failed_count='"[A-Za-z]*[Ff]ailed":[1-9]'
  if [[ "$body" == *'"failed":true'* ]]; then return 0; fi
  if [[ "$body" =~ $re_open_errors ]]; then return 0; fi
  if [[ "$body" =~ $re_failed_count ]]; then return 0; fi
  return 1
}

STAMP="$(date '+%Y-%m-%d %H:%M:%S')"
if OUT="$(curl -fsS -m 900 -H "Authorization: Bearer ${CRON_SECRET}" \
          "http://127.0.0.1:3000/api/cron/${JOB}" 2>&1)"; then
  if has_failure_signal "$OUT"; then
    # ⚠️ 종료코드는 0 그대로다. HTTP 호출 자체는 성공했고, 잡 성패의 SSOT 는 이
    # 래퍼가 아니라 `SystemTaskStatus`(레이더)다 — 여기서 exit 1 을 내면 같은
    # 사실을 판정하는 두 번째·더 약한 판사가 생긴다. 이 래퍼의 몫은 **원인을
    # 로컬에 남기는 것**이다.
    echo "[$STAMP] WARN $JOB $(clip "$OUT" "$CRON_LOG_DETAIL_MAX")" >> "$LOG"
  else
    echo "[$STAMP] OK  $JOB $(clip "$OUT" "$CRON_LOG_SUMMARY_MAX")" >> "$LOG"
  fi
else
  echo "[$STAMP] FAIL $JOB $(clip "$OUT" "$CRON_LOG_DETAIL_MAX")" >> "$LOG"
  exit 1
fi
