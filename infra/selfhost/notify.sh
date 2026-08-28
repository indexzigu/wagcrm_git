#!/usr/bin/env bash
set -euo pipefail

# 외부 채널(텔레그램) 발송 + 소음 억제.
# 설계 정본: docs/private/specs/2026-08-19-external-alert-channel-design.md
#
#   notify.sh send  <key> <title> <detail>   # error 로 떨어지는 전환에서
#   notify.sh clear <key>                    # error 에서 벗어나는 전환에서
#   notify.sh probe                          # 메시지 없이 도달성만 확인(getMe)
#
# ⛔ 판정하지 않는다 — 무엇이 빨강인지는 status.sh 가, 언제 전환됐는지는 앱이 정한다.
#    이 파일이 소유하는 것은 "같은 키를 너무 자주 보내지 않는다"는 절대 하한 하나다.
#
# 🪤 그 하한이 왜 필요한가: 앱의 전환 억제(notifiedErrorKeys)는 **메모리**라 앱이
#    재시작하면 리셋된다. macOS 알림은 그 맥에서 사라지지만 텔레그램은 폰에 쌓이므로,
#    앱이 크래시 루프에 빠지면 300초마다 같은 알림이 나간다(2026-08-19 사고 연쇄 5번과
#    같은 실패). 디스크에 남는 이 기록만이 그 루프를 끊는다.
#
# ⛔ 실패해도 exit 0 이다 — 알림 발송이 앱의 폴링을 죽이면 안 된다. 실패는 마커로
#    남고 status.sh 가 그것을 warn 행으로 그린다.
#
# 📒 `alert-sent.tsv` 는 **억제 상태**이지 이력이 아니다 — `clear` 가 그 키의 행을 지운다
#    (회복 후 6시간 하한을 우회하려는 **의도된** 동작이다). 그래서 회복하고 나면
#    "무엇이 언제 나갔나"의 흔적이 0이 되고, 텔레그램 Bot API 로도 봇이 *보낸* 메시지는
#    조회되지 않는다(getUpdates 는 받은 것만 준다). 2026-08-25 에 실제로 그 때문에 사고
#    재구성이 막혔다 — 발송 시각이 이슈 본문에 우연히 복사돼 있어서 겨우 풀렸다.
#    `alert-history.tsv` 가 그 흔적을 소유한다: **append 전용이고 clear 가 건드리지 않는다.**
#    ⛔ 이 둘의 역할을 합치지 말 것 — 하한 판정이 이력을 읽기 시작하면 회복 후 재발송이
#    다시 6시간 막힌다(그것이 애초에 `drop_key` 가 있는 이유다).
#    ⛔ 억제된 발송(하한에 막힌 것)은 적지 않는다 — 빨강 유지 중엔 폴링마다(하루 최대
#    288회/키) 쌓여 이력이 소음이 된다. 하한은 마지막 발송 시각의 순수 함수라
#    **나간 것만 적어도 억제 여부는 산술로 재구성된다.**

# 🔴 자격값(토큰·chat id)이 비어 있어도 조용히 exit 0 하지 않는다(2026-08-19 리뷰
#    지적 C1). 예전에는 그렇게 했고, 그 결과 `.env` 부재(미추적이라 재클론하면
#    사라진다)·`export ` 접두·오타 어느 쪽이든 알림이 흔적 없이 사라지는데
#    status.sh 는 마커가 없으니 "정상"을 주장했다 — 한 번도 관측한 적 없는 사실을
#    적극적으로 단언한 것이다. 이제 자격값 부재도 마커를 남긴다(사유 unconfigured).

LOGS_DIR="${NOTIFY_LOGS_DIR:-$HOME/selfhost/logs}"
SENT_FILE="$LOGS_DIR/alert-sent.tsv"
HISTORY_FILE="$LOGS_DIR/alert-history.tsv"
FAIL_MARKER="$LOGS_DIR/alert-send-failed"
PROBE_LAST_FILE="$LOGS_DIR/alert-probe-last"
LOCK_DIR="$LOGS_DIR/alert-sent.lock"
ENV_FILE="${NOTIFY_ENV_FILE:-$(dirname "$0")/.env}"

# 같은 키의 재발송 절대 하한(시간).
RESEND_MIN_INTERVAL_H=6
# 하루 1회 요약(digest 키)만의 하한 — 항목 전환 알림과 성격이 다르다.
# 설계 정본: docs/private/specs/2026-08-25-daily-red-digest-design.md
# 🪤 여기서 RESEND_MIN_INTERVAL_H 를 그대로 쓰면 지속 실패 중 하루 4통이 되어
#    외부채널 설계서의 소음 예산(같은 항목이 빨강인 채 유지 = 추가 발송 없음)이
#    무너진다. 앱이 "오늘 보냈나"를 메모리로 들고 있는데 그것은 재시작으로
#    리셋되므로(크래시 루프), 하루 1통을 실제로 지키는 것은 디스크에 남는 이 하한이다.
DIGEST_MIN_INTERVAL_H=20
# probe 자체 발화 빈도 상한(초) — 앱이 매 full 폴링(300초)마다 불러도 텔레그램
# 왕복은 시간당 1회만 나가게 한다.
PROBE_MIN_INTERVAL_S=3600
# send 마커(실제 발송 유실)를 probe 성공으로 지우기까지의 유예(시간) — 그 안에는
# 지우지 않는다. 회복됐다는 사실이 "그 사이 알림 하나가 유실됐다"는 사실을
# 지우진 않으므로, 오너가 볼 기회를 남긴다.
SEND_MARKER_KEEP_H=24
# 잠금이 이 시간(초)보다 오래됐으면 죽은 프로세스가 남긴 것으로 보고 정리한다.
LOCK_STALE_S=30
LOCK_MAX_WAIT_S=3

# $CURL 은 의도적 미인용 — 테스트 훅이 "bash <경로>" 두 단어를 줄 수 있다(기존 규약).
CURL="${NOTIFY_CURL_CMD:-curl}"

mkdir -p "$LOGS_DIR" 2>/dev/null || true
NOW="$(date +%s)"

# .env 를 통째로 source 하지 않는다 — 프로덕션 자격값 전체를 이 프로세스에 끌어들일
# 이유가 없고, source 는 파일 안의 명령 치환까지 실행한다. 필요한 두 값만 뽑는다.
read_env() {
  [ -r "$ENV_FILE" ] || return 0
  sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}[[:space:]]*$/\1/p" "$ENV_FILE" | tail -1
}

# 실패 마커: <epoch><TAB><사유코드><TAB><사람이 읽는 문구> 한 줄. 사유코드는
# unconfigured(자격값 없음) · send(실제 발송 실패) · probe(도달성 확인 실패) 셋뿐이다.
write_marker() { # reason message
  printf '%s\t%s\t%s\n' "$NOW" "$1" "$2" > "$FAIL_MARKER" 2>/dev/null || true
}

# 마커의 필드 하나를 읽는다(2=사유코드, 3=문구). 첫 줄만 본다 — 손상돼 여러 줄이
# 쌓여도 판정이 흔들리지 않게.
#
# 🪤 "파일이 있으면 return 1" 로 짜지 않는다 — 이 함수는 호출부에서
#    `reason="$(marker_field 2)"` 처럼 **맨 대입문**의 우변으로 쓰인다. set -e
#    아래서 그런 대입은 우변 명령의 종료코드를 그대로 물려받으므로, 파일이 이
#    함수 호출과 위 존재 확인(clear_marker_unless_recent_send 의 앞선
#    `[ -f ... ]`) 사이에(예: 동시에 도는 send 성공 분기의 `rm -f`) 사라지면
#    nonzero 종료가 그 대입에서 스크립트 전체를 죽인다(2026-08-19 리뷰가
#    실측 재현: `set -e; f(){ return 1; }; x="$(f)"` 는 아무 것도 출력하지
#    않고 죽는다). awk 자체의 실패를 `|| true` 로 삼켜 이 함수가 항상 0 으로
#    끝나게 한다 — 파일이 없으면 그냥 빈 문자열을 낸다.
marker_field() {
  awk -F'\t' -v i="$1" 'NR==1{print $i}' "$FAIL_MARKER" 2>/dev/null || true
}

# probe 성공 시 마커 해제 여부를 결정한다. send 사유이고 24시간 안이면 지우지
# 않는다(실제로 알림 하나가 유실된 사실이라 오너가 볼 기회를 남긴다) — 그 밖의
# 모든 경우(unconfigured·probe, 또는 24시간 지난 send)는 지운다. 마커가 이미
# 없으면(파일 부재·경쟁으로 방금 지워짐 등) 아래 로직이 자연히 reason="" 로
# 떨어져 rm -f 로 수렴한다 — 이미 없는 파일을 다시 지우는 것은 안전하다.
clear_marker_unless_recent_send() {
  local reason epoch age_h
  reason="$(marker_field 2)"
  epoch="$(marker_field 1)"
  case "$epoch" in ''|*[!0-9]*) epoch=0 ;; esac
  epoch=$((10#$epoch))
  [ "$epoch" -gt "$NOW" ] && epoch=0
  age_h=$(( (NOW - epoch) / 3600 ))
  if [ "$reason" = "send" ] && [ "$age_h" -lt "$SEND_MARKER_KEEP_H" ]; then
    return 0
  fi
  rm -f "$FAIL_MARKER" 2>/dev/null || true
}

# 짧은 대기 — GNU sleep 은 소수 초를 받지만 macOS(BSD) sleep 은 안 받는다. 이
# 레포의 다른 자리(status.sh 의 stamp_epoch)가 같은 이유로 perl 을 쓴 것과 같다.
short_sleep() { perl -e 'select(undef,undef,undef,0.1)' 2>/dev/null || sleep 1; }

# 🪤 판정을 **종료코드가 아니라 출력 형태**로 한다 (2026-08-21 CI 실측).
#    BSD 와 GNU 의 `-f` 는 정반대다 — BSD 는 포맷 플래그지만 GNU 는 `--file-system`
#    (불리언)이라, GNU 에서 `stat -f %m X` 는 `%m` 과 `X` 를 **두 개의 파일 인자**로
#    읽는다. 없는 `%m` 때문에 exit 1 이 되면서도 **stdout 에는 X 의 파일시스템 블록
#    (`  File: "..."`)을 이미 뱉은 뒤**라, `||` 폴백이 그 뒤에 epoch 을 덧붙인다.
#    반환값이 「텍스트 + 숫자」가 되어 호출부의 `$(( ))` 안에서 bash 가 `File` 을
#    변수로 읽고, `set -u` 아래에서 `File: unbound variable` 로 스크립트가 죽었다.
#    ⚠️ macOS 는 첫 분기가 성공해 GNU 분기를 아예 안 타므로 **로컬에선 보이지 않는다**.
#    게다가 이 함수는 잠금 경쟁 때만 호출돼, CI 에서 간헐적으로만 터졌다.
#    `||` 는 종료코드만 보는데 이 함수의 계약은 출력 형태다 — 그 어긋남이 결함이었다.
mtime_of() {
  local m
  m="$(stat -f %m "$1" 2>/dev/null || true)"
  case "$m" in ""|*[!0-9]*) m="$(stat -c %Y "$1" 2>/dev/null || true)" ;; esac
  # 어느 방언으로도 못 읽으면 0 — 호출부가 "아주 오래됨"으로 보고 스테일 락을 회수한다
  # (종전 `echo 0` 과 같은 의미다. 판정 불가를 "방금 만들어진 락"으로 읽으면 영영 못 푼다).
  case "$m" in ""|*[!0-9]*) m=0 ;; esac
  printf '%s\n' "$m"
}

# alert-sent.tsv 의 읽기-수정-쓰기(drop_key + 발송 기록 추가)를 감싸는 mkdir
# 스핀락. db·prodLocal 이 같은 폴링에서 함께 빨강이 되면 앱이 notify.sh 를
# 동시에 두 개(각각 별도 프로세스) 띄운다 — 잠금이 없으면 두 프로세스의
# awk→tmp→mv 가 겹쳐 나중에 끝난 쪽이 다른 키의 발송 기록을 통째로 덮는다
# (그 키의 6시간 하한이 조용히 우회된다, 2026-08-19 리뷰 지적 I4).
# 획득 실패(상한 초과)면 무한 대기하지 않고 포기한다 — 포기해도 exit 0 이다.
#
# 🪤 상한은 반복 횟수가 아니라 **벽시계 경과**로 잰다(2026-08-19 리뷰 지적).
#    반복 횟수 × 고정 100ms 로 계산하면 short_sleep 의 perl 폴백이 없는
#    호스트에서 매 반복이 실제로는 1초(sleep 1 폴백)라 실제 대기가 의도한
#    LOCK_MAX_WAIT_S 의 최대 10배까지 늘어난다. iterations 상한은 date 자체가
#    죽어 시계가 안 움직이는 극단적 상황에 대비한 안전망일 뿐이다.
with_lock() {
  local wait_start iterations=0
  wait_start="$(date +%s)"
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    if [ -d "$LOCK_DIR" ]; then
      local age=$(( NOW - $(mtime_of "$LOCK_DIR") ))
      # 스테일 락 — 락을 쥔 프로세스가 죽어 rmdir 되지 않은 채 남은 경우다.
      # 오래된 락은 무시하고 진행한다.
      if [ "$age" -gt "$LOCK_STALE_S" ]; then
        rmdir "$LOCK_DIR" 2>/dev/null || true
        continue
      fi
    fi
    iterations=$((iterations + 1))
    if [ $(( $(date +%s) - wait_start )) -ge "$LOCK_MAX_WAIT_S" ] || [ "$iterations" -ge 100 ]; then
      return 1
    fi
    short_sleep
  done
  return 0
}
release_lock() { rmdir "$LOCK_DIR" 2>/dev/null || true; }

# 탭·개행을 공백으로 접는다 — 필드 구분자가 본문에 섞이면 이력 **전체**가 파싱 불능이 된다.
# status.sh 의 현행 문구에는 탭이 없지만 문구의 소유자는 그쪽이라 나중에 들어올 수 있다.
one_line() { printf '%s' "$1" | tr '\t\n' '  '; }

# <epoch><TAB><키><TAB><제목><TAB><상세> 한 줄을 덧붙인다.
#
# 🪤 **잠금 밖에서 부른다.** with_lock 이 지키는 것은 `alert-sent.tsv` 의 읽기-수정-쓰기
#    (drop_key → append)이고, 이쪽은 순수 append 라 경쟁이 성립하지 않는다. 임계구역에
#    끌어들이면 잠금 획득 실패(상한 초과) 시 이력까지 함께 유실된다 — 정확히 남겨야 할
#    상황에서 사라지는 쪽이다.
#
# 회전하지 않는다: 키별 6시간 하한 + 요약 하루 1통이 상한을 묶어 실질 하루 5줄 안팎
# (≈300B/일)이다. 상한을 걸면 읽기-수정-쓰기가 되어 잠금이 필요해지고, 얻는 것보다 잃는
# 것이 크다. 실패해도 exit 0 이다(이 파일의 기존 규약 — 알림 경로를 죽이지 않는다).
append_history() {
  printf '%s\t%s\t%s\t%s\n' \
    "$NOW" "$KEY" "$(one_line "$TITLE")" "$(one_line "$DETAIL")" \
    >> "$HISTORY_FILE" 2>/dev/null || true
}

drop_key() {
  [ -f "$SENT_FILE" ] || return 0
  local tmp="$SENT_FILE.tmp.$$"
  awk -F'\t' -v k="$KEY" '$1 != k' "$SENT_FILE" > "$tmp" 2>/dev/null || true
  mv "$tmp" "$SENT_FILE" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
}

CMD="${1:-}"
[ -n "$CMD" ] || exit 0

if [ "$CMD" = "probe" ]; then
  # 자기 빈도 상한 — 앱이 매 full 폴링마다 불러도 왕복은 시간당 1회다.
  LAST_PROBE="$(cat "$PROBE_LAST_FILE" 2>/dev/null || true)"
  case "$LAST_PROBE" in ''|*[!0-9]*) LAST_PROBE=0 ;; esac
  LAST_PROBE=$((10#$LAST_PROBE))
  [ "$LAST_PROBE" -gt "$NOW" ] && LAST_PROBE=0
  if [ "$LAST_PROBE" -gt 0 ] && [ $(( NOW - LAST_PROBE )) -lt "$PROBE_MIN_INTERVAL_S" ]; then
    exit 0
  fi
  printf '%s' "$NOW" > "$PROBE_LAST_FILE" 2>/dev/null || true

  TOKEN="$(read_env TELEGRAM_BOT_TOKEN)"
  CHAT="$(read_env TELEGRAM_CHAT_ID)"
  if [ -z "$TOKEN" ] || [ -z "$CHAT" ]; then
    write_marker unconfigured "텔레그램 자격값이 설정되지 않았습니다 — .env 를 확인하세요"
    exit 0
  fi

  # 메시지를 보내지 않는다 — getMe 로 도달성만 본다.
  PROBE_CODE="$($CURL -s -o /dev/null -m 10 -w '%{http_code}' \
    "https://api.telegram.org/bot${TOKEN}/getMe" 2>/dev/null || true)"
  if [ "$PROBE_CODE" = "200" ]; then
    clear_marker_unless_recent_send
  else
    write_marker probe "텔레그램에 연결할 수 없습니다(코드 ${PROBE_CODE:-없음}) — 네트워크·토큰을 확인하세요"
  fi
  exit 0
fi

KEY="${2:-}"
[ -n "$KEY" ] || exit 0

if [ "$CMD" = "clear" ]; then
  if with_lock; then
    drop_key
    release_lock
  fi
  exit 0
fi

[ "$CMD" = "send" ] || exit 0
TITLE="${3:-}"
DETAIL="${4:-}"

TOKEN="$(read_env TELEGRAM_BOT_TOKEN)"
CHAT="$(read_env TELEGRAM_CHAT_ID)"
if [ -z "$TOKEN" ] || [ -z "$CHAT" ]; then
  write_marker unconfigured "텔레그램 자격값이 없어 '${TITLE}' 알림을 보내지 못했습니다 — .env 를 확인하세요"
  exit 0
fi

LAST="$(awk -F'\t' -v k="$KEY" '$1==k {print $2}' "$SENT_FILE" 2>/dev/null | tail -1 || true)"
# 숫자만 남긴다. 앞자리 0 은 10# 로 밑을 고정한다 — bash 는 089 를 8진수로 읽어
# 산술 오류를 내고, 3.2 는 set -e 아래서도 그것을 삼켜 복합 명령을 건너뛴다.
# 🪤 위의 `|| true` 를 빼지 마라 — set -o pipefail 아래서 파일이 없으면 awk 가 exit 2 를
#    내고 그것이 파이프 전체의 종료코드가 되어, set -e 가 이 대입에서 스크립트를 죽인다
#    (2026-08-19 구현 중 실측 — status.sh 가 같은 자리에 || true 를 단 이유와 같다).
case "$LAST" in ''|*[!0-9]*) LAST=0 ;; esac
LAST=$((10#$LAST))
# 하한은 키마다 갈린다 — 요약은 하루 1통, 항목 전환은 6시간. ⛔ 새 명령어를 만들지
# 않는다: 발송·재시도·마커·잠금 경로를 한 벌로 유지하는 편이 이 파일의 취지다.
case "$KEY" in
  digest) FLOOR_H=$DIGEST_MIN_INTERVAL_H ;;
  *)      FLOOR_H=$RESEND_MIN_INTERVAL_H ;;
esac
# 시계 역행(미래 기록)은 리셋한다 — 승격이 늦어지는 쪽이 아니라 **막히는** 쪽이라
# 그대로 두면 발송이 영영 안 나간다.
[ "$LAST" -gt "$NOW" ] && LAST=0
if [ "$LAST" -gt 0 ] && [ $(( (NOW - LAST) / 3600 )) -lt "$FLOOR_H" ]; then
  exit 0
fi

# 봇 이름("WAG 서버")이 알림 앞에 이미 붙으므로 본문에 서비스명을 다시 넣지 않는다.
TEXT="🔴 ${TITLE} — ${DETAIL}"

send_once() {
  local code
  code="$($CURL -s -o /dev/null -m 10 -w '%{http_code}' \
    -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${CHAT}" \
    --data-urlencode "text=${TEXT}" 2>/dev/null || true)"
  [ "$code" = "200" ]
}

# 재시도 간격은 테스트가 0 으로 낮춘다 — vitest 기본 타임아웃이 5초라, 실패 경로에
# 고정 sleep 을 두면 부하 시 무관한 파일까지 흔들리는 플레이크가 된다(이 레포 실측).
RETRY_DELAY_S="${NOTIFY_RETRY_DELAY_S:-2}"

if send_once || { sleep "$RETRY_DELAY_S"; send_once; }; then
  if with_lock; then
    drop_key
    printf '%s\t%s\n' "$KEY" "$NOW" >> "$SENT_FILE" 2>/dev/null || true
    release_lock
  fi
  append_history
  rm -f "$FAIL_MARKER" 2>/dev/null || true
else
  write_marker send "'${TITLE}' 알림 발송에 실패했습니다 — 네트워크·토큰을 확인하세요"
fi

exit 0
