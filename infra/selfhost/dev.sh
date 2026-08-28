#!/usr/bin/env bash
set -euo pipefail

# 개발 서버(주 레인) 온디맨드 제어 — 메뉴바 앱의 위임 대상.
#
#   dev.sh up      # DB 준비(없으면 최신 백업으로 ~11초 재구축) + next dev 를 3002 로
#                  # 백그라운드 기동, 뜨면 브라우저를 연다
#   dev.sh down    # 개발 서버 종료 + (프리뷰 레인이 닫혀 있으면) DB 컨테이너 정리 —
#                  # "안 쓸 때 프로덕션 사본이 디스크에 없다"는 원칙(오너 2026-08-13/14)
#   dev.sh status  # 사람용 상태 한 줄
#
# 포트 규약: 3000=프로덕션 / 3001=프리뷰 / 3002=개발 (start-server.command #387 과 동일).
# ⚠️ 이 스크립트는 프로덕션과 같은 launchd 도메인·docker 데몬 옆에서 돈다 —
# kill 은 launchd 소유(부모 PID 1) 거부 가드 뒤에만, docker rm 은 이름 가드 뒤에만
# 온다. 계약: scripts/__tests__/dev-server-control.test.ts

DEV_PORT=3002
DEV_CHECKOUT="$HOME/Projects/wag-crm"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREVIEW_DB_SCRIPT="$SCRIPT_DIR/preview-db.sh"
PREVIEW_PLIST="$HOME/Library/LaunchAgents/kr.ygrd.wagcrm.preview.plist"
DB_CONTAINER="wagcrm-preview-db"
DB_HOSTPORT="127.0.0.1:55432"
LOG_DIR="$HOME/selfhost/logs"
PIDFILE="$LOG_DIR/dev.pid"
LOG_FILE="$LOG_DIR/dev.out.log"

export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"
mkdir -p "$LOG_DIR"

log() { printf '[dev] %s\n' "$*"; }
abort() { printf '[dev] 중단: %s\n' "$*" >&2; exit 1; }

# 이름 가드 — 변수가 오염돼도 파괴적 명령이 엉뚱한 대상을 잡지 않게 한다(preview-db.sh 관례).
case "$DB_CONTAINER" in
  wagcrm-preview-db) ;;
  *) abort "DB 컨테이너 이름이 비정상입니다($DB_CONTAINER) — 안전을 위해 중단합니다." ;;
esac
case "$DEV_PORT" in
  3002) ;;
  *) abort "개발 포트가 비정상입니다($DEV_PORT) — 3000(프로덕션)/3001(프리뷰)과 겹칠 위험이 있어 중단합니다." ;;
esac

http_code() { curl -o /dev/null -s -m 3 -w '%{http_code}' "http://127.0.0.1:$DEV_PORT/" 2>/dev/null || true; }

db_reachable() {
  (exec 3<>"/dev/tcp/${DB_HOSTPORT%%:*}/${DB_HOSTPORT##*:}") 2>/dev/null
}

# 포트 점유 프로세스를 정리한다. launchd 소유(부모 PID 1)는 절대 죽이지 않는다 —
# KeepAlive 로 되살아나 포트를 다투고, 무엇보다 프로덕션·프리뷰일 수 있다(#387 가드).
kill_port_owners() {
  local pid parent
  for pid in $(lsof -ti:"$DEV_PORT" 2>/dev/null || true); do
    parent="$(ps -o ppid= -p "$pid" | tr -d ' ')"
    if [ "$parent" = "1" ]; then
      abort "포트 $DEV_PORT 을 launchd 상주 서비스(PID $pid)가 쓰고 있습니다 — 종료하지 않습니다."
    fi
    kill "$pid" 2>/dev/null || true
  done
}

cmd_up() {
  local code
  code="$(http_code)"
  if [ -n "$code" ] && [ "$code" != "000" ]; then
    log "이미 켜져 있습니다: http://localhost:$DEV_PORT"
    open "http://localhost:$DEV_PORT" 2>/dev/null || true
    return 0
  fi

  kill_port_owners

  [ -d "$DEV_CHECKOUT" ] || abort "개발 체크아웃이 없습니다($DEV_CHECKOUT)."

  # DB 준비 — 개발 체크아웃 .env 가 프리뷰 DB(127.0.0.1:55432)를 가리키는 구성일 때만
  # 재구축한다. 다른 DB(로컬 파일 등)를 가리키면 건드리지 않는다.
  local env_hostport
  env_hostport="$(grep -hE '^DATABASE_URL=' "$DEV_CHECKOUT/.env.local" "$DEV_CHECKOUT/.env" 2>/dev/null | head -1 \
    | sed -E 's#.*@##; s#/.*##')"
  if [ "$env_hostport" = "$DB_HOSTPORT" ]; then
    if db_reachable; then
      log "DB 응답 확인($DB_HOSTPORT) — 그대로 사용합니다."
    else
      log "DB 가 없습니다 — 최신 백업으로 재구축합니다(약 11초)."
      bash "$PREVIEW_DB_SCRIPT" || abort "DB 재구축 실패 — 위 preview-db 출력을 확인하세요."
    fi
  else
    log "DATABASE_URL 이 $DB_HOSTPORT 이 아니라 DB 준비를 건너뜁니다(${env_hostport:-미설정})."
  fi

  log "개발 서버 기동: http://localhost:$DEV_PORT (로그: $LOG_FILE)"
  (
    cd "$DEV_CHECKOUT"
    nohup npm run dev -- -p "$DEV_PORT" >>"$LOG_FILE" 2>&1 &
    echo $! >"$PIDFILE"
  )

  # 준비 폴링 — 첫 컴파일 포함 최대 120초.
  local waited=0
  while [ "$waited" -lt 120 ]; do
    code="$(http_code)"
    if [ -n "$code" ] && [ "$code" != "000" ]; then
      log "켜졌습니다: http://localhost:$DEV_PORT"
      open "http://localhost:$DEV_PORT" 2>/dev/null || true
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  log "120초 안에 응답이 없습니다 — 마지막 로그:"
  tail -20 "$LOG_FILE" >&2 || true
  exit 1
}

cmd_down() {
  # 서버 종료 — 리스너(포트 점유)와 런처(npm, pidfile) 둘 다 정리한다.
  kill_port_owners
  if [ -f "$PIDFILE" ]; then
    local pid parent
    pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      parent="$(ps -o ppid= -p "$pid" | tr -d ' ')"
      if [ "$parent" != "1" ]; then
        kill "$pid" 2>/dev/null || true
      fi
    fi
    rm -f "$PIDFILE"
  fi

  # 종료 확인(사후조건) — 최대 10초.
  local waited=0
  while [ "$waited" -lt 10 ]; do
    [ -z "$(lsof -ti:"$DEV_PORT" 2>/dev/null || true)" ] && break
    sleep 1
    waited=$((waited + 1))
  done
  if [ -n "$(lsof -ti:"$DEV_PORT" 2>/dev/null || true)" ]; then
    abort "포트 $DEV_PORT 이 아직 점유돼 있습니다 — 종료가 완료되지 않았습니다."
  fi
  log "개발 서버가 꺼졌습니다."

  # DB 정리 — 프리뷰 레인이 열려 있으면 그쪽 소유라 남긴다. 닫혀 있으면 사본을
  # 디스크에 남기지 않는다(온디맨드 원칙). 이름 가드는 파일 상단에서 통과했다.
  if [ -f "$PREVIEW_PLIST" ]; then
    log "프리뷰 레인이 열려 있어 DB 컨테이너는 남깁니다."
  elif docker inspect "$DB_CONTAINER" >/dev/null 2>&1; then
    docker rm -f "$DB_CONTAINER" >/dev/null
    if docker inspect "$DB_CONTAINER" >/dev/null 2>&1; then
      abort "DB 컨테이너($DB_CONTAINER)가 아직 남아 있습니다 — 정리가 완료되지 않았습니다."
    fi
    log "DB 컨테이너를 정리했습니다(사본 미상주)."
  else
    log "DB 컨테이너가 이미 없습니다."
  fi
}

cmd_status() {
  local code
  code="$(http_code)"
  case "$code" in
    ""|000) echo "개발 서버: 꺼져 있음" ;;
    *)      echo "개발 서버: 켜져 있음 (http://localhost:$DEV_PORT → $code)" ;;
  esac
  if db_reachable; then echo "DB($DB_HOSTPORT): 응답함"; else echo "DB($DB_HOSTPORT): 없음"; fi
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *) echo "사용법: dev.sh up | down | status" >&2; exit 2 ;;
esac
