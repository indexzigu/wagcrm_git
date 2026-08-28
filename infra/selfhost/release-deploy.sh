#!/usr/bin/env bash
set -euo pipefail

# 메뉴바 「배포하기」의 실행체 — 두 레인을 **순서대로** 돌린다.
#   1) CRM        : infra/selfhost/deploy.sh (프로덕션 체크아웃)
#   2) 링크 서버   : ygrd-link/ 가 실제로 바뀐 경우에만 wrangler deploy
#
# ⚠️ 이 스크립트의 존재 이유는 **경로를 소유하는 것**이다. 2026-08-14 에 개발
# 체크아웃(낡은 브랜치)에서 wrangler deploy 를 돌려 새 코드가 없는 소스를
# 프로덕션 Worker 로 배포한 사고가 있었다. 경로를 여기 하드코딩하면 사람이 어느
# 디렉터리에서 실행하든 틀릴 수 없다 — 상대 경로 해석을 쓰지 않는 이유다.
#
# ⛔ deploy.sh 의 P0 가드(워크트리 거부·APP_TRACK_BRANCH 거부·DATABASE_URL 호스트
# 비교)를 우회하거나 재구현하지 않는다. 특히 APP_TRACK_BRANCH 를 unset 하지 않는다 —
# 셸이 오염됐으면 그 가드가 멈추는 것이 정답이고, 우리가 지우면 신호를 삼킨다.
#
#   release-deploy.sh [--dry-run]
#
# 설계 정본: docs/private/specs/2026-08-14-menubar-release-section-design.md
# 계약 테스트: scripts/__tests__/menubar-release.test.ts

# ── 0. 자기 사본으로 재실행 ────────────────────────────────────
# 레인 1 이 `git reset --hard` 로 **이 파일이 든 체크아웃**을 갈아치운다. bash 는
# 스크립트를 바이트 오프셋으로 이어 읽으므로, 실행 중에 파일이 바뀌면 뒤 구간이
# 엉뚱하게 해석될 수 있다. 임시 사본으로 옮겨 실행 텍스트를 체크아웃과 분리한다.
if [ "${RELEASE_DEPLOY_SNAPSHOT:-}" != "1" ]; then
  # 🪤 `mktemp -t <접두사>` 는 BSD(macOS) 전용 형태다 — GNU coreutils(CI ubuntu)는
  # 템플릿이 X 3개 이상으로 끝나기를 요구해 `too few X's in template` 로 즉사한다
  # (status.sh 의 date 대신 perl 을 쓰는 것과 같은 계열의 함정). 레포의 다른
  # 스크립트들처럼 템플릿을 명시해 양쪽에서 동작하게 한다.
  SNAP="$(mktemp "/tmp/release-deploy.XXXXXX")"
  cat "$0" > "$SNAP"
  export RELEASE_DEPLOY_SNAPSHOT=1
  rc=0
  bash "$SNAP" "$@" || rc=$?
  rm -f "$SNAP"
  exit "$rc"
fi

# 앱(launchd)이 주는 PATH 는 /usr/bin:/bin:/usr/sbin:/sbin 뿐이다(실측 2026-08-14).
# npm·node·npx 는 /usr/local/bin 에 있고, deploy.sh 는 레포에서 유일하게 PATH
# 보강이 없는 스크립트다(지금까지는 호출자가 대신 줬다). 이 줄이 없으면 배포는
# `npm: command not found` 로 죽는다.
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"

PROD_CHECKOUT="$HOME/selfhost/wagcrm"
WORKER_DIR="$PROD_CHECKOUT/ygrd-link"
LOGS_DIR="$HOME/selfhost/logs"
WORKER_MARKER="$LOGS_DIR/deployed.ygrd-link.sha"
LOCK_DIR="$LOGS_DIR/release-deploy.lock"

DEPLOY_SH="${RELEASE_DEPLOY_SH:-$PROD_CHECKOUT/infra/selfhost/deploy.sh}"
GIT="${RELEASE_GIT_CMD:-git}"
NPM="${RELEASE_NPM_CMD:-npm}"
NPX="${RELEASE_NPX_CMD:-npx}"

DRY=0
case "${1:-}" in
  "")
    if [ -n "${2:-}" ]; then
      echo "중단: 알 수 없는 인자 '$2' — 예행은 --dry-run 입니다." >&2
      exit 1
    fi
    ;;
  --dry-run)
    if [ -n "${2:-}" ]; then
      echo "중단: 알 수 없는 인자 '$2' — 예행은 --dry-run 입니다." >&2
      exit 1
    fi
    DRY=1
    ;;
  *)
    echo "중단: 알 수 없는 인자 '$1' — 예행은 --dry-run 입니다." >&2
    exit 1
    ;;
esac

# ── 1. 잠금 ────────────────────────────────────────────────────
# 앱은 busyLane 으로 중복 클릭을 막지만 오너가 터미널에서 동시에 돌릴 수 있다.
# 같은 체크아웃에서 npm install·빌드가 겹치면 산출물이 깨진다.
mkdir -p "$LOGS_DIR"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  OTHER="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$OTHER" ] && kill -0 "$OTHER" 2>/dev/null; then
    echo "중단: 배포가 이미 진행 중입니다(PID $OTHER). 끝난 뒤 다시 시도하세요." >&2
    exit 1
  fi
  echo "[release] 남아 있던 잠금을 인계합니다(이전 PID: ${OTHER:-불명})"
fi
printf '%s\n' "$$" > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT

# ── 2. 경로·브랜치 확인 ────────────────────────────────────────
if [ ! -d "$PROD_CHECKOUT" ]; then
  echo "중단: 운영 체크아웃이 없습니다 — $PROD_CHECKOUT" >&2
  exit 1
fi
BRANCH="$($GIT -C "$PROD_CHECKOUT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [ "$BRANCH" != "main" ]; then
  echo "중단: 운영 체크아웃이 main 이 아닙니다(현재: ${BRANCH:-확인 불가}) — $PROD_CHECKOUT. 누군가 그 트리를 만지던 중일 수 있으니 터미널에서 확인하세요." >&2
  exit 1
fi

if [ "$DRY" = "1" ]; then
  echo "[release] (예행) 1/2 CRM 배포: bash $DEPLOY_SH"
  echo "[release] (예행) 2/2 링크 서버: $WORKER_DIR 의 변경 여부를 보고 결정"
  exit 0
fi

# ── 3. 레인 1 — CRM ────────────────────────────────────────────
echo "[release] 1/2 CRM 배포"
if ! bash "$DEPLOY_SH"; then
  echo "중단: CRM 배포가 실패했습니다 — 링크 서버는 손대지 않았습니다." >&2
  exit 1
fi

# ── 4. 레인 2 — 링크 서버(ygrd-link) ───────────────────────────
# ⚠️ 판정에 CRM 마커(deployed.sha)를 쓰지 말 것 — Worker 배포만 실패한 회차에서
# CRM 마커는 이미 전진하므로 다음 실행이 그 변경을 영원히 건너뛴다. 전용 마커를 쓴다.
HEAD_SHA="$($GIT -C "$PROD_CHECKOUT" rev-parse HEAD)"
WORKER_BASE="$(cat "$WORKER_MARKER" 2>/dev/null || true)"
NEED_WORKER=1
WHY="배포 기록이 없어 이번에 함께 올립니다"
if [ -n "$WORKER_BASE" ] && $GIT -C "$PROD_CHECKOUT" cat-file -e "${WORKER_BASE}^{commit}" 2>/dev/null; then
  if $GIT -C "$PROD_CHECKOUT" diff --quiet "$WORKER_BASE" "$HEAD_SHA" -- ygrd-link/; then
    NEED_WORKER=0
  else
    WHY="ygrd-link/ 에 변경이 있습니다"
  fi
fi

WORKER_RESULT="건너뜀"
if [ "$NEED_WORKER" = "0" ]; then
  echo "[release] 2/2 링크 서버 — 변경 없음, 건너뜁니다"
else
  echo "[release] 2/2 링크 서버 배포 — $WHY"
  cd "$WORKER_DIR"
  # 실패 문구는 항상 다음 네 가지를 담는다: ①CRM 은 반영됐다 ②링크 서버만 뒤처졌다
  # ③어느 명령으로 재시도하나 ④인증 만료 시 무엇을 하나. CRM 마커는 이미 전진해
  # 있어 패널이 "서버가 최신입니다"로 돌아가고 배포 버튼이 사라지므로, 오너가
  # 패널이 아니라 터미널에서 재시도할 수 있어야 한다.
  RETRY_HINT="CRM 은 이미 반영됐고 링크 서버만 뒤처져 있습니다. 터미널에서 'bash ~/selfhost/wagcrm/infra/selfhost/release-deploy.sh' 를 다시 실행하면 링크 서버만 재시도합니다(CRM 은 변경 없음으로 건너뜁니다). 인증이 만료됐다면 먼저 'npx wrangler login' 하십시오."
  # wrangler 는 전역 설치본이 아니라 ygrd-link 의 devDependency 다(운영 체크아웃에
  # node_modules 가 없는 상태가 정상이다 — 실측). --no-install 이 없으면 npx 가
  # 조용히 다른 버전을 내려받아 배포한다("무엇으로 배포했는지" 를 알 수 없게 된다).
  if ! $NPM install --no-audit --no-fund; then
    echo "중단: 링크 서버 의존성 설치(npm install)가 실패했습니다. $RETRY_HINT" >&2
    exit 1
  fi
  if ! $NPX --no-install wrangler deploy; then
    echo "중단: 링크 서버 배포가 실패했습니다. $RETRY_HINT" >&2
    exit 1
  fi
  printf '%s\n' "$HEAD_SHA" > "$WORKER_MARKER"
  WORKER_RESULT="배포함"
fi

echo "[release] 완료: CRM $HEAD_SHA · 링크 서버 $WORKER_RESULT"
exit 0
