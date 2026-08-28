#!/usr/bin/env bash
set -euo pipefail

# 생존 신고 — "메뉴바 앱이 지금 살아서 돌고 있다"를 맥 **밖**으로 보낸다.
# 설계 정본: docs/private/specs/2026-08-19-external-alert-channel-design.md
#
# ⛔ 이 스크립트를 launchd·crontab 에서 부르지 말 것. 발신 주체가 앱이어야
#    그 침묵이 **앱의 죽음**을 증명한다. 스케줄러가 부르면 앱이 죽어도 신호가
#    계속 흘러, 이 설계가 닫으려는 구멍이 그대로 살아남는다.
#    계약: scripts/__tests__/heartbeat-wiring.test.ts
#
# ⛔ 상태를 싣지 않는다 — 판정 SSOT 는 별도 판정 스크립트이고, 항목별 빨강은
#    notify.sh 가 직접 쏜다. 여기로 상태를 흘리면 판정의 사본이 밖에 생긴다.
#
# 실패는 조용히 넘긴다(다음 회차에 다시 친다). 🪤 heartbeat 실패를 알림으로 만들지
# 말 것 — 네트워크가 잠깐 끊길 때마다 폰이 울리고, 그 소음이 정작 중요한 침묵
# 알림을 무시하게 만든다.

ENV_FILE="${HEARTBEAT_ENV_FILE:-$(dirname "$0")/.env}"
CURL="${HEARTBEAT_CURL_CMD:-curl}"

read_env() {
  [ -r "$ENV_FILE" ] || return 0
  sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}[[:space:]]*$/\1/p" "$ENV_FILE" | tail -1
}

URL="$(read_env HEARTBEAT_URL)"
TOKEN="$(read_env HEARTBEAT_TOKEN)"
# 토큰 없이 보내지 않는다 — 무인증 /beat 는 누구나 가짜 생존 신호를 넣어 침묵
# 판정을 영원히 막을 수 있는 통로다.
[ -n "$URL" ] && [ -n "$TOKEN" ] || exit 0

$CURL -s -o /dev/null -m 10 -X POST "$URL" -H "Authorization: Bearer $TOKEN" 2>/dev/null || true
exit 0
