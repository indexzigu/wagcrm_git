#!/usr/bin/env bash
set -euo pipefail

# 메뉴바 앱의 상태 판정 SSOT — 읽기 전용. 파괴적 명령(docker rm/stop/kill,
# launchctl bootout/bootstrap, rm -rf)은 이 파일에 있어서는 안 된다(계약:
# scripts/__tests__/menubar-status.test.ts). 화면 문구(detail)는 운영자 언어로
# 여기서 완성한다 — 앱(Swift)은 파싱·표시만 한다. 로그 형식 지식(백업 로그의
# 「완료:」 줄 등)도 이 파일에만 둔다 — 서버 스크립트가 바뀌면 여기를 함께 고친다.
#
# ℹ️ 예외 1건(2026-08-19): 지속 「확인 불가」 승격을 위해 자기 상태 파일
#    (status-unknown-streak.tsv) **하나만** 쓴다. "읽기 전용" 의 취지는 파괴적 시스템 조작
#    금지이지 파일을 하나도 안 쓴다는 뜻이 아니다 — 계약이 막는 것도 파괴적 명령이다.
#
#   status.sh [--fast]   # --fast: 경량 검사(내부 HTTP·docker·plist)만
#
# 설계 정본: docs/private/specs/2026-08-14-menubar-server-control-design.md
#
# ⛔ 「새 버전 대기」 판정은 2026-08-14 에 release-status.sh 로 이관됐다(오너 승인).
#    여기서 다시 만들지 말 것 — 같은 판정이 두 스크립트에 있으면 갈라진다.

PREVIEW_CHECKOUT="$HOME/selfhost/wagcrm-preview"
DEV_CHECKOUT="$HOME/Projects/wag-crm"
PREVIEW_PLIST="$HOME/Library/LaunchAgents/kr.ygrd.wagcrm.preview.plist"
LOGS_DIR="$HOME/selfhost/logs"
PROD_PORT=3000
PREVIEW_PORT=3001
DEV_PORT=3002
PROD_EXTERNAL_URL="https://crm.ygrd.kr"

MODE="full"
[ "${1:-}" = "--fast" ] && MODE="fast"

# launchd 컨텍스트 대비 PATH 보강.
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"

# 테스트 훅 — 계약 테스트가 curl/docker/git 을 데이터 파일 스텁("bash <impl>")로
# 갈아끼운다. 미설정이면 실제 명령. PATH 스텁(실행파일 신규 생성)을 쓰지 않는 이유는
# gh-stub-guard.contract.test.ts 계약이다 — macOS 가 새 실행파일 첫 execve 마다
# 보안 검사(400~700ms)를 돌려 부하 시 테스트 타임아웃으로 번진다.
CURL="${STATUS_CURL_CMD:-curl}"
DOCKER="${STATUS_DOCKER_CMD:-docker}"
GIT="${STATUS_GIT_CMD:-git}"
GH="${STATUS_GH_CMD:-gh}"

NOW_EPOCH="$(date +%s)"

# ── 지속 「확인 불가」 승격 ──────────────────────────────────────────────────
# 설계 정본: docs/private/specs/2026-08-19-sustained-unknown-escalation-design.md
#
# unknown 이 오래 이어지면 그 자체가 사고다 — 감시기가 눈이 먼 채 화면은 조용한 상태.
# 승격 조건이 **둘**인 것이 이 판정의 중심이다: 경과만 쓰면 맥이 잠든 것을 장애로 읽어
# (자는 동안 폴링이 멈추므로) 깨자마자 빨강이 되고, 매일 아침 울리는 알림은 곧 무시당한다.
# 자는 동안에는 관측이 쌓이지 않으므로 횟수를 함께 요구하면 그 오판이 구조적으로 막힌다.
# ⛔ 둘 중 하나만 쓰는 것으로 "단순화" 하지 말 것.
#
# 🪤 정상 폴링(300초)이면 12회는 1시간이면 채워진다 — 실질 게이트는 경과 3시간이고 횟수는
#    그 아래 깔린 하한이다. 3시간을 36회로 환산해 요구하면 반대 사고가 난다(폴링을 몇 번
#    놓친 정상 상황에서 영영 승격되지 않는다).
UNKNOWN_ESCALATE_AFTER_H=3
UNKNOWN_ESCALATE_MIN_OBS=12
# firstSeen 이 비현실적으로 오래됐으면(파일 손상·수기 편집) "확인 불가가 496424시간째
# 입니다" 처럼 운영자 언어가 아닌 수치가 나간다(firstSeen=0 리뷰 실측). 1년(8760h) 을
# 고른 이유: 정상 운영에서 unknown 연속이 이만큼 길게 이어질 수 없다 — 그 전에 디스크·
# 크론 등 다른 신호가 먼저 빨강이 되거나 오너가 개입한다. firstSeen=0 이면 지금 기준
# 약 50년어치 시간이 나오므로 이 문턱은 넉넉히 아래다.
STREAK_FIRSTSEEN_MAX_AGE_H=8760
# ⛔ disk 는 넣지 말 것 — 오너 지시(디스크 잔여는 알리지 않고 화면 표시만 유지한다).
#    제외는 누락이 아니라 결정이다.
UNKNOWN_ESCALATABLE_KEYS="db backupDaily backupWeekly crons"
STREAK_FILE="$LOGS_DIR/status-unknown-streak.tsv"
STREAK_PREV="$(cat "$STREAK_FILE" 2>/dev/null || true)"
STREAK_NEXT=""

# $CURL 은 의도적으로 미인용 — 테스트 훅이 "bash <경로>" 두 단어를 줄 수 있다.
http_code() { $CURL -o /dev/null -s -m 5 -w '%{http_code}' "$1" 2>/dev/null || true; }

# "20260813-040000" → epoch. macOS(BSD date)와 CI(GNU date)의 플래그가 갈리므로
# 양쪽에 다 있는 perl 로 통일한다.
stamp_epoch() {
  perl -e 'use Time::Local; my ($d,$t) = split /-/, $ARGV[0];
    my ($y,$mo,$da) = unpack("A4 A2 A2", $d); my ($h,$mi,$s) = unpack("A2 A2 A2", $t);
    print timelocal($s,$mi,$h,$da,$mo-1,$y);' "$1" 2>/dev/null || true
}

json_str() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

# 1240 → "1,240". 운영자가 읽는 숫자라 구분자를 넣는다. printf "%'d" 는 로케일에
# 의존해 CI(LC_ALL=C)에서 조용히 구분자를 잃으므로 sed 루프로 고정한다.
group_num() { printf '%s' "$1" | sed -e :a -e 's/\(.*[0-9]\)\([0-9]\{3\}\)/\1,\2/;ta'; }

ITEMS=""
emit() { # key level title detail [extraRawJson]
  local row key="$1" level="$2" prev first count elapsed_h escalatable
  case " $UNKNOWN_ESCALATABLE_KEYS " in
    *" $key "*) escalatable=1 ;;
    *)          escalatable=0 ;;
  esac
  # 승격 "적용"(기존 기록을 읽고 문턱을 넘겼으면 error 로 덮어쓰는 것)은 양쪽 모드에서
  # read-only 로 한다. db 는 --fast 에도 나오는 유일한 승격 대상이라, 여기를 full
  # 전용으로 남겨두면 이미 승격된 db 가 fast 폴링마다 plain unknown 으로 되돌아가고,
  # 앱은 병합만 하고 notifyOnNewErrors 가 매 새로고침(fast 포함) 실행되므로 그 unknown 이
  # notifiedErrorKeys 를 지워 다음 full 이 다시 알림을 쏘는 무한 반복이 난다
  # (2026-08-19 리뷰 실측 — 행이 빨강↔회색으로 깜빡이며 300초마다 재알림).
  # "증가"(count+1)와 STREAK_NEXT 기록은 여전히 full 전용이다 — fast(30초)에서 세면
  # 12회를 6분에 채운다. unknown 이 아닌 판정은 STREAK_NEXT 에 넣지 않는다 = 기록
  # 제거 = 연속이 끊긴다.
  if [ "$escalatable" = 1 ] && [ "$level" = "unknown" ]; then
    prev="$(printf '%s\n' "$STREAK_PREV" | awk -F'\t' -v k="$key" '$1==k {print $2"\t"$3}')"
    first="${prev%%$'\t'*}"
    count="${prev##*$'\t'}"
    # 망가진 기록·시계 역행은 리셋한다 — 승격이 늦어질 뿐 거짓 빨강은 안 난다.
    case "$first" in ''|*[!0-9]*) first="$NOW_EPOCH"; count=0 ;; esac
    case "$count" in ''|*[!0-9]*) count=0 ;; esac
    # 위 case 는 숫자만으로 된 문자열임을 보장할 뿐, 앞자리 0 은 걸러내지 않는다. bash 는
    # $(( )) 산술식뿐 아니라 `[ -gt ]` 류의 test 산술 비교에서도 앞자리 0 을 8진수로 읽는다
    # — 089 처럼 8·9 를 포함하면 산술 오류가 나고, bash 3.2 는 set -e 아래서도 이 오류를
    # 조용히 삼켜 그 복합 명령만 건너뛴다(리뷰 실측: crons\t<epoch>\t089 를 심으면 exit 0
    # 인데 crons·disk 가 통째로 페이로드에서 빠졌다). 10# 로 밑을 고정해 이후의 모든 산술·
    # 비교가 항상 십진수로 읽게 만든다 — 이후 first·count 사용은 전부 이 정규화된 값이다.
    first=$((10#$first))
    count=$((10#$count))
    if [ "$first" -gt "$NOW_EPOCH" ]; then first="$NOW_EPOCH"; count=0; fi
    # firstSeen 이 비현실적으로 오래됐으면(파일 손상·수기 편집) 리셋한다 — 사유·문턱 값은
    # STREAK_FIRSTSEEN_MAX_AGE_H 선언부 주석 참고.
    if [ $(( (NOW_EPOCH - first) / 3600 )) -gt "$STREAK_FIRSTSEEN_MAX_AGE_H" ]; then
      first="$NOW_EPOCH"; count=0
    fi
    if [ "$MODE" = "full" ]; then
      count=$((count + 1))
      STREAK_NEXT="${STREAK_NEXT}${key}	${first}	${count}
"
    fi
    elapsed_h=$(( (NOW_EPOCH - first) / 3600 ))
    if [ "$elapsed_h" -ge "$UNKNOWN_ESCALATE_AFTER_H" ] && [ "$count" -ge "$UNKNOWN_ESCALATE_MIN_OBS" ]; then
      level="error"
      # 원래 문구를 지우지 않는다 — 승격된 빨강과 진짜 장애 빨강은 조치가 다르다.
      set -- "$1" "$level" "$3" "확인 불가가 ${elapsed_h}시간째입니다(${count}회 연속) · $4" "${5:-}"
    fi
  fi
  row="{\"key\":\"$1\",\"level\":\"$level\",\"title\":\"$(json_str "$3")\",\"detail\":\"$(json_str "$4")\"${5:+,$5}}"
  ITEMS="${ITEMS:+$ITEMS,}$row"
}

# ── 경량 검사 ────────────────────────────────────────────────

LOCAL_CODE="$(http_code "http://127.0.0.1:$PROD_PORT/")"
case "$LOCAL_CODE" in
  ""|000) emit prodLocal error "메인 서버(내부)" "이 컴퓨터에서 응답이 없습니다 — 서버가 꺼져 있을 수 있습니다" ;;
  5??)    emit prodLocal error "메인 서버(내부)" "서버가 오류를 내고 있습니다(코드 $LOCAL_CODE)" ;;
  *)      emit prodLocal ok    "메인 서버(내부)" "응답 정상" ;;
esac

DB_STATE="$($DOCKER inspect -f '{{.State.Status}}' supabase-db 2>/dev/null || true)"
if [ "$DB_STATE" = "running" ]; then
  emit db ok "데이터베이스" "정상 작동 중"
elif [ -z "$DB_STATE" ]; then
  if [ -n "${STATUS_DOCKER_CMD:-}" ] || command -v docker >/dev/null 2>&1; then
    emit db error "데이터베이스" "데이터베이스가 보이지 않습니다"
  else
    emit db unknown "데이터베이스" "확인 불가(도구 없음)"
  fi
else
  emit db error "데이터베이스" "데이터베이스가 멈춰 있습니다($DB_STATE)"
fi

# 개발 서버(주 레인, 포트 3002 — dev.sh). 꺼져 있는 것이 정상 상태다.
# 켜져 있으면 개발 체크아웃의 브랜치를 함께 보여준다 — 그 체크아웃은 다른 세션이
# 임의 브랜치·낡은 커밋에 둘 수 있어, 브랜치를 숨기면 "왜 옛 화면이 뜨지"가 된다.
DEV_CODE="$(http_code "http://127.0.0.1:$DEV_PORT/")"
case "$DEV_CODE" in
  ""|000) emit devServer ok "개발 서버" "꺼져 있음" '"state":"down"' ;;
  *)
    DEV_BRANCH="$($GIT -C "$DEV_CHECKOUT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    emit devServer ok "개발 서버" "켜져 있음 · localhost:$DEV_PORT${DEV_BRANCH:+ · $DEV_BRANCH 브랜치}" '"state":"up"' ;;
esac

# 상태 SSOT 는 plist 존재 여부다(preview.sh 와 동일 기준). 닫힌 동안 외부 주소가
# 안 열리는 것은 정상이므로 down 을 빨간불로 만들지 않는다(설계 원칙).
if [ -f "$PREVIEW_PLIST" ]; then
  PV_CODE="$(http_code "http://127.0.0.1:$PREVIEW_PORT/")"
  PV_BRANCH="$($GIT -C "$PREVIEW_CHECKOUT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  case "$PV_CODE" in
    ""|000) emit preview warn "프리뷰 서버" "켜져 있는데 아직 응답이 없습니다 — 여는 중이거나 문제가 있습니다" '"state":"up"' ;;
    *)      emit preview ok   "프리뷰 서버" "켜져 있음${PV_BRANCH:+ · $PV_BRANCH 브랜치}" '"state":"up"' ;;
  esac
else
  emit preview ok "프리뷰 서버" "꺼져 있음 (바깥 주소가 안 열리는 것은 정상입니다)" '"state":"down"'
fi

# ── 중량 검사(full 전용) ─────────────────────────────────────

if [ "$MODE" = "full" ]; then
  EXT_CODE="$(http_code "$PROD_EXTERNAL_URL")"
  case "$EXT_CODE" in
    ""|000|5??)
      # 내부는 되는데 외부만 안 되면 원인이 다르다(터널) — 구분해서 말해준다.
      if [ "$LOCAL_CODE" != "" ] && [ "$LOCAL_CODE" != "000" ]; then
        emit prodExternal error "메인 서버(외부)" "컴퓨터 안에서는 도는데 바깥(crm.ygrd.kr)에서 안 열립니다 — 터널 문제로 보입니다"
      else
        emit prodExternal error "메인 서버(외부)" "바깥(crm.ygrd.kr)에서 열리지 않습니다"
      fi ;;
    *) emit prodExternal ok "메인 서버(외부)" "바깥에서도 잘 열립니다" ;;
  esac

  backup_item() { # key title logfile tag warnH errH
    local key="$1" title="$2" logfile="$3" tag="$4" warn_h="$5" err_h="$6"
    local line stamp epoch age_h when
    line="$(grep "\[$tag\] 완료:" "$logfile" 2>/dev/null | tail -1 || true)"
    stamp="$(printf '%s' "$line" | grep -oE '[0-9]{8}-[0-9]{6}' | tail -1 || true)"
    if [ -z "$stamp" ]; then
      emit "$key" unknown "$title" "성공 기록을 찾지 못했습니다 — 확인 불가"
      return
    fi
    epoch="$(stamp_epoch "$stamp")"
    if [ -z "$epoch" ]; then
      emit "$key" unknown "$title" "확인 불가(기록 해석 실패)"
      return
    fi
    age_h=$(( (NOW_EPOCH - epoch) / 3600 ))
    when="${stamp:4:2}/${stamp:6:2} ${stamp:9:2}시"
    if [ "$age_h" -ge "$err_h" ]; then
      emit "$key" error "$title" "마지막 성공이 $when — 너무 오래됐습니다"
    elif [ "$age_h" -ge "$warn_h" ]; then
      emit "$key" warn "$title" "마지막 성공이 $when — 예정보다 늦어지고 있습니다"
    else
      emit "$key" ok "$title" "$when 성공"
    fi
  }
  backup_item backupDaily  "매일 백업" "$LOGS_DIR/backup.out.log"        backup        26 50
  backup_item backupWeekly "주간 백업" "$LOGS_DIR/backup-weekly.out.log" backup-weekly 192 360

  # ── 자동 작업(크론) 지연·실패 ────────────────────────────────────────────
  # 설계 정본: docs/private/specs/2026-08-19-cron-staleness-alert-design.md
  #
  # 🪤 이 두 문턱은 src/lib/cron-staleness.ts 의 STALE_GRACE_MS 와 **같은 값이어야 한다** —
  #    어긋나면 레이더는 노랑인데 메뉴바는 초록인 상태가 생기고, 둘 다 열어 보기 전엔
  #    드러나지 않는다. cron-staleness-threshold-parity.contract.test.ts 가 기계로 고정한다.
  CRON_DAILY_LIMIT_H=30    # 매일 = 24h 주기 + 유예 6h
  CRON_WEEKLY_LIMIT_H=192  # 매주 = 7d 주기 + 유예 24h

  # 질문은 하나다: "이 잡의 마지막 SUCCESS 기록이 언제인가". 실패한 실행은 SUCCESS 행을
  # 만들지 않으므로 「안 돌았다」와 「돌았는데 실패했다」를 한 번에 답한다 —
  # withSystemTaskStatus 가 2xx + failed:true 도 ERROR 로 강등하기 때문이다(소스 실측).
  # ⛔ 응답 본문을 다시 파싱하는 분기를 만들지 말 것.
  #
  # ⛔ 이 판정을 크론 잡으로 옮기지 말 것 — 크론으로 크론을 감시하면 대상과 함께 죽는다
  #    (2026-08-19 실사고: 상태 기록도 DB 쓰기라 DB 가 원인이던 실패에서 6일간 무음이었다).
  #    발화 주체가 메뉴바 앱의 독립 타이머라는 것이 이 판정의 존재 이유다.
  #
  # 대상 목록은 **레포의 crontab**(설치본 `crontab -l` 이 아니다)에서 온다 — 머지됐는데
  # 기계에 재설치되지 않은 잡도 SUCCESS 가 안 쌓여 지연으로 드러나게 하려는 의도다.
  CRONTAB_FILE="${STATUS_CRONTAB_FILE:-$(dirname "$0")/crontab}"
  CRON_SQL="select \"jobKey\", floor(extract(epoch from max(\"createdAt\")))::bigint from \"SystemTaskLog\" where status = 'SUCCESS' group by 1;"
  # $DOCKER 는 의도적 미인용(테스트 훅이 "bash <경로>" 두 단어를 줄 수 있다 — 기존 규약).
  CRON_ROWS="$($DOCKER exec supabase-db psql -U supabase_admin -d postgres -At -F'|' -c "$CRON_SQL" 2>/dev/null || true)"

  if [ ! -r "$CRONTAB_FILE" ]; then
    # 크론탭 자체를 못 읽는 것은 DB 실행 기록과 무관한 원인이다(파일 부재·권한) —
    # "실행 기록을 읽지 못했습니다"는 DB 조회 실패 문구이므로 여기서 섞으면 운영자가
    # 엉뚱하게 Postgres 를 들여다보게 된다. 예약 목록 쪽 문구로 분리한다.
    emit crons unknown "자동 작업" "확인 불가 — 예약 목록을 읽지 못했습니다"
  elif [ -z "$CRON_ROWS" ]; then
    # 크론탭은 읽었는데 DB 조회(SUCCESS 기록)가 비었거나 실패한 경우 — 모르는 것을
    # 초록으로 가장하지 않는 쪽이 이 파일의 규약이다(db-exposure-audit 의 "0개는 감사 불능"과 같은 선).
    emit crons unknown "자동 작업" "확인 불가 — 실행 기록을 읽지 못했습니다"
  else
    cron_total=0; cron_late=0; cron_never=0; cron_late_names=""
    while read -r c_min c_hour c_dom c_mon c_dow c_rest; do
      c_job="${c_rest##*run-cron.sh }"
      c_job="${c_job%% *}"
      [ -z "$c_job" ] && continue
      cron_total=$((cron_total + 1))
      # 요일 필드가 * 면 매일, 아니면 매주 — cron-staleness.ts 의 resolveCadence 와 같은 규칙.
      if [ "$c_dow" = "*" ]; then c_limit_h=$CRON_DAILY_LIMIT_H; else c_limit_h=$CRON_WEEKLY_LIMIT_H; fi
      c_last="$(printf '%s\n' "$CRON_ROWS" | awk -F'|' -v j="$c_job" '$1==j {print $2}')"
      # 빈 값과 숫자가 아닌 값을 한 번에 "기록 없음"으로 접는다 — set -euo pipefail 아래
      # 산술식에 숫자 아닌 값을 넣으면 bash 가 변수 참조로 오인해 스크립트 전체가
      # 죽는다(NULL: unbound variable). 컬럼이 NOT NULL 이라 오늘은 도달하지 않지만,
      # 가드가 없으면 이 한 행의 이상값이 패널 전체(prodLocal·db·disk·백업)를
      # statusUnavailable 로 끌고 간다.
      case "$c_last" in
        ''|*[!0-9]*) cron_never=$((cron_never + 1)); continue ;;
      esac
      # 분 단위로 비교한다(레이더는 정확한 경과시간, 여기는 시간 절삭이면 최대 1h 어긋난다 —
      # cron-staleness-threshold-parity 가 고정하는 CRON_*_LIMIT_H 값·이름은 그대로 두고
      # 여기서만 분으로 환산해 절삭 오차를 없앤다).
      c_age_min=$(( (NOW_EPOCH - c_last) / 60 ))
      c_limit_min=$(( c_limit_h * 60 ))
      if [ "$c_age_min" -gt "$c_limit_min" ]; then
        cron_late=$((cron_late + 1))
        cron_late_names="${cron_late_names:+$cron_late_names, }$c_job"
      fi
    done < <(grep -E '^[0-9*].*run-cron\.sh' "$CRONTAB_FILE" 2>/dev/null || true)

    if [ "$cron_total" -eq 0 ]; then
      emit crons unknown "자동 작업" "확인 불가 — 예약 목록을 읽지 못했습니다"
    elif [ "$cron_late" -gt 0 ]; then
      # 배너는 두 줄이 상한이라 앞 3개만 싣는다. 나머지는 레이더에서 본다.
      cron_shown="$(printf '%s' "$cron_late_names" | cut -d',' -f1-3 | sed 's/^ *//;s/ *$//')"
      if [ "$cron_late" -gt 3 ]; then
        cron_shown="$cron_shown 외 $((cron_late - 3))개"
      fi
      emit crons error "자동 작업" "${cron_late}개가 예정보다 늦었습니다: $cron_shown"
    elif [ "$cron_never" -gt 0 ]; then
      # 방금 추가돼 첫 회차를 안 돈 크론이 여기다 — error 로 올리면 크론을 넣을 때마다
      # 알림이 울리고 그 학습이 알림 전체를 무시하게 만든다. 진짜로 안 도는 경우는
      # 문턱을 넘기는 순간 위 error 로 승격되므로 놓치지 않는다.
      emit crons warn "자동 작업" "${cron_never}개는 아직 성공 기록이 없습니다 — 새로 추가된 작업이면 첫 회차를 기다리세요"
    else
      emit crons ok "자동 작업" "${cron_total}개 모두 정상"
    fi
  fi

  AVAIL_KB="$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print $4}' || true)"
  if [ -n "$AVAIL_KB" ]; then
    AVAIL_GB=$(( AVAIL_KB / 1024 / 1024 ))
    if [ "$AVAIL_GB" -lt 20 ]; then
      emit disk error "디스크 공간" "남은 공간 ${AVAIL_GB}GB — 위험할 정도로 부족합니다"
    elif [ "$AVAIL_GB" -lt 50 ]; then
      emit disk warn "디스크 공간" "남은 공간 ${AVAIL_GB}GB — 여유가 줄고 있습니다"
    else
      emit disk ok "디스크 공간" "남은 공간 ${AVAIL_GB}GB"
    fi
  else
    emit disk unknown "디스크 공간" "확인 불가"
  fi

  # ── GitHub Actions 잔여 분 ──────────────────────────────────────────────
  # 2026-08-26 레포 비공개 전환으로 Actions 가 계량되기 시작했다(공개 레포는 무제한
  # 무료였다). 한도를 넘기면 preflight 가 안 돈다. ⛔ 종전 「main ruleset 의 required
  # 체크라 모든 PR 이 머지 불가」는 SUPERSEDED(T-069 — 같은 날 비공개 전환이 보호도
  # 정지시켰다): 지금은 머지가 막히는 대신 **검사 없이 머지되고, 배포 직전 게이트
  # (deploy.sh 안전장치 ⑦)에서야 막힌다**(조용한 고장). 그 사실을 알 방법이 GitHub 웹
  # UI 뿐이라는 공백은 그대로다 — 이 행은 배포가 막히기 전에 미리 아는 조기 신호다.
  #
  # 🪤 **요약 엔드포인트는 은퇴했다(HTTP 410).** `settings/billing/actions` 는 죽었고
  #    살아 있는 것은 `settings/billing/usage` 하나다(2026-08-26 실측). 그런데 이쪽은
  #    요약이 아니라 **일자별 원장**이라 `included_minutes` 필드가 **없다** — 합산은
  #    우리가 하고 한도는 따로 알아내야 한다. 은퇴한 경로로 되돌리지 말 것.
  #
  # 🪤 조회에는 `user` 스코프가 필요하다(실측: repo·workflow 만으로는 404). 없으면 이
  #    행은 회색 「확인 불가」로 뜨고 조치 명령을 함께 싣는다 — 모르는 것을 초록으로
  #    가장하지 않는다(이 파일의 규약). PATH 보강은 파일 상단에서 이미 했다(앱이 주는
  #    PATH 는 /usr/bin:/bin:/usr/sbin:/sbin 뿐이라 gh 가 안 보인다).
  #
  # ⛔ watched(알림 감시 목록)에 넣지 말 것 — 오너 결정(2026-08-26): 디스크 잔여와
  #    같은 부류로 **화면 색으로만** 알리고 알림은 보내지 않는다. 전달 계약
  #    menubar-app-delegation.test.ts 의 NOTIFY_EXEMPT 에 사유와 함께 등재돼 있다.
  #
  # ⛔ UNKNOWN_ESCALATABLE_KEYS 에 넣지 말 것 — unknown 은 패널에서 이미 접히지 않고
  #    항상 펼쳐진다(정상 항목 접기). 여기서 승격은 소음만 늘린다.
  ACTIONS_OWNER="indexzigu"
  ACTIONS_WARN_PCT=20
  ACTIONS_ERROR_PCT=5

  # 플랜별 포함 분. ⛔ 2,000 을 그냥 상수로 박지 말 것 — 플랜이 바뀌면 조용히 틀린
  # 비율을 보여주고, 그 오차는 실제로 바닥날 때까지 드러나지 않는다. 원래는 API 의
  # included_minutes 를 쓰려 했으나 그 엔드포인트가 은퇴해 값 자체가 사라졌다(위 🪤)
  # — 대신 **실 플랜 이름**으로 고른다. 모르는 이름은 추측하지 않고 확인 불가로 간다.
  # 사용자 계정 플랜은 free·pro 둘이다(team·enterprise 는 조직 플랜이라 여기 안 온다).
  actions_included_minutes() { # $1 = plan.name
    case "$1" in
      free) printf '2000' ;;
      pro)  printf '3000' ;;
      *)    printf '' ;;
    esac
  }

  # gh 실패 사유를 버킷으로 접는다 — 원시 stderr 를 상시 표시 행에 흘리지 않는다
  # (release-status.sh 의 fail_reason 과 같은 계열). 스코프 부족과 엔드포인트 이전은
  # 조치가 서로 달라 따로 가른다 — 앞은 오너가 1회 조작으로 풀고, 뒤는 이 스크립트를
  # 고쳐야 한다. 410 버킷은 이 기능이 실제로 밟은 함정이라 자기진단으로 남긴다.
  actions_fail_reason() { # $1 = stderr 전문
    case "$1" in
      *'"user" scope'*|*'user scope'*)
        printf '확인 불가 — 조회 권한이 없습니다. 터미널에서 gh auth refresh -h github.com -s user 를 1회 실행하세요' ;;
      *"has been moved"*|*"HTTP 410"*)
        printf '확인 불가 — GitHub 사용량 API 가 이전됐습니다. status.sh 의 조회 경로를 고쳐야 합니다' ;;
      *"auth login"*|*authentication*|*"HTTP 401"*)
        printf '확인 불가 — GitHub 로그인이 필요합니다' ;;
      *) printf '확인 불가 — GitHub 사용량 조회에 실패했습니다' ;;
    esac
  }

  # 🪤 템플릿을 명시한다 — `mktemp -t <접두사>` 는 BSD(macOS) 전용이고 GNU
  # coreutils(CI ubuntu)에서는 `too few X's in template` 로 즉사한다.
  # gh stderr 를 받는 임시 파일 — 아래 러너 행과 **공유한다**. bash 의 EXIT trap 은
  # 자리가 하나뿐이라 블록마다 따로 걸면 나중 것이 앞의 것을 지운다(= 임시 파일이
  # 남는다). 그래서 파일도 trap 도 여기 하나로 둔다. 2>&1 로 합치지 않는 이유는
  # gh 가 성공 시에도 stderr 로 버전 알림을 흘릴 수 있어서다 — 그러면 값이 오염된다.
  GH_ERR="$(mktemp "/tmp/status-gh.XXXXXX")"
  trap 'rm -f "$GH_ERR"' EXIT

  # 월 필터는 `month=8` 처럼 앞자리 0 없이 준다 — date +%m 은 "08" 을 주므로 10# 으로
  # 십진 정규화한다(그냥 넘기면 bash 가 8진수로 읽어 08·09 에서 산술 오류가 난다).
  ACTIONS_YEAR="$(date +%Y)"
  ACTIONS_MONTH="$((10#$(date +%m)))"

  # $GH 는 의도적 미인용(테스트 훅이 "bash <경로>" 두 단어를 줄 수 있다 — 기존 규약).
  # 합산 대상은 product=actions 이면서 단위가 Minutes 인 항목이다(Actions storage 는
  # GigabyteHours 라 여기 섞이면 안 된다). 두 번째 값은 "이미 청구가 붙었는가" 다 —
  # 아래에서 「쓴 분」과 「한도를 갉은 분」을 가르는 데 쓴다.
  if ACTIONS_OUT="$($GH api "users/$ACTIONS_OWNER/settings/billing/usage?year=$ACTIONS_YEAR&month=$ACTIONS_MONTH" \
      --jq '[.usageItems[] | select(.product=="actions" and .unitType=="Minutes")] | "\(([.[].quantity]|add // 0)|floor)|\(([.[].netAmount]|add // 0) > 0)"' 2>"$GH_ERR")"; then
    ACT_USED="${ACTIONS_OUT%%|*}"
    ACT_BILLED="${ACTIONS_OUT##*|}"
    # 두 필드가 다 온전할 때만 판정한다. 한쪽이라도 이상하면 분기를 조용히 잘못 고르는
    # 대신 확인 불가로 간다 — 구분자가 없으면 %% 와 ## 가 같은 문자열을 주기 때문에
    # 이 검사가 없으면 통짜 응답이 숫자 분기로 새어 들어간다.
    case "$ACT_BILLED" in true|false) ;; *) ACT_USED="" ;; esac
    case "$ACT_USED" in ''|*[!0-9]*) ACT_USED="" ;; esac
    ACT_PLAN="$($GH api "users/$ACTIONS_OWNER" --jq '.plan.name' 2>/dev/null || true)"
    ACT_INCLUDED="$(actions_included_minutes "$ACT_PLAN")"
    if [ -z "$ACT_USED" ]; then
      emit actionsQuota unknown "GitHub Actions" "확인 불가 — 사용량 응답을 해석하지 못했습니다"
    elif [ -z "$ACT_INCLUDED" ]; then
      # 사용량은 알지만 한도를 모르는 상태 — 아는 것만 말한다. 한도를 짐작해 비율을
      # 지어내면 그 숫자가 오너의 판단을 직접 오도한다.
      emit actionsQuota unknown "GitHub Actions" "한도를 확인하지 못했습니다 — 이달 $(group_num "$((10#$ACT_USED))")분 사용${ACT_PLAN:+ · 플랜 $ACT_PLAN}"
    else
      ACT_USED=$((10#$ACT_USED))
      ACT_NUMS="$(group_num "$ACT_USED") / $(group_num "$ACT_INCLUDED")분"
      if [ "$ACT_BILLED" = "true" ]; then
        emit actionsQuota error "GitHub Actions" "$ACT_NUMS 사용"
      elif [ "$ACT_USED" -ge "$ACT_INCLUDED" ]; then
        # 🪤 「쓴 분」과 「한도를 갉은 분」은 다르다. 공개 레포 실행은 계량은 되지만
        #    한도를 소비하지 않는다(2026-08 실측: 6,591분 전부 netAmount 0 —
        #    discountAmount 가 grossAmount 를 그대로 상쇄). 여기서 빨강을 내면 막히지도
        #    않은 상태로 거짓 경보가 되고, 그 학습이 진짜 빨강까지 무시하게 만든다.
        # 문구는 위 error 분기와 같다 — 청구가 붙는 구조가 아니라는 오너 판단으로
        # 청구 표기를 뺐다(2026-08-27). 두 분기를 가르는 것은 이제 색뿐이다.
        emit actionsQuota warn "GitHub Actions" "$ACT_NUMS 사용"
      else
        ACT_LEFT=$(( ACT_INCLUDED - ACT_USED ))
        ACT_PCT=$(( ACT_LEFT * 100 / ACT_INCLUDED ))
        ACT_LEFTNUMS="$(group_num "$ACT_LEFT") / $(group_num "$ACT_INCLUDED")분 남음(${ACT_PCT}%)"
        if [ "$ACT_PCT" -lt "$ACTIONS_ERROR_PCT" ]; then
          emit actionsQuota error "GitHub Actions" "$ACT_LEFTNUMS"
        elif [ "$ACT_PCT" -lt "$ACTIONS_WARN_PCT" ]; then
          emit actionsQuota warn "GitHub Actions" "$ACT_LEFTNUMS"
        else
          emit actionsQuota ok "GitHub Actions" "$ACT_LEFTNUMS"
        fi
      fi
    fi
  else
    emit actionsQuota unknown "GitHub Actions" "$(actions_fail_reason "$(cat "$GH_ERR" 2>/dev/null || true)")"
  fi

  # ── PR 검사 러너(자가호스트) ─────────────────────────────────────────────
  # `release-preflight` 의 두 잡(preflight·test)은 2026-08-26 부터 이 맥의 Colima VM
  # 러너에서 돈다(P6 「Self-Hosted Preflight Runner」). ⛔ 종전 「main ruleset 의
  # required 체크라 러너가 끊기면 모든 PR 의 머지가 막힌다」는 SUPERSEDED(T-069 보호
  # 정지): 지금은 러너가 끊겨도 머지는 되고 **검사 없는 머지가 배포 직전 게이트
  # (deploy.sh 안전장치 ⑦)에 걸려 그때 배포가 막힌다**(조용한 고장). 그것을 아는 방법이
  # 사람이 gh 를 손으로 치는 것뿐이라는 공백은 그대로다 — 이 행이 조기 신호를 준다
  # (actionsQuota 와 같은 계열의 무증상 열화).
  #
  # **판정 축이 둘인 것이 이 행의 중심이다:**
  #   ① 어느 쪽으로 도는가 = 레포 변수 PREFLIGHT_RUNNER (비었으면 ubuntu-latest 폴백)
  #   ② 그쪽이 살아 있는가 = 등록된 러너 중 online 인 대수
  # ⛔ ②만 보고 빨강을 내지 말 것 — 폴백 중에는 러너가 전부 꺼져 있어도 머지는 정상이라
  #    상시 오탐이 된다. 그래서 ①을 **먼저** 묻고, 폴백이면 ②는 묻지도 않는다(왕복도 준다).
  #
  # 🪤 online 은 「지금 붙어 있다」 이상을 뜻하지 않는다(2026-08-26 실측된 오독 — 러너가
  #    계속 떠 있던 구간에서는 당연히 online 이 나오므로 그 값만으로 「정상 작동」을
  #    주장할 수 없다). 문구도 그 이상을 주장하지 않는다. busy 는 판정에 넣지 않는다 —
  #    전부 busy 인 것은 큐가 도는 정상이지 장애가 아니다.
  #
  # 🪤 러너 대수를 상수로 박지 말 것. 2026-08-26 실측은 3대인데 이 수는 오너가 늘리고
  #    줄인다 — 등록 대수는 응답에서 세고 문구도 그 수로 만든다(P6 「고정 숫자 금지」).
  #
  # ⛔ UNKNOWN_ESCALATABLE_KEYS 에 넣지 말 것 — actionsQuota 와 같은 사유(unknown 행은 패널에서
  #    이미 항상 펼쳐지므로 승격은 소음만 늘린다)에 더해, 2026-08-27 부터는 **더 센 이유**가
  #    생겼다: 이 키는 이제 watched 라, 승격시키면 **gh 조회 실패(네트워크 끊김·로그인 만료)가
  #    error 로 올라가 폰이 울린다.** 「확인 불가」와 「머지가 막혔다」는 조치가 전혀 다르다.
  #
  # ℹ️ 이 행은 **알림 대상이다**(오너 결정 2026-08-27) — ServerStore.watched 에 등재돼 macOS
  #    알림·텔레그램·일일 요약 세 채널로 나간다. disk·actionsQuota 의 「잔여 자원」 부류와
  #    성격이 다르다: 이 행이 빨강인 상태는 「모든 PR 머지 불가」 하나뿐이라, 자리를 비운
  #    사이 막힌 것을 모르면 이 행을 만든 이유 자체가 무너진다.
  #    ⛔ 그래서 **error 를 내는 경로를 늘릴 때는 알림 소음을 함께 따져야 한다** — 지금 error
  #    는 둘뿐이고(등록 0대 · online 0대) 둘 다 진짜 차단 상태다. 폴백 중(노랑)·gh 실패(회색)
  #    는 알림이 나가지 않는다.
  GH_REPO="$ACTIONS_OWNER/wagcrm_git"
  RUNNER_TITLE="PR 검사 러너"
  RUNNER_FALLBACK_CMD="gh api -X DELETE repos/$GH_REPO/actions/variables/PREFLIGHT_RUNNER"

  # gh 실패 사유 버킷 — actions_fail_reason 과 같은 계열이다. 원시 stderr 를 상시 표시
  # 행에 흘리지 않고, 조치가 갈리는 것만 따로 가른다(러너 조회는 레포 관리자 권한을
  # 요구하므로 401 과 403 의 조치가 다르다).
  runner_fail_reason() { # $1 = stderr 전문
    case "$1" in
      *"auth login"*|*authentication*|*"HTTP 401"*)
        printf '확인 불가 — GitHub 로그인이 필요합니다' ;;
      *"HTTP 403"*|*"Resource not accessible"*|*"Must have admin"*)
        printf '확인 불가 — 러너를 조회할 권한이 없습니다(레포 관리자 권한이 필요합니다)' ;;
      *) printf '확인 불가 — 러너 상태 조회에 실패했습니다' ;;
    esac
  }

  # ① 어느 쪽으로 도는가. **404 는 실패가 아니라 정상 응답이다** — 변수가 없다는 것이
  #    곧 「폴백 중」이라는 답이다. 인증·네트워크 실패와 반드시 갈라야 한다(합치면 폴백
  #    중에 회색 「확인 불가」가 상시로 뜬다). 값이 빈 문자열인 경우도 폴백이다 —
  #    워크플로의 조건이 `vars.PREFLIGHT_RUNNER != ''` 라 빈 값은 ubuntu-latest 로 간다.
  RUNNER_LANE=""
  if RUNNER_LABEL="$($GH api "repos/$GH_REPO/actions/variables/PREFLIGHT_RUNNER" --jq '.value' 2>"$GH_ERR")"; then
    case "$RUNNER_LABEL" in
      ''|null) RUNNER_LANE="fallback" ;;
      *)       RUNNER_LANE="self" ;;
    esac
  else
    case "$(cat "$GH_ERR" 2>/dev/null || true)" in
      *"HTTP 404"*|*"Not Found"*)
        # 🪤 **404 는 양가적이다** — 「변수가 없다(=정상 폴백)」와 「레포를 못 본다
        #    (=인증·가시성 상실)」가 **글자 하나까지 같은 stderr** 를 낸다(2026-08-26
        #    실측: 양쪽 다 `gh: Not Found (HTTP 404)`). GitHub 이 접근 불가 레포에
        #    403 이 아니라 404 를 주기 때문이다 — 레포의 존재 자체를 숨기는 의도된
        #    동작이라 이 양가성은 없어지지 않는다.
        #    ⛔ 문자열만으로 갈랐던 종전 판정은 **인증을 잃은 상태를 「폴백 중」이라는
        #    노랑으로 단정**했다(교차 검증 지적 → 실측으로 확인). 회색 「확인 불가」로
        #    가야 할 것을 특정 주장으로 바꾸는 것이라, 오너에게 「러너만 고치면 된다」는
        #    엉뚱한 조치를 시킨다. 그래서 레포를 직접 한 번 찔러 가른다 — 보이면 변수만
        #    없는 것이고, 안 보이면 모르는 것이다.
        #    이 왕복은 **404 경로에서만** 든다(변수가 있는 평시에는 0회).
        if $GH api "repos/$GH_REPO" --jq '.name' >/dev/null 2>&1; then
          RUNNER_LANE="fallback"
        else
          RUNNER_LANE="unknown"
        fi
        ;;
      *) RUNNER_LANE="unknown" ;;
    esac
  fi

  if [ "$RUNNER_LANE" = "unknown" ]; then
    emit preflightRunner unknown "$RUNNER_TITLE" "$(runner_fail_reason "$(cat "$GH_ERR" 2>/dev/null || true)")"
  elif [ "$RUNNER_LANE" = "fallback" ]; then
    # 폴백은 「고장」이 아니라 「비싼 쪽으로 임시 우회 중」이다 — 머지는 정상으로 되지만
    # GitHub Actions 사용 시간을 쓴다(그것을 아끼려고 이 맥으로 옮긴 것이다). 그래서
    # 초록으로 덮지 않는다. 이 노랑은 「고쳤으면 되돌리라」는 표시이고 되돌리면 사라진다.
    emit preflightRunner warn "$RUNNER_TITLE" "GitHub 러너로 우회 중입니다 — 이 맥의 러너를 고친 뒤 되돌리세요(그동안 GitHub 사용 시간을 씁니다)"
  else
    # ② 그쪽이 살아 있는가. 변수 값(=워크플로의 runs-on 라벨)을 그대로 가진 러너만 센다
    #    — 오너가 라벨을 바꾸면 세는 대상도 함께 따라가야 한다. jq 에 값을 넘기는 통로는
    #    env 하나다(gh --jq 는 --arg 를 받지 않는다 — 2026-08-26 양·음성 프로브 실측).
    #    --paginate 는 쓰지 않는다: 기본 1쪽이 30대라 이 규모에서는 왕복만 는다.
    if RUNNER_COUNTS="$(RUNNER_LABEL="$RUNNER_LABEL" $GH api "repos/$GH_REPO/actions/runners" \
        --jq '[.runners[] | select([.labels[].name] | index(env.RUNNER_LABEL))] | "\(length)|\([.[] | select(.status=="online")] | length)"' 2>"$GH_ERR")"; then
      RUNNER_TOTAL="${RUNNER_COUNTS%%|*}"
      RUNNER_ONLINE="${RUNNER_COUNTS##*|}"
      # 두 필드가 다 온전할 때만 판정한다. 🪤 **구분자 존재를 따로 확인해야 한다** —
      # actionsQuota 는 두 번째 필드가 true/false 라 통짜 응답이 저절로 걸리지만, 여기는
      # 양쪽이 다 숫자라 `3` 하나만 와도 %% 와 ## 이 똑같이 "3" 을 준다. 그러면 「러너 3대
      # 전부 연결」이라는 **초록**이 되어, 해석 실패가 정상으로 둔갑한다(계약 테스트가
      # 첫 구현에서 실제로 잡은 결함이다). 앞자리 0 은 10# 으로 십진 고정한다.
      case "$RUNNER_COUNTS" in *"|"*) ;; *) RUNNER_TOTAL="" ;; esac
      case "$RUNNER_TOTAL" in ''|*[!0-9]*) RUNNER_TOTAL="" ;; esac
      case "$RUNNER_ONLINE" in ''|*[!0-9]*) RUNNER_TOTAL="" ;; esac
      if [ -z "$RUNNER_TOTAL" ]; then
        emit preflightRunner unknown "$RUNNER_TITLE" "확인 불가 — 러너 응답을 해석하지 못했습니다"
      else
        RUNNER_TOTAL=$((10#$RUNNER_TOTAL))
        RUNNER_ONLINE=$((10#$RUNNER_ONLINE))
        if [ "$RUNNER_ONLINE" -gt "$RUNNER_TOTAL" ]; then
          # 있을 수 없는 조합이다(online ⊆ 등록). 응답을 잘못 읽고 있다는 뜻이므로
          # 마지막 else 로 굴러떨어져 초록이 되게 두지 않는다.
          emit preflightRunner unknown "$RUNNER_TITLE" "확인 불가 — 러너 응답을 해석하지 못했습니다"
        elif [ "$RUNNER_TOTAL" = 0 ]; then
          emit preflightRunner error "$RUNNER_TITLE" "등록된 러너가 없습니다 — PR 검사가 시작조차 못 해 모든 PR 머지가 막힙니다. 급하면 GitHub 러너로 우회: $RUNNER_FALLBACK_CMD"
        elif [ "$RUNNER_ONLINE" = 0 ]; then
          emit preflightRunner error "$RUNNER_TITLE" "러너 ${RUNNER_TOTAL}대가 전부 끊겼습니다 — PR 검사가 돌지 않아 모든 PR 머지가 막힙니다. 급하면 GitHub 러너로 우회: $RUNNER_FALLBACK_CMD"
        elif [ "$RUNNER_ONLINE" -lt "$RUNNER_TOTAL" ]; then
          # ⛔ **여기서 노랑을 내지 말 것.** 종전에는 「끊긴 N대를 확인하세요」라고 단정했는데,
          #    2026-08-27 운영 형상이 **활성 2대 + 예비 1대(등록 유지·서비스 정지)** 로 바뀌면서
          #    그 예비가 offline 으로 잡혀 **평상시에 상시 노랑**이 됐다(실측). 상시 노랑은 이 행이
          #    막으려던 바로 그 실패다 — 늘 켜져 있는 경고는 곧 무시당하고, 그 학습이 진짜 빨강까지
          #    삼킨다.
          #    🪤 **API 로는 가를 수 없다.** `actions/runners` 는 status(online/offline)와 busy 만
          #    주고 「의도한 예비」와 「죽은 러너」를 구분할 필드가 없다. 그러니 「끊겼다」는 단정은
          #    모르는 것을 안다고 말하는 것이고, 이 행의 다른 판정(모르면 회색)과도 어긋난다.
          #    ⇒ 판정은 「검사를 받을 수 있는가」 하나로 하고(한 대라도 붙어 있으면 돈다), 두 숫자는
          #    그대로 보여 준다 — 사람이 「2/3 이 정상 형상」임을 알고 보면 1/3 로 준 것을 스스로
          #    알아본다. 기계가 못 가르는 것을 사람에게 넘기되 재료는 다 준다.
          emit preflightRunner ok "$RUNNER_TITLE" "러너 ${RUNNER_ONLINE}대가 연결돼 있습니다(등록 ${RUNNER_TOTAL}대) — 차이는 예비이거나 꺼진 것입니다"
        else
          emit preflightRunner ok "$RUNNER_TITLE" "러너 ${RUNNER_ONLINE}대가 연결돼 있습니다"
        fi
      fi
    else
      emit preflightRunner unknown "$RUNNER_TITLE" "$(runner_fail_reason "$(cat "$GH_ERR" 2>/dev/null || true)")"
    fi
  fi

  # ── 외부 알림 전달 상태 ──────────────────────────────────────────────────
  # notify.sh 가 마커를 남기면(사유: unconfigured 자격값 없음 · send 발송 실패 ·
  # probe 도달성 확인 실패) 그것을 warn 행으로 보여준다. 오너가 자리로 돌아왔을 때
  # "그동안 못 나갔다"를 알 수 있는 유일한 지점이다. 마커 형식은
  # <epoch><TAB><사유코드><TAB><사람이 읽는 문구> 한 줄 — 문구(3번째 필드)를
  # 그대로 싣는다(notify.sh 가 이미 운영자 언어로 완성한 것이라 여기서 재조립하지
  # 않는다).
  #
  # ⛔ ok 문구를 "정상"이라 쓰지 않는다 — 마커가 없다는 것은 "실패를 관측하지
  #    못했다"는 뜻이지 "성공을 관측했다"는 뜻이 아니다(2026-08-19 리뷰 지적 C1:
  #    자격값이 통째로 없어 notify.sh 가 매번 조용히 exit 0 하던 시절에도 이
  #    줄은 "정상"을 단언하고 있었다 — 한 번도 관측한 적 없는 사실이었다).
  #
  # ⛔ error 로 올리지 말 것 — 전달 계약(error 가능 키 ⊆ watched)이 이 키를 감시
  #    목록에 요구하게 되고, 그러면 **발송 실패를 발송으로 알리려는** 자기참조가 된다.
  #    warn 은 알림 대상이 아니라 그 고리가 성립하지 않는다.
  ALERT_FAIL_MARKER="$LOGS_DIR/alert-send-failed"
  if [ -f "$ALERT_FAIL_MARKER" ]; then
    ALERT_FAIL_LINE="$(head -1 "$ALERT_FAIL_MARKER" 2>/dev/null || true)"
    ALERT_FAIL_MSG="$(printf '%s' "$ALERT_FAIL_LINE" | awk -F'\t' '{print $3}' 2>/dev/null || true)"
    emit alertDelivery warn "외부 알림" "${ALERT_FAIL_MSG:-폰으로 보내지 못한 알림이 있습니다 — 토큰·네트워크를 확인하세요}"
  else
    emit alertDelivery ok "외부 알림" "최근 발송 실패 없음"
  fi
fi

# 상태 저장은 full 모드에서만. 쓰기 실패는 승격 불발로 끝나고(현행과 같다) 패널을 죽이지
# 않는다 — 이 방향의 열화가 안전한 쪽이다.
if [ "$MODE" = "full" ]; then
  printf '%s' "$STREAK_NEXT" > "$STREAK_FILE" 2>/dev/null || true
fi

printf '{"schemaVersion":1,"mode":"%s","generatedAt":"%s","items":[%s]}\n' \
  "$MODE" "$(date +%Y-%m-%dT%H:%M:%S%z)" "$ITEMS"
