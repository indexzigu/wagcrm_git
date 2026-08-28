#!/bin/bash

# 더블 클릭으로 실행 시 현재 폴더 위치로 이동
cd "$(dirname "$0")"

# ⚠️ 이 맥은 2026-08-13 부터 **프로덕션 호스트**다. 그전까지 이 파일은 포트 3000 을
# 점유한 프로세스를 무조건 `kill -9` 했는데, 이제 3000 을 쥐고 있는 것은 프로덕션
# 앱(launchd `kr.ygrd.wagcrm.app`)이다 — 더블클릭 한 번이 crm.ygrd.kr 을 죽였다.
# 그래서 두 가지를 바꿨다:
#   ① 개발 서버는 3002 로 옮긴다. 3000=프로덕션 / 3001=프리뷰 와 겹치지 않고,
#      "localhost:3000 을 열었는데 사실 프로덕션이었다"는 혼동도 사라진다.
#   ② 남의 프로세스는 죽이지 않는다. launchd 가 소유한 것(부모 PID 1)은 거부한다.
PORT=3002

echo "=========================================="
echo " WAG CRM 로컬 개발 서버"
echo " 주소: http://localhost:${PORT}"
echo "=========================================="

echo "[1/4] 포트 ${PORT} 점유 상태 확인 중..."
PID="$(lsof -ti:"$PORT" | head -1)"

if [ -n "$PID" ]; then
    PARENT="$(ps -o ppid= -p "$PID" | tr -d ' ')"
    if [ "$PARENT" = "1" ]; then
        # launchd 가 소유한 상주 서비스다. 죽이면 KeepAlive 가 되살리며 포트를
        # 다투게 되고, 무엇보다 프로덕션·프리뷰일 수 있다.
        echo "‼️  중단: 포트 ${PORT} 을 launchd 상주 서비스(PID ${PID})가 쓰고 있습니다."
        ps -o pid,command -p "$PID" | tail -1
        echo "    개발 서버가 아니라 시스템이 관리하는 서비스라 여기서 종료하지 않습니다."
        echo "    포트를 바꾸거나, 무엇인지 확인한 뒤 직접 정리하세요."
        echo ""
        read -n 1 -s -r -p "아무 키나 누르면 닫힙니다..."
        exit 1
    fi
    echo "[2/4] 남아 있던 개발 서버(PID ${PID})를 종료합니다."
    kill -9 "$PID"
    sleep 1
    echo "✅ 종료 완료."
else
    echo "[2/4] 실행 중인 서버가 없습니다."
fi

# DB 도달 확인 — 안 되면 화면이 전부 깨지는데, 그 이유가 서버 로그 깊숙이 묻힌다.
# 특히 개발용 DB 가 프리뷰 컨테이너였다면 `preview.sh down` 으로 사라져 있을 수 있다.
echo "[3/4] 데이터베이스 도달 확인 중..."
DB_HOSTPORT="$(grep -hE '^DATABASE_URL=' .env.local .env 2>/dev/null | head -1 \
  | sed -E 's#.*@##; s#/.*##')"
DB_HOST="${DB_HOSTPORT%%:*}"
DB_PORT="${DB_HOSTPORT##*:}"

if [ -z "$DB_HOSTPORT" ]; then
    echo "⚠️  DATABASE_URL 을 찾지 못했습니다(.env.local / .env). 화면이 깨질 수 있습니다."
elif (exec 3<>"/dev/tcp/${DB_HOST}/${DB_PORT}") 2>/dev/null; then
    echo "✅ ${DB_HOSTPORT} 응답함."
else
    echo "⚠️  ${DB_HOSTPORT} 에 연결되지 않습니다 — 서버는 뜨지만 데이터 화면은 깨집니다."
    echo "    개발용 DB 가 꺼져 있는 상태입니다. 그대로 진행하려면 그냥 두세요."
fi

echo "[4/4] Next.js 개발 서버를 시작합니다... (종료: Ctrl+C)"
echo "=========================================="
npm run dev -- -p "$PORT"
