#!/usr/bin/env bash
# Vercel "Ignored Build Step" — 브랜치 레인 게이트.
#
# 이 레포는 Vercel 프로젝트 2개가 같은 레포를 본다:
#   - wag-crm     (운영, crm.ygrd.kr)  → 배포 레인 = release (main 은 통합 전용, 빌드 없음)
#   - wagcrm-demo (외부 시연 데모)       → 배포 레인 = demo
#
# 두 프로젝트 모두 "자기 레인이 아닌 브랜치"에서는 빌드를 만들지 않는다.
# 각 프로젝트 Settings → Build and Deployment → Ignored Build Step 에 넣는 값:
#   wag-crm     : bash scripts/vercel-ignore-build.sh release
#   wagcrm-demo : bash scripts/vercel-ignore-build.sh demo
#
# 운영 승격(main → release fast-forward)은 scripts/promote-prod.sh 가 담당한다.
#
# ⚠️ 종료코드 계약(Vercel 공식): **exit 1 = 빌드 진행, exit 0 = 빌드 취소**.
#    직관과 반대라 인라인 한 줄 명령으로 쓰면 실사고가 난다 — 실제로
#    2026-07-22 운영 프로젝트가 #68~#72 다섯 건을 전부
#    "Canceled by Ignored Build Step" 으로 삼켰다(프로덕션 5건 미배포).
#    그래서 판정을 레포 안 스크립트로 옮겨 테스트로 고정한다
#    (scripts/__tests__/vercel-ignore-build.test.ts).
#
# 판정 불능(브랜치 정보 없음)일 때는 **빌드하는 쪽**으로 넘어진다 —
# 잘못 빌드하면 빌드 1회를 버리지만, 잘못 스킵하면 프로덕션이 조용히 멈춘다.

set -u

EXPECTED_REF="${1:-}"

if [ -z "$EXPECTED_REF" ]; then
  echo "[ignore-build] 인자(배포 레인 브랜치)가 없다 → 안전하게 빌드 진행"
  exit 1
fi

CURRENT_REF="${VERCEL_GIT_COMMIT_REF:-}"

if [ -z "$CURRENT_REF" ]; then
  echo "[ignore-build] VERCEL_GIT_COMMIT_REF 없음(수동 배포 등) → 안전하게 빌드 진행"
  exit 1
fi

if [ "$CURRENT_REF" = "$EXPECTED_REF" ]; then
  echo "[ignore-build] ref=${CURRENT_REF} == 레인(${EXPECTED_REF}) → 빌드 진행"
  exit 1
fi

echo "[ignore-build] ref=${CURRENT_REF} != 레인(${EXPECTED_REF}) → 빌드 스킵"
exit 0
