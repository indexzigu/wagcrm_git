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
  # 🪤 남은 제어문자(탭·NUL 등, \n·\r 은 이미 위에서 걷었다)가 단 하나만 있어도
  # 이 호스트의 grep(ugrep -I)이 cron.log 전체를 "바이너리"로 판정해 -a 없이는
  # 조용히 0건을 반환한다(T-153 — append-only 라 옛 손상 줄 하나가 오늘 줄까지
  # 가린다). 문자 단위로 걷어야 다국어 바이트 경계를 안 깬다.
  text="${text//[[:cntrl:]]/ }"
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

# ── 재시도: 판정은 앱, 실행은 이 스크립트 (자가 정상화 3단계, 2026-10-21) ──────
# 작업별 재시도 정책의 정본은 `src/lib/cron-jobs.ts`(`KnownJob.retry`)이고, 이번
# 실패가 재시도 대상인지(일시 장애인가·남은 회차가 있는가)는 **앱이** 판정해 응답 헤더
# `X-Cron-Retry-After-Sec: <초>` 로 알려 준다. 이 스크립트는 그 헤더가 있으면 그만큼
# 기다렸다가 같은 작업을 `X-Cron-Attempt: <n+1>` 로 다시 부른다. 여기서 정책을 따로
# 들고 있지 않는다 — 두 번째 판사가 생기면 둘이 어긋나는 날 같은 부수효과가 두 번 난다.
#
# 그래도 스크립트 쪽 상한은 따로 둔다: **앱 판정 재시도는 최대 2회**(앱이 몇 번을 더
# 달라고 해도 여기서 멈춘다), 헤더 값은 **정수 1..3600초만** 받는다. 앱 쪽 결함 하나가
# 무한 반복·하루짜리 대기로 번지지 않게 하는 양쪽 상한이다.
#
# 예외 둘 — 앱이 판정할 수 없는 경우다:
#  - curl 종료코드 7(앱 접속 자체 실패 = 앱 응답 없음): 요청이 앱에 닿지 않았으니 다시
#    불러도 이중 효과가 없다. **앱이 아직 한 번도 응답하지 않았을 때 1회만**, 120초 뒤.
#    이때 회차 헤더는 올리지 않는다 — 앱이 본 회차는 여전히 1이다. 올리면 앱이 정기
#    실행을 「재시도 회차」로 읽어 사고 반복 횟수를 세지 않게 되고, 오너 알림 기준
#    (같은 원인 2회 연속)이 하루 밀린다.
#  - curl 종료코드 28(15분 시간 초과): 앱 안에서 작업이 **아직 돌고 있을 수 있어**
#    다시 부르면 겹쳐 돈다. 다시 부르지 않는다.
#
# 실측(2026-10-21, 임시 로컬 HTTP 서버가 500 + 사용자 헤더를 돌려주게 해서 확인 —
# curl 8.7.1): `-f` 로 종료코드 22 가 나도 `-D <파일>` 에는 응답 헤더가 **그대로
# 남는다**. 그래서 `--fail-with-body` 로 바꾸지 않았고 기존 FAIL 줄 내용도 그대로다.
#
# 로그: 회차마다 기존 라벨 줄 1줄(불변식 그대로) + 재시도를 예약할 때만
# `RETRY <job> <k>/<상한> after <초>s (<사유>)` 1줄. k/상한은 그 종류 재시도의 순번과
# 이 스크립트의 상한이다(앱 판정 x/2, 앱 응답 없음 1/1) — 작업별 정책 횟수가 아니다.
# 헤더가 **있는데 값이 이상하면** 다시 부르지 않고 `RETRY <job> 건너뜀: 재시도 신호 값 이상 '<값>'`
# 1줄을 남긴다 — 앱이 재시도를 원했는데 조용히 사라지면 앱 쪽 결함을 아무도 모른다.
# 헤더가 없으면(재시도 대상 아님) 아무것도 남기지 않는다.
# 대기 명령은 `CRON_RETRY_SLEEP_CMD`(기본 `sleep`) — 테스트가 실제로 기다리지 않게 하는 훅.
CRON_RETRY_SLEEP_CMD="${CRON_RETRY_SLEEP_CMD:-sleep}"
APP_RETRY_MAX=2
APP_DOWN_RETRY_SEC=120

# 🪤 `set -e` 아래에서 임시 파일 만들기·비우기가 실패하면 스크립트가 **로그 한 줄 없이** 죽는다
# (cron 은 stderr 를 버린다) — 그날 그 작업이 안 돈 흔적이 어디에도 안 남는다. 그래서 둘 다 실패를
# 직접 잡아 기존 FAIL 줄 형식으로 남기고 exit 1 한다(호출 실패와 같은 판정).
fail_tmpfile() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] FAIL $JOB $1" >> "$LOG"
  exit 1
}
HDR_FILE=""
HDR_FILE="$(mktemp "${TMPDIR:-/tmp}/run-cron-hdr.XXXXXX" 2>/dev/null)" \
  || fail_tmpfile "임시 파일을 만들지 못함 (${TMPDIR:-/tmp})"
trap 'rm -f "$HDR_FILE"' EXIT

# 로그에 남길 헤더 원값 — 제어문자를 걷고 40자로 자른다(한 줄 불변식, 앱 결함이 줄을 부풀리지 않게).
clip_value() {
  local LC_ALL="${CRON_LOG_LOCALE:-C.UTF-8}"
  local v="${1//[[:cntrl:]]/ }"
  if [ "${#v}" -gt 40 ]; then v="${v:0:40}…"; fi
  printf '%s' "$v"
}

# 응답 헤더 파일에서 재시도 신호를 읽어 전역 셋을 채운다 — 값을 둘로 나눠야 「헤더 없음」(조용히)과
# 「헤더는 있는데 값 이상」(1줄 남김)을 가를 수 있다. 서브셸(`$(...)`)로 부르면 전역이 사라진다.
#   RETRY_HDR_SEEN: 헤더가 있었으면 1 · RETRY_HDR_RAW: 마지막 원값 · RETRY_HDR_SEC: 유효하면 초, 아니면 빈 값
# (리다이렉트로 응답이 여럿이면 마지막 값이 이긴다. bash 3.2 호환 — `${x,,}` 금지.)
read_retry_header() {
  local file="$1" line val=""
  RETRY_HDR_SEEN=0; RETRY_HDR_RAW=""; RETRY_HDR_SEC=""
  [ -s "$file" ] || return 0
  shopt -s nocasematch
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    if [[ "$line" == x-cron-retry-after-sec:* ]]; then
      RETRY_HDR_SEEN=1
      val="${line#*:}"
      val="${val#"${val%%[![:space:]]*}"}"
      val="${val%"${val##*[![:space:]]}"}"
    fi
  done < "$file"
  shopt -u nocasematch
  RETRY_HDR_RAW="$val"
  # 숫자만, 그리고 앞자리 0 은 10진수로(`10#`) — 그냥 산술에 넣으면 `0090` 이 8진수 오류다.
  [[ "$val" =~ ^[0-9]+$ ]] || return 0
  [ "${#val}" -le 6 ] || return 0
  val=$(( 10#$val ))
  if [ "$val" -ge 1 ] && [ "$val" -le 3600 ]; then RETRY_HDR_SEC="$val"; fi
}

ATTEMPT=1          # 앱이 본 회차(헤더 X-Cron-Attempt)
APP_RETRIES=0      # 앱 판정 재시도 횟수
APP_REACHED=0      # 앱이 한 번이라도 응답했는가(앱 응답 없음 재시도 자격)
APP_DOWN_RETRIED=0
while :; do
STAMP="$(date '+%Y-%m-%d %H:%M:%S')"
# 비우지 못한 채 진행하면 지난 회차의 재시도 헤더를 이번 응답 것으로 읽는다 — 여기서 멈춘다.
{ : > "$HDR_FILE"; } 2>/dev/null || fail_tmpfile "임시 파일을 비우지 못함"
RC=0
OUT="$(curl -fsS -m 900 -H "Authorization: Bearer ${CRON_SECRET}" \
          -H "X-Cron-Attempt: ${ATTEMPT}" -D "$HDR_FILE" \
          "http://127.0.0.1:3000/api/cron/${JOB}" 2>&1)" || RC=$?
if [ "$RC" -eq 0 ]; then
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
fi

# 다음 회차를 부를지 정한다. 7(앱 응답 없음)·28(시간 초과)·기타 연결 오류는 앱 응답이
# 없으니 헤더도 없다. 0(정상 응답)·22(HTTP 4xx/5xx)만 앱이 응답한 것이다.
WAIT=""; REASON=""; KIND=""
if [ "$RC" -eq 0 ] || [ "$RC" -eq 22 ]; then
  APP_REACHED=1
  if [ "$APP_RETRIES" -lt "$APP_RETRY_MAX" ]; then
    read_retry_header "$HDR_FILE"
    WAIT="$RETRY_HDR_SEC"
    if [ -n "$WAIT" ]; then
      KIND=app; REASON="앱 판정"
    elif [ "$RETRY_HDR_SEEN" -eq 1 ]; then
      echo "[$STAMP] RETRY $JOB 건너뜀: 재시도 신호 값 이상 '$(clip_value "$RETRY_HDR_RAW")'" >> "$LOG"
    fi
  fi
elif [ "$RC" -eq 7 ] && [ "$APP_REACHED" -eq 0 ] && [ "$APP_DOWN_RETRIED" -eq 0 ]; then
  WAIT="$APP_DOWN_RETRY_SEC"; KIND=down; REASON="앱 응답 없음"
fi

if [ -z "$WAIT" ]; then
  # 최종 회차가 판정한다(기존 계약: 호출 실패만 exit 1).
  [ "$RC" -eq 0 ] || exit 1
  exit 0
fi

if [ "$KIND" = app ]; then
  APP_RETRIES=$(( APP_RETRIES + 1 ))
  ATTEMPT=$(( ATTEMPT + 1 ))
  echo "[$STAMP] RETRY $JOB ${APP_RETRIES}/${APP_RETRY_MAX} after ${WAIT}s (${REASON})" >> "$LOG"
else
  APP_DOWN_RETRIED=1
  echo "[$STAMP] RETRY $JOB 1/1 after ${WAIT}s (${REASON})" >> "$LOG"
fi
$CRON_RETRY_SLEEP_CMD "$WAIT"
done
