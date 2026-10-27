#!/usr/bin/env bash
set -euo pipefail

# 사고 알림 발송기 — 크론 자가 복구 2단계의 호스트 쪽.
#
#   incident-notify.sh immediate   # 10분마다: 조치가 필요한 사고(🙋)·정상화(✅)
#   incident-notify.sh digest      # 매일 08:00: 하루치 요약(📋)
#   incident-notify.sh approval    # 5분마다: 결재함에 새로 오른 기안(📝) — 사고가 아니라 결재 대기 알림이다
#
# approval 모드는 목록을 `/api/cron/approval-outbox`(src/app/api/cron/approval-outbox/route.ts)에서 받고, 레코드의
# id 칸 이름이 `proposalIds`·확인 칸이 `ownerNotifiedAt` 인 것만 다르다. 발송·엄격 종료·확인 POST·실행 잠금은 같은
# 경로를 탄다(잠금은 모드별이라 사고 알림 회차와 서로 막지 않는다). 하루 상한은 조치 알림(alertedAt)만 세므로
# 결재 대기 알림에는 걸리지 않는다 — 한 회차에 많이 쌓이면 앱이 1통으로 묶는다.
#
# 앱(`/api/cron/incident-outbox`, src/app/api/cron/incident-outbox/route.ts)이 **무엇을 보낼지** 정한다.
# 이 파일은 그 목록을 notify.sh 로 텔레그램에 내보내고, 보낸 것만 POST 로 「보냈음」을 찍는다.
# ⛔ 여기서 사고를 판정하지 않는다 — 판정은 앱, 같은 키 재발송 하한은 notify.sh 의 몫이다.
#
# ⚠️ 목록 조회가 실패해도 텔레그램을 보내지 않는다 — 앱이 죽은 것은 메뉴바(status.sh 의 prodLocal)가
#    이미 알린다. 여기서 또 보내면 같은 사건이 두 갈래로 울린다.
#
# 📮 notify.sh 는 **엄격 모드**(NOTIFY_STRICT_EXIT=1)로 부른다 — 기본 모드는 텔레그램 실패에도 exit 0 이라
#    못 보낸 알림이 「보냈음」으로 찍히고, 그러면 그 ✅·📋 는 다시 나갈 길이 없다. 엄격 모드에서 1 로 끝난
#    메시지는 확인하지 않고 개수(failed)만 남긴다 — 다음 회차 목록에 다시 오고, notify.sh 는 못 보낸 키를
#    억제 기록(alert-sent.tsv)에 적지 않으므로 6시간 하한 없이 바로 다시 보낸다. 못 보낸 조치 알림은 하루 상한에
#    세지 않는다. 같은 회차에 보낸 것은 그대로 확인 POST 로 찍는다.
#
# 🔒 실행 잠금(모드별 `incident-notify-<모드>.lock`) — 앞 회차가 아직 돌면(목록 조회 60초 + 발송 재시도) 이번 회차는
#    SKIP 한 줄만 남기고 끝난다. 겹쳐 돌면 같은 알림을 둘이 함께 보낸다. 15분이 지난 잠금은 죽은 실행이 남긴 것으로
#    보고 넘겨받는다. ⚠️ 모드별인 이유: 08:00 에는 digest 와 immediate 가 동시에 도는 것이 정상이라(아래 상한 파일
#    🪤), 잠금 하나를 나누면 digest 가 그날 요약을 건너뛸 수 있다.
#
# 🔁 확인 POST 가 실패하면 exit 1 이다. 그 회차에 보낸 알림은 「보냈음」이 안 찍혀 다음 회차(10분 뒤)에
#    목록에 다시 오지만, notify.sh 가 같은 키를 6시간 안에 다시 보내지 않으므로(alert-sent.tsv) 폰이 다시
#    울리지 않는다. 그 사이 확인 POST 가 성공하면 그때 찍힌다(POST 는 이미 찍힌 칸을 덮지 않는다).
#
# 📏 하루 즉시 알림 상한 5건 — 배포 후 7일만(오너 결정 Q1). 7일 창의 시작은 상한 파일이 처음 생긴 때다.
#    상한은 조치 알림(ackField=alertedAt)만 센다 — 정상화(✅)·요약(📋)은 세지 않는다.
#    넘친 사고는 **보내지 않고 alertedAt 으로 확인만 한다** — 확인하지 않으면 자정에 개수가 새로 시작될 때
#    개별 알림으로 나가 「08:00 요약으로 넘긴다」는 안내와 어긋난다. 08:00 요약은 조치대기(waiting_owner)를
#    alertedAt 과 무관하게 전부 실으므로 넘친 사고도 거기 그대로 잡힌다. 넘친 것은 보낸 개수에 넣지 않는다.
#    넘쳤다는 안내(incident-cap)는 하루 한 번만 보낸다.
#
# cron.log 에는 실행 1회 = 한 줄, 개수만 남긴다(알림 본문은 남기지 않는다 — 이 파일은 하루치 훑기용이다).
#   [STAMP] OK   incident-notify <mode> sent=N acked=N capped=N
#   [STAMP] FAIL incident-notify <mode> <사유>   (발송 실패가 있으면 사유 끝에 sent·acked·capped·failed 개수)
#   [STAMP] SKIP incident-notify <mode> <사유>   (앞 회차가 아직 도는 중 — exit 0)
#
# 테스트 훅(scripts/__tests__/incident-notify.test.ts): INCIDENT_CURL_CMD · INCIDENT_NOTIFY_CMD
# ("bash <파일>" 두 단어를 받는다 — notify.sh 의 NOTIFY_CURL_CMD 와 같은 규약) · INCIDENT_LOGS_DIR ·
# INCIDENT_ENV_FILE · INCIDENT_NOW(지금, epoch 초) · INCIDENT_PYTHON.

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
LOGS_DIR="${INCIDENT_LOGS_DIR:-$HOME/selfhost/logs}"
LOG="$LOGS_DIR/cron.log"
COUNT_FILE="$LOGS_DIR/incident-notify-count.tsv"
ENV_FILE="${INCIDENT_ENV_FILE:-$SELF_DIR/.env}"
OUTBOX_BASE="http://127.0.0.1:3000/api/cron"
# $PY 도 의도적 미인용 — 테스트 훅 INCIDENT_PYTHON 이 "bash <경로>" 두 단어를 준다.
PY="${INCIDENT_PYTHON:-/usr/bin/python3}"

DAILY_CAP=5
CAP_WINDOW_S=$(( 7 * 86400 ))
# 실행 잠금이 이 나이(초)를 넘으면 죽은 실행이 남긴 것으로 본다 — 정상 회차는 길어야 몇 분이다.
LOCK_STALE_S=$(( 15 * 60 ))

# $CURL·$NOTIFY 는 의도적 미인용 — 테스트 훅이 "bash <경로>" 두 단어를 준다(notify.sh 와 같은 규약).
CURL="${INCIDENT_CURL_CMD:-curl}"
NOTIFY="${INCIDENT_NOTIFY_CMD:-$SELF_DIR/notify.sh}"

mkdir -p "$LOGS_DIR"
NOW="${INCIDENT_NOW:-$(date +%s)}"
case "$NOW" in ''|*[!0-9]*) NOW="$(date +%s)" ;; esac
STAMP="$(date '+%Y-%m-%d %H:%M:%S')"
MODE="${1:-}"

log_line() { # label body
  local label="$1"; shift
  # 라벨 폭은 run-cron.sh 와 같다(OK + 공백 3칸 / FAIL + 1칸) — 같은 파일을 같은 grep 으로 훑는다.
  [ "$label" = "OK" ] && label="OK  "
  # 줄바꿈·제어문자는 공백으로 접는다(이 파일의 "실행 1회 = 한 줄" 불변식).
  printf '[%s] %s incident-notify %s\n' "$STAMP" "$label" "$(printf '%s' "$*" | tr '\000-\037' ' ' | cut -c1-400)" >> "$LOG"
}
fail() { log_line FAIL "$MODE $*"; exit 1; }

# 모드별 목록 주소 · 레코드의 id 칸 이름 · 허용 확인 칸(공백 구분).
case "$MODE" in
  immediate|digest)
    OUTBOX_URL="$OUTBOX_BASE/incident-outbox"; LIST_QUERY="?mode=${MODE}"
    ID_FIELD="incidentIds"; ACK_FIELDS="alertedAt recoveryAlertedAt digestedAt" ;;
  approval)
    OUTBOX_URL="$OUTBOX_BASE/approval-outbox"; LIST_QUERY=""
    ID_FIELD="proposalIds"; ACK_FIELDS="ownerNotifiedAt" ;;
  *) fail "사용법: incident-notify.sh immediate|digest|approval" ;;
esac

# ── 실행 잠금(위 🔒) ─────────────────────────────────────────────────────────
LOCK_DIR="$LOGS_DIR/incident-notify-$MODE.lock"
# notify.sh 의 mtime_of 와 같다 — BSD(macOS) stat 먼저, 안 되면 GNU. 못 읽으면 0(= 아주 오래됨 → 넘겨받는다).
mtime_of() {
  local m
  m="$(stat -f %m "$1" 2>/dev/null || true)"
  case "$m" in ""|*[!0-9]*) m="$(stat -c %Y "$1" 2>/dev/null || true)" ;; esac
  case "$m" in ""|*[!0-9]*) m=0 ;; esac
  printf '%s\n' "$m"
}
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  lock_age=$(( NOW - $(mtime_of "$LOCK_DIR") ))
  if [ "$lock_age" -le "$LOCK_STALE_S" ]; then
    log_line SKIP "$MODE 앞 회차가 아직 도는 중입니다(잠금 ${lock_age}초)"
    exit 0
  fi
  # 넘겨받기 — 그 사이 다른 회차가 먼저 넘겨받았으면 mkdir 이 실패하므로 그쪽에 맡긴다.
  if ! { rmdir "$LOCK_DIR" 2>/dev/null && mkdir "$LOCK_DIR" 2>/dev/null; }; then
    log_line SKIP "$MODE 오래된 잠금을 넘겨받지 못했습니다(잠금 ${lock_age}초)"
    exit 0
  fi
fi
# 잠금을 쥔 뒤에만 건다 — SKIP 경로에서 남의 잠금을 지우지 않게. 아래 TMP_DIR 의 trap 이 이것을 함께 다시 건다.
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

# .env 는 run-cron.sh 와 같은 방식으로 읽고 CRON_SECRET 만 쓴다. 바깥 환경의 값은 믿지 않는다.
unset CRON_SECRET
[ -r "$ENV_FILE" ] || fail "환경 파일을 읽지 못했습니다 — CRON_SECRET 미설정(fail-closed)"
set -a; . "$ENV_FILE"; set +a
[ -n "${CRON_SECRET:-}" ] || fail "CRON_SECRET 미설정 — fail-closed 계약(src/lib/cron-auth.ts)"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/incident-notify.XXXXXX")"
trap 'rm -rf "$TMP_DIR"; rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

# ── 상한 파일 ────────────────────────────────────────────────────────────────
# 형식: 첫 줄 `since<TAB><epoch>`(7일 창의 시작), 이후 `<KST 날짜><TAB><보낸 개수><TAB><안내 보냄 0|1>`.
# 손상됐으면(첫 줄이 since 가 아니거나 숫자가 아님) 지금부터 다시 센다 — 죽어서 알림을 막는 쪽보다 낫다.
# 🪤 `|| fail` 을 빼지 말 것 — set -e 아래 맨 대입이 실패하면 cron.log 에 아무 줄도 없이 죽는다.
TODAY="$($PY -I -c 'import sys,datetime as d; print(d.datetime.fromtimestamp(int(sys.argv[1]), d.timezone(d.timedelta(hours=9))).strftime("%Y-%m-%d"))' "$NOW" 2>/dev/null)" \
  || fail "날짜 계산 실패(python3)"
case "$TODAY" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) fail "날짜 계산 실패(python3)" ;; esac
SINCE="$(awk -F'\t' 'NR==1 && $1=="since" {print $2}' "$COUNT_FILE" 2>/dev/null || true)"
case "$SINCE" in
  ''|*[!0-9]*) SINCE="$NOW"; printf 'since\t%s\n' "$SINCE" > "$COUNT_FILE" ;;
esac
SINCE=$((10#$SINCE))
TODAY_SENT="$(awk -F'\t' -v t="$TODAY" '$1==t {print $2}' "$COUNT_FILE" 2>/dev/null | tail -1 || true)"
TODAY_CAP_SENT="$(awk -F'\t' -v t="$TODAY" '$1==t {print $3}' "$COUNT_FILE" 2>/dev/null | tail -1 || true)"
case "$TODAY_SENT" in ''|*[!0-9]*) TODAY_SENT=0 ;; esac
TODAY_SENT=$((10#$TODAY_SENT))
[ "$TODAY_CAP_SENT" = "1" ] || TODAY_CAP_SENT=0
CAP_ACTIVE=0
[ $(( NOW - SINCE )) -lt "$CAP_WINDOW_S" ] && CAP_ACTIVE=1

# ── 목록 조회 ────────────────────────────────────────────────────────────────
if ! OUT="$($CURL -fsS -m 60 -H "Authorization: Bearer ${CRON_SECRET}" "${OUTBOX_URL}${LIST_QUERY}" 2>&1)"; then
  fail "목록 조회 실패: $OUT"
fi

# 응답을 NUL 구분 레코드(키·아이콘·제목·상세·확인칸·id 쉼표 목록 — 사고 또는 기안)로 푼다. 상세에 줄바꿈이 있어 NUL 로 가른다.
# 형식이 하나라도 어긋나면 아무것도 보내지 않는다 — 반쯤 보내고 반쯤 확인하는 상태를 만들지 않는다.
RECORDS="$TMP_DIR/records"
if ! printf '%s' "$OUT" | $PY -I -c '
import json, sys
data = json.load(sys.stdin)
if not isinstance(data, dict) or data.get("ok") is not True or not isinstance(data.get("messages"), list):
    sys.exit(3)
out = sys.stdout.buffer
for m in data["messages"]:
    if not isinstance(m, dict):
        sys.exit(3)
    fields = [m.get(k) for k in ("key", "icon", "title", "detail", "ackField")]
    ids = m.get(sys.argv[1])
    if not all(isinstance(f, str) and f and "\0" not in f for f in fields[:2] + fields[4:]):
        sys.exit(3)
    if not all(isinstance(f, str) and "\0" not in f for f in fields[2:4]):
        sys.exit(3)
    if fields[4] not in sys.argv[2].split():
        sys.exit(3)
    if not isinstance(ids, list) or not all(isinstance(i, str) and i and "," not in i and "\0" not in i for i in ids):
        sys.exit(3)
    for f in fields + [",".join(ids)]:
        out.write(f.encode("utf-8") + b"\0")
' "$ID_FIELD" "$ACK_FIELDS" > "$RECORDS" 2>/dev/null; then
  fail "응답 형식 오류"
fi

# ── 발송 ────────────────────────────────────────────────────────────────────
ACKS="$TMP_DIR/acks"   # 줄마다 <확인칸><TAB><id 쉼표 목록>
: > "$ACKS"
sent=0; capped=0; notify_failed=0
send_one() { # key title detail icon — 엄격 모드(위 📮): 끝내 못 보냈으면 0 이 아니다
  if [ -n "${INCIDENT_NOTIFY_CMD:-}" ]; then
    NOTIFY_STRICT_EXIT=1 $NOTIFY send "$1" "$2" "$3" "$4"
  else
    NOTIFY_STRICT_EXIT=1 "$NOTIFY" send "$1" "$2" "$3" "$4"
  fi
}
while IFS= read -r -d '' key && IFS= read -r -d '' icon && IFS= read -r -d '' title \
   && IFS= read -r -d '' detail && IFS= read -r -d '' ack_field && IFS= read -r -d '' ids; do
  if [ "$ack_field" = "alertedAt" ] && [ "$CAP_ACTIVE" -eq 1 ] && [ "$TODAY_SENT" -ge "$DAILY_CAP" ]; then
    # 보내지 않고 확인만 한다(위 📏). TODAY_SENT 는 올리지 않는다 — 실제로 나간 알림만 센다.
    capped=$((capped + 1))
    printf '%s\t%s\n' "$ack_field" "$ids" >> "$ACKS"
    continue
  fi
  # 0 이 아니면(텔레그램에 끝내 못 보냄 · 자격값 없음 · notify.sh 를 아예 못 돌림) 확인하지 않고 상한에도 세지
  # 않는다 — 다음 회차 목록에 다시 온다(위 📮).
  if send_one "$key" "$title" "$detail" "$icon"; then
    sent=$((sent + 1))
    [ "$ack_field" = "alertedAt" ] && TODAY_SENT=$((TODAY_SENT + 1))
    printf '%s\t%s\n' "$ack_field" "$ids" >> "$ACKS"
  else
    notify_failed=$((notify_failed + 1))
  fi
done < "$RECORDS"

if [ "$capped" -gt 0 ] && [ "$TODAY_CAP_SENT" -eq 0 ]; then
  if send_one incident-cap "자동화 작업 알림 상한" "오늘 알림 ${capped}건은 다음 08:00 요약으로 넘깁니다." "🙋"; then
    TODAY_CAP_SENT=1
  else
    notify_failed=$((notify_failed + 1))
  fi
fi

# 오늘 줄을 갱신한다(첫 줄 since 는 그대로). 창이 끝난 뒤에는 세지 않으므로 더 쓰지 않는다.
# 🪤 immediate 만 쓴다 — 08:00 에는 digest 와 immediate(*/10 의 0분)가 동시에 돈다. digest 는 세는 것이
#    없는데 여기서 덮어쓰면 immediate 가 방금 올린 개수를 낡은 값으로 지운다.
if [ "$MODE" = "immediate" ] && [ "$CAP_ACTIVE" -eq 1 ]; then
  awk -F'\t' -v t="$TODAY" '$1 != t' "$COUNT_FILE" > "$TMP_DIR/count" 2>/dev/null || true
  printf '%s\t%s\t%s\n' "$TODAY" "$TODAY_SENT" "$TODAY_CAP_SENT" >> "$TMP_DIR/count"
  mv "$TMP_DIR/count" "$COUNT_FILE"
fi

# ── 확인 ────────────────────────────────────────────────────────────────────
acked=0
if [ -s "$ACKS" ]; then
  ACK_JSON="$($PY -I -c '
import json, sys
acks = []
for line in open(sys.argv[1], encoding="utf-8"):
    field, _, ids = line.rstrip("\n").partition("\t")
    acks.append({sys.argv[2]: [i for i in ids.split(",") if i], "ackField": field})
print(json.dumps({"acks": acks}, ensure_ascii=False))
' "$ACKS" "$ID_FIELD" 2>/dev/null)" || fail "확인 본문 만들기 실패(python3, sent=$sent capped=$capped)"
  if ! POST_OUT="$($CURL -fsS -m 60 -X POST -H "Authorization: Bearer ${CRON_SECRET}" \
        -H "Content-Type: application/json" --data-binary "$ACK_JSON" "$OUTBOX_URL" 2>&1)"; then
    fail "확인 표시 실패(sent=$sent capped=$capped — 다음 회차에 다시 오지만 notify.sh 6시간 하한이 거른다): $POST_OUT"
  fi
  acked="$(wc -l < "$ACKS" | tr -d ' ')"
fi

if [ "$notify_failed" -gt 0 ]; then
  fail "발송 실패 ${notify_failed}건 — 다음 회차에 다시 보냅니다(sent=$sent acked=$acked capped=$capped failed=$notify_failed)"
fi
log_line OK "$MODE sent=$sent acked=$acked capped=$capped"
