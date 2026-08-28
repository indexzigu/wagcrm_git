#!/bin/bash
# 헬퍼를 **정상 종료 후 다시 깨운다** — 코드를 고친 뒤 검증할 때 쓰는 한 줄.
#
#   bash scripts/hometax-helper/restart.sh
#
# ## 왜 스크립트인가
#
# 검증할 때마다 「종료 → 포트 비는 것 확인 → 다시 기동」을 손으로 하면 매번 같은
# 함정을 밟는다. 실제로 밟은 것 두 가지를 여기 박아 둔다.
#
# 🪤 **`lsof -ti :9410` 로 기다리면 안 끝난다.** 그 명령은 LISTEN 소켓뿐 아니라 그
#    포트로 **연결한 클라이언트**까지 잡는다 — CRM 화면을 열어 둔 브라우저가 잡혀서
#    "아직 포트가 안 비었다"가 영원히 참이 됐다(2026-08-07 실측, 3분 타임아웃).
#    `-sTCP:LISTEN` 을 붙여야 서버 소켓만 본다.
#
# ⛔ **`kill -9` 를 쓰지 않는다.** 강제 종료하면 Chrome 이 쿠키를 디스크에 쓰지 못해
#    **홈택스 로그인 세션이 날아간다**(2026-08-06 실측). 정상 종료 신호를 주고 기다린다.
set -euo pipefail

PORT="${HOMETAX_HELPER_PORT:-9410}"
WAIT_LIMIT=40

listening_pid() { lsof -ti ":$PORT" -sTCP:LISTEN 2>/dev/null || true; }

for pid in $(pgrep -f "hometax-helper/index.ts" || true); do
  kill -TERM "$pid" 2>/dev/null || true
done

for _ in $(seq 1 "$WAIT_LIMIT"); do
  [[ -z "$(listening_pid)" ]] && break
  sleep 1
done

if [[ -n "$(listening_pid)" ]]; then
  echo "포트 $PORT 를 아직 누가 듣고 있습니다 — 수동으로 확인하세요." >&2
  exit 1
fi

# 깨우기는 평소 경로 그대로 URL 스킴으로 한다 — 검증이 실사용과 같은 길을 타야 한다.
open "hometax-helper://start"

for i in $(seq 1 "$WAIT_LIMIT"); do
  if curl -s -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "재기동 완료(약 ${i}초)"
    curl -s -m 5 "http://127.0.0.1:$PORT/login-status"
    echo
    exit 0
  fi
  sleep 1
done

echo "재기동을 확인하지 못했습니다 — ~/.wag-crm/helper.log 를 확인하세요." >&2
exit 1
