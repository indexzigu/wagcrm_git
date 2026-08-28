#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "========================================="
echo "  WAG CRM 프로덕션 배포"
echo "========================================="
echo ""
echo "Vercel 인증 검증: npm run verify:vercel-auth"
echo ""

if ! npm run verify:vercel-auth; then
  echo ""
  echo "인증이 필요한 Vercel 계정: indexzigu"
  read -p "인증 절차를 진행하려면 Enter 키를 누르세요..."
  echo ""

  echo "이전 Vercel 세션을 정리합니다..."
  vercel logout > /dev/null 2>&1 || true
  echo ""

  if ! vercel login; then
    echo ""
    echo "Vercel 로그인 실패. 배포를 중단합니다."
    echo ""
    exit 1
  fi

  echo ""
  echo "Vercel 로그인 완료. 인증을 다시 확인합니다."
  echo ""

  if ! npm run verify:vercel-auth; then
    echo ""
    echo "재로그인 후에도 계정/팀 검증 실패. 배포를 중단합니다."
    echo ""
    exit 1
  fi

  echo ""
  echo "Vercel 재검증 통과"
  echo ""
fi

echo "Vercel 인증 검증 통과"
echo ""
echo "사전 검증 실행: npm run release:check"
echo ""

if ! npm run release:check; then
  echo ""
  echo "사전 검증 실패. 배포를 중단합니다."
  echo ""
  exit 1
fi

echo "사전 검증 통과"
echo ""
echo "Vercel 프로덕션 배포 시작..."
echo ""

vercel deploy --prod

echo ""
echo "배포 완료"
echo ""
sleep 3
