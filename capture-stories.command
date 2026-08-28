#!/bin/bash
# 스토리 수집 러너 (수동 폴백) — Finder 에서 더블클릭. 정규 경로는 셀프호스트 크론
# (`infra/selfhost/crontab` 의 capture-stories, 매일 KST 00:00)과 홈 화면 시스템 레이더의
# 「지금 실행」 버튼이고, 이 파일은 **앱이 떠 있지 않을 때**의 마지막 수단이다. 앱을 거치지
# 않고 같은 코어를 tsx 로 직접 돌린다. 화면 4곳의 실패 안내가 이 파일 이름을 지목한다
# (seller-content-collect-button · story-collect-button · bulk-content-collect-button).
set -e
cd "$(dirname "$0")"

echo "========================================="
echo "  WAG 스토리 수집 (수동 폴백)"
echo "========================================="

# ⚠️ **어느 env 를 읽는가가 이 스크립트의 급소다 (실사고 2026-08-19).**
# 종전에는 체크아웃의 `.env` 만 읽었는데, 개발 체크아웃의 그 파일이 온디맨드 프리뷰 DB
# (127.0.0.1:55432)를 가리키게 바뀌자 같은 env 를 읽던 launchd 러너가 매일 밤 DB 접속
# 실패로 즉사했다(6일간 무음 — 상태 기록조차 DB 쓰기라 레이더가 마지막 성공에 얼어붙었다).
# 프리뷰 컨테이너가 마침 떠 있으면 더 나쁘다: 실패 대신 **프리뷰 DB 에 조용히 저장**된다.
# 그래서 프로덕션 env(앱·크론이 실제로 쓰는 것)를 먼저 찾고, 없을 때만 체크아웃으로 떨어진다.
PROD_ENV="$HOME/selfhost/wagcrm/infra/selfhost/.env"
if [ -f "$PROD_ENV" ]; then
  ENV_FILE="$PROD_ENV"
  echo "env: 프로덕션(셀프호스트) — $ENV_FILE"
elif [ -f .env ]; then
  ENV_FILE=".env"
  echo "⚠️ env: 체크아웃의 .env — 이 파일이 프로덕션 DB 를 가리키는지 확인하세요."
else
  echo "❌ env 파일을 찾지 못했습니다($PROD_ENV · ./.env). DATABASE_URL·Supabase 설정이 필요합니다."
  read -r -p "엔터를 눌러 닫기…" _
  exit 1
fi

set -a
# shellcheck disable=SC1091
source "$ENV_FILE"
set +a

npx tsx scripts/capture-stories-local.ts

echo ""
echo "완료. 이 창은 닫아도 됩니다."
read -r -p "엔터를 눌러 닫기…" _
