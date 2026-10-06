#!/usr/bin/env bash
set -euo pipefail

# wag-crm 코드가 이 맥에서 차지하는 공간 — 저장소 본체 + 모든 워크트리 + 운영 체크아웃.
# 메뉴바 앱 "DB 데이터 크기" 줄 아래 "코드·워크트리" 줄의 계측 SSOT 다(읽기 전용).
#
# metrics.sh 에 직접 넣지 않고 분리한 이유: metrics.sh 는 30초마다 돌고, 이 측정은
# du 로 20G 남짓을 훑어 실측 약 18초가 걸린다. 그래서 이 스크립트가 재서 **캐시
# 파일에 적고**, metrics.sh 는 캐시만 읽는다(오래됐으면 이 스크립트를 백그라운드로
# 띄운다). 측정 실패도 캐시에 적는다 — 안 적으면 metrics.sh 가 30초마다 다시 띄운다.
#
# 워크트리 경로를 적어두지 않고 `git worktree list` 로 뽑는 이유: Claude(.claude/
# worktrees)·Codex(~/.codex/worktrees)·Antigravity(~/.gemini/antigravity/worktrees)
# 가 각자 다른 곳에 만든다. 목록을 적어두면 새 도구가 생길 때마다 빠진다.
#
# du 기준이다 — APFS 클론은 중복으로 세므로 "지금 깔린 양"이지 "지우면 돌아오는 양"이
# 아니다(회수량은 df 전후 비교로만 안다).
#
#   repo-footprint.sh        # 캐시 갱신 + JSON 한 줄 출력
#
# 계약 테스트: scripts/__tests__/menubar-repo-footprint.test.ts

export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"

# 테스트 훅 — metrics.sh 와 같은 패턴(실행 비트 없는 스텁을 "bash <파일>" 로 주입).
GIT="${FOOTPRINT_GIT_CMD:-git}"
DU="${FOOTPRINT_DU_CMD:-du}"
REPO="${FOOTPRINT_REPO:-$HOME/Projects/wag-crm}"
DEPLOY_DIR="${FOOTPRINT_DEPLOY_DIR:-$HOME/selfhost/wagcrm}"
CACHE="${FOOTPRINT_CACHE:-$HOME/selfhost/logs/repo-footprint.json}"
LOCK_DIR="$CACHE.lock"

NOW_EPOCH="$(date +%s)"
NOW_ISO="$(date +%Y-%m-%dT%H:%M:%S%z)"

# 캐시는 원자적으로 바꾼다 — metrics.sh 가 쓰는 도중의 반쪽 파일을 읽으면 안 된다.
write_cache() {
  mkdir -p "$(dirname "$CACHE")"
  printf '%s\n' "$1" > "$CACHE.tmp.$$"
  mv -f "$CACHE.tmp.$$" "$CACHE"
  printf '%s\n' "$1"
}

fail() {
  # 실패도 캐시에 남긴다(앱이 그대로 보여 준다). 종료코드는 0 — metrics.sh 의
  # 백그라운드 호출에서 실패를 알릴 상대가 없고, 캐시가 그 알림이다.
  # 시각은 25분 전으로 적는다: 성공 캐시(30분 유지)와 달리 실패는 5분 뒤 다시 재게 —
  # 일시 실패가 30분 동안 빨갛게 남지 않게 하면서, 폴링마다 18초짜리 du 가 도는 것도 막는다.
  # 메시지의 따옴표·역슬래시는 지운다 — 캐시 한 줄이 JSON 으로 깨지면 metrics.sh 전체
  # 출력이 깨져 CPU 과부하 경고까지 함께 죽는다(리뷰 지적 2026-10-06).
  local msg
  msg="$(printf '%s' "$1" | tr -d '"\\' | tr '\n' ' ')"
  write_cache "{\"available\":false,\"measuredAt\":\"$NOW_ISO\",\"measuredAtEpoch\":$(( NOW_EPOCH - 1500 )),\"error\":\"$msg\"}"
  exit 0
}

# 잠금은 캐시 옆에 두므로 그 디렉터리가 먼저 있어야 한다(첫 실행·테스트 임시 경로).
mkdir -p "$(dirname "$CACHE")"

# 동시 실행 방지 — metrics.sh 가 30초마다 띄우므로 18초짜리 측정이 겹칠 수 있다.
# 잠금이 10분 넘게 남아 있으면 죽은 실행의 잔해로 보고 치운다.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_AGE=$(( NOW_EPOCH - $(stat -f %m "$LOCK_DIR" 2>/dev/null || echo "$NOW_EPOCH") ))
  if [ "$LOCK_AGE" -gt 600 ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
    mkdir "$LOCK_DIR" 2>/dev/null || { echo "repo-footprint: 이미 측정 중" >&2; exit 0; }
  else
    echo "repo-footprint: 이미 측정 중" >&2
    exit 0
  fi
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

[ -d "$REPO" ] || fail "저장소 없음: $REPO"

# porcelain: 항목마다 "worktree <경로>" 한 줄. 첫 항목이 본체다.
WT_LIST="$($GIT -C "$REPO" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0, 10)}' || true)"
[ -n "$WT_LIST" ] || fail "git worktree list 실패"
MAIN="$(printf '%s\n' "$WT_LIST" | head -1)"

TARGETS=()
while IFS= read -r p; do [ -n "$p" ] && TARGETS+=("$p"); done <<< "$WT_LIST"
HAS_DEPLOY=0
if [ -d "$DEPLOY_DIR" ]; then HAS_DEPLOY=1; TARGETS+=("$DEPLOY_DIR"); fi

# 한 번의 du 로 다 잰다. 없는 경로는 du 가 stderr 에 적고 종료코드 1 을 내지만
# 나머지 줄은 정상이라, 출력을 파싱해 빠진 것을 센다(missing).
DU_OUT="$($DU -sk "${TARGETS[@]}" 2>/dev/null || true)"

# 본체 안에 든 워크트리(.claude/worktrees/*)는 본체 du 에 이미 들어 있다 — 두 번
# 세지 않게 본체에서 뺀다. 결과는 KB → 바이트로 바꿔 JSON 조각으로 낸다.
RESULT="$(printf '%s\n' "$DU_OUT" | awk -F'\t' \
  -v main="$MAIN" -v deploy="$DEPLOY_DIR" -v hasDeploy="$HAS_DEPLOY" -v expected="${#TARGETS[@]}" '
  NF == 2 && $1 ~ /^[0-9]+$/ {
    seen++
    if ($2 == main) { mainKB = $1; mainSeen = 1; next }
    if (hasDeploy == 1 && $2 == deploy) { deployKB = $1; deploySeen = 1; next }
    wtCount++; wtKB += $1
    if (index($2, main "/") == 1) nestedKB += $1
  }
  END {
    if (!mainSeen) { print "ERR"; exit }
    ownKB = mainKB - nestedKB; if (ownKB < 0) ownKB = 0
    deployJson = (hasDeploy == 1 && deploySeen) ? sprintf("%.0f", deployKB * 1024) : "null"
    total = ownKB + wtKB + ((hasDeploy == 1 && deploySeen) ? deployKB : 0)
    printf "\"totalBytes\":%.0f,\"mainBytes\":%.0f,\"worktreeCount\":%d,\"worktreeBytes\":%.0f,\"deployBytes\":%s,\"missing\":%d",
      total * 1024, ownKB * 1024, wtCount, wtKB * 1024, deployJson, expected - seen
  }')"
[ "$RESULT" != "ERR" ] && [ -n "$RESULT" ] || fail "본체 측정 실패(du)"

write_cache "{\"available\":true,\"measuredAt\":\"$NOW_ISO\",\"measuredAtEpoch\":$NOW_EPOCH,$RESULT}"
