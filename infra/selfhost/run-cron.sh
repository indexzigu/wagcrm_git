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
# **뭔가 실패한 줄뿐**이다.
CRON_LOG_SUMMARY_MAX="${CRON_LOG_SUMMARY_MAX:-200}"   # 정상 줄 — 훑기 우선
CRON_LOG_DETAIL_MAX="${CRON_LOG_DETAIL_MAX:-4000}"    # 실패 줄 — 원인 특정 우선

# 응답을 로그 한 줄에 담는다. 상한을 넘으면 **잘렸다는 사실과 잘린 양을 함께**
# 남긴다 — 조용한 절단이 위 실사고의 정확한 지점이라, 무언의 말줄임표로 되돌리지
# 말 것. 줄바꿈은 공백으로 접는다(이 파일의 "실행 1회 = 한 줄" 불변식).
#
# 🪤 **로케일을 지정하지 않으면 한글이 절단 지점에서 깨진다.** cron 은 `LANG` 을
# 물려주지 않아 `LC_CTYPE=C` 로 떨어지고, 그러면 `${text:0:max}` 가 **문자가 아니라
# 바이트**를 센다(실측: "가나다…" 를 5로 자르면 `가` + 깨진 바이트 1개). 이 잡들의
# 오류 메시지가 한글이라, 하필 원인을 읽어야 할 그 자리에서 글자가 깨진다.
clip() {
  # 함수 지역 LC_ALL 로 문자 단위 계산을 켠다(bash 는 이 대입에서 로케일을 다시 잡는다).
  local LC_ALL="${CRON_LOG_LOCALE:-C.UTF-8}"
  local text="${1//$'\n'/ }"
  local max="$2"
  text="${text//$'\r'/ }"
  if [ "${#text}" -le "$max" ]; then
    printf '%s' "$text"
    return
  fi
  local cut="${text:0:max}"
  local dropped=$(( ${#text} - max ))
  # ⚠️ 위 로케일이 그 호스트에 없으면 설정이 **조용히 실패**해 다시 바이트 모드가 된다
  # (없는 로케일 이름으로 실측 확인). 그때만 끝의 불완전한 UTF-8 시퀀스를 걷어낸다 —
  # 문자 모드에서는 이미 경계가 맞아 아무것도 걷히지 않는다(무해).
  local probe="가"
  if [ "${#probe}" -ne 1 ]; then
    local b
    while [ -n "$cut" ]; do
      # 🪤 `printf '%d' "'<바이트>"` 는 **부호 있는** 값을 준다(0xEB → -21, 실측).
      # 이 보정을 빼면 아래 비교가 전부 빗나가 폴백이 **죽은 코드**가 된다 —
      # 초판이 정확히 그랬고 계약 테스트가 잡았다.
      b="$(printf '%d' "'${cut: -1}")"
      [ "$b" -lt 0 ] && b=$(( b + 256 ))
      # 0x80~0xBF = 이어지는 바이트, 0xC0 이상 = 짝을 잃은 선두 바이트.
      if [ "$b" -ge 128 ] && [ "$b" -le 191 ]; then cut="${cut:0:${#cut}-1}"; continue; fi
      if [ "$b" -ge 192 ]; then cut="${cut:0:${#cut}-1}"; fi
      break
    done
  fi
  printf '%s …[%s자 잘림 — 전문은 SystemTaskLog.details]' "$cut" "$dropped"
}

# ── 라벨과 기록량은 **서로 다른 신호**로 정한다 ──────────────────────────────
# 한 신호로 둘을 함께 정하면 반드시 한쪽이 틀린다. 실제로 이 파일의 초판이 그랬다.
#
# ① 라벨(=알람인가)은 **레이더와 같은 기준**이어야 한다. `withSystemTaskStatus`
#    (src/lib/system-task-status.ts)는 **최상위 `failed: true` 하나만** ERROR 로
#    강등하고, 개별 항목 실패는 **의도적으로 승격하지 않는다** — 그 파일의 주석이
#    이유를 적어 뒀다: "상시 노이즈까지 빨강이 되면 습관화로 신호를 잃는다".
#    `capture-stories` 는 **전원 실패일 때만** `failed:true` 를 선언한다
#    (`declareStoryCaptureOutcome`, src/lib/story-capture.ts).
#    ⛔ 그러니 부분 실패를 WARN 으로 올리지 말 것 — 레이더는 초록인데 로그만 빨강인
#    **거울상 어긋남**이 되고, 그건 이 파일이 고치려던 문제와 같은 크기의 문제다.
# ② 기록량(=길게 남길 것인가)은 **원인을 읽을 일이 있는가**로 정한다. 부분 실패는
#    알람은 아니지만 나중에 "그날 누가 왜 빠졌나"를 묻게 되는 바로 그 줄이다.
#
# 그래서 라벨이 넷이다: OK(정상·짧게) · PART(부분 실패·레이더 초록·길게) ·
# WARN(앱이 실패 선언·레이더 빨강·길게) · FAIL(호출 자체 실패·길게·exit 1).
# 읽어야 할 줄: `grep -E ' (PART|WARN|FAIL) '` · 알람만: `grep -E ' (WARN|FAIL) '`

# 앱이 이번 실행을 통째로 실패로 선언했는가(= 레이더 ERROR 와 같은 판정).
declares_failure() {
  [[ "$1" == *'"failed":true'* ]]
}

# 알람은 아니지만 원인을 남겨야 하는 부분 실패인가.
# ⚠️ `"failed":0` 같은 **집계 카운터**를 실패로 읽지 말 것 — enrich-references ·
# price-monitoring 이 정상 응답에 그 모양의 요약 필드를 담는다. 그래서 참/거짓과
# 0 이 아닌 수를 따로 본다.
has_partial_failure() {
  local body="$1"
  local re_open_errors='"errors":\[[^]]'
  local re_failed_count='"[A-Za-z]*[Ff]ailed":[1-9]'
  if [[ "$body" =~ $re_open_errors ]]; then return 0; fi
  if [[ "$body" =~ $re_failed_count ]]; then return 0; fi
  return 1
}

STAMP="$(date '+%Y-%m-%d %H:%M:%S')"
if OUT="$(curl -fsS -m 900 -H "Authorization: Bearer ${CRON_SECRET}" \
          "http://127.0.0.1:3000/api/cron/${JOB}" 2>&1)"; then
  # ⚠️ 아래 두 갈래 모두 종료코드는 0 이다. HTTP 호출 자체는 성공했고, 잡 성패의
  # SSOT 는 이 래퍼가 아니라 `SystemTaskStatus`(레이더)다 — 여기서 exit 1 을 내면
  # 같은 사실을 판정하는 두 번째·더 약한 판사가 생긴다. 이 래퍼의 몫은 **원인을
  # 로컬에 남기는 것**이다.
  if declares_failure "$OUT"; then
    echo "[$STAMP] WARN $JOB $(clip "$OUT" "$CRON_LOG_DETAIL_MAX")" >> "$LOG"
  elif has_partial_failure "$OUT"; then
    echo "[$STAMP] PART $JOB $(clip "$OUT" "$CRON_LOG_DETAIL_MAX")" >> "$LOG"
  else
    echo "[$STAMP] OK   $JOB $(clip "$OUT" "$CRON_LOG_SUMMARY_MAX")" >> "$LOG"
  fi
else
  echo "[$STAMP] FAIL $JOB $(clip "$OUT" "$CRON_LOG_DETAIL_MAX")" >> "$LOG"
  exit 1
fi
