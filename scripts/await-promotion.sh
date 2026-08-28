#!/usr/bin/env bash
# scripts/await-promotion.sh — "내 커밋이 배칭 승격으로 prod 에 실렸나?"를 판정/대기한다.
#
# 배경(P6 배포 레인): main 머지 ≠ 배포다. main 은 빌드 없는 통합 브랜치이고, PR 을 머지한
# 세션은 "언제 내 커밋이 실제 prod 로 나갔나"를 자동으로 알 길이 없어 gh pr checks 를 수동
# 폴링해야 했다(오너 지적). 이 스크립트가 그 "역방향 통지"의 세션측 절반이다 — 배포 레인
# 자체는 건드리지 않는다(무접촉, P0 "배포 레인 깨지 말 것").
#
# ── 레인이 둘이다 (2026-08-18 기본값 교체) ───────────────────────────────────
# [기본] --lane selfhost : 프로덕션은 자체호스팅 iMac 이 서빙한다(2026-08-13 컷오버).
#   판정 원리: C 가 **셀프호스트 배포 마커의 조상**이면 prod 에 살아있다.
#     마커 = ~/selfhost/logs/deployed.sha — infra/selfhost/deploy.sh 가 **헬스체크까지 전부
#     성공한 뒤에만** 기록하므로(빌드가 깨지면 갱신되지 않는다) "지금 서빙되는 커밋"이다.
#   ⚠️ 마커를 읽을 수 없으면 **판정 불가(exit 5)** 다 — 미배포가 아니다. 마커는 프로덕션
#     호스트에만 있으므로 클라우드 세션·fresh clone 에 없는 것은 정상이고, 없는 것을
#     "아직 배포 안 됨"으로 답하면 멀쩡한 기능에 재착수가 걸린다(P0 환각 보고 반대 방향).
#   ⚠️ 이 레인은 **배포 실패를 볼 수 없다.** deploy.sh 는 성공했을 때만 마커를 쓰므로,
#     실패는 "마커가 안 움직임"으로만 나타나 미배포와 구분되지 않는다. 그래서 --watch 는
#     성공을 지어내지 않고 계속 기다리다 타임아웃(exit 2)한다 — 조용한 거짓 성공은 없다.
#
# [롤백] --lane vercel : 구 플랫폼(release 브랜치 + Vercel). **롤백 창구를 실제로 올릴
#   때만** 쓴다. 판정 원리: C 가 "완료 상태의 최신 release 커밋"의 조상이고, 그 커밋의
#   Vercel 커밋상태 description == "Deployment has completed" 일 때 live.
#   초록 state 만 믿지 않는다 — 데모(wagcrm-demo)의 정상 자기-취소
#   "Canceled by Ignored Build Step" 를 운영 완료로 오판하면 안 된다(#68~#72 유형).
#   컨텍스트 필터는 promote-prod.sh 와 동일 계약이며,
#   scripts/__tests__/await-promotion.test.ts 가 두 스크립트를 같은 픽스처로 고정한다.
#
# ⛔ **기본값이 vercel 이던 시절(~2026-08-18)은 SUPERSEDED.** 컷오버로 release 가 롤백
#   창구가 되어 전진을 멈췄는데 이 스크립트만 그 레인에 남아 있었다 — 이미 prod 에 배포된
#   PR #407 에 --check 가 exit 3 "아직 미승격"을 줬고(실측), --watch 는 영원히 통지하지
#   않았다(조용한 미통지 — 이 도구가 없애려던 수동 폴링이 그대로 돌아온 상태다).
#   같은 결함이 npm run board:check 에서 먼저 드러나 그쪽이 먼저 마커 기준으로 옮겨졌다(#407).
#
# 사용법:
#   bash scripts/await-promotion.sh --check <sha|ref>   # 1회 조회. 종료코드: 0=실림·3=아직·1=오류/실패
#   bash scripts/await-promotion.sh --check --pr <NN>   # PR 머지커밋으로 조회(세션이 쓰는 기본 경로)
#   bash scripts/await-promotion.sh --watch <sha|ref>   # 실릴 때까지 대기(백그라운드용). 0=실림·2=타임아웃·1=오류/실패
#   bash scripts/await-promotion.sh --watch --pr <NN>
#   bash scripts/await-promotion.sh --watch --pr <NN> --await-merge
#       ↑ **아직 머지되지 않은 PR** 에 건다. 머지를 먼저 기다린 뒤 승격 배포 대기로 넘어간다.
#         (--await-merge 없이 미머지 PR 에 걸면 머지커밋이 없어 즉시 exit 1 이다.)
#         추가 종료코드: 4 = PR 이 머지되지 않고 닫힘.
#   bash scripts/await-promotion.sh --status <sha>      # (내부/디버그) Vercel 배포상태 한 단어
#   ... --check --pr <NN> --lane vercel                 # 롤백 창구(구 플랫폼) 판정
#
# 종료코드: 0=prod 에 실림 · 3=아직 안 실림 · 1=오류/배포 실패 · 2=대기 타임아웃 ·
#           4=PR 이 머지되지 않고 닫힘 · **5=판정 불가**(selfhost 레인에서 마커를 못 읽음).
#   ⚠️ 5 를 3 으로 접지 말 것 — 3 은 "안 실렸다"는 **주장**이고 5 는 "모른다"이다.
#
# 세션 자동통지 흐름(권장, 배포완료 자동통지):
#   1) 오너가 PR #NN 을 머지한다. (아직 머지 전이면 2)에 `--await-merge` 를 붙여 그대로 건다 —
#      "머지되면 배포까지 확인해줘" 요청이 여기에 해당한다.)
#   2) 세션이 다음을 Bash run_in_background(백그라운드)로 건다:
#        bash scripts/await-promotion.sh --watch --pr <NN> [--await-merge]
#   3) 커밋이 prod 에 도달하는 "순간" 프로세스가 종료(exit 0)되고, 하네스가 대기 세션을
#      자동 재소환한다 — 수동 폴링 없이 "배포됐다"를 받는다. 승격 실패면 exit 1 로 재소환돼
#      즉시 조사에 들어간다(promote-failed 이슈 참조).
#   4) 세션이 닫혔다 새 세션으로 돌아오면 `--check --pr <NN>` 으로 언제든 확정 상태를
#      재조회한다(git+상태 SSOT 는 내구적이라 세션 생존과 무관하다).
#
# 테스트/자동화용 env:
#   AWAIT_POLL_INTERVAL(기본 120s) · AWAIT_POLL_ATTEMPTS(기본 150 ≈ 5h) ·
#   AWAIT_MERGE_ATTEMPTS(기본 240 ≈ 8h — --await-merge 의 머지 대기 상한) ·
#   AWAIT_WALK_LIMIT(기본 15) · AWAIT_SKIP_FETCH=1(git fetch 생략 — 테스트가 ref 를 선주입) ·
#   AWAIT_DEPLOY_MARKER(셀프호스트 마커 경로 재지정 — 테스트·프로브 통로.
#     ⛔ 실 마커를 덮어써서 프로브하지 말 것: deploy.sh 가 그 파일로 "변경 없음"을 판정해
#     프로덕션이 구버전을 서빙한 채 재배포를 건너뛴다)

set -euo pipefail

REPO_SLUG="indexzigu/wagcrm_git"
LANE="release"                                   # --lane vercel 에서만 쓰는 구 플랫폼 브랜치
LANE_MODE="selfhost"                             # 기본 레인(2026-08-18 교체 — 위 ⛔ 참조)
DEPLOY_MARKER="${AWAIT_DEPLOY_MARKER:-$HOME/selfhost/logs/deployed.sha}"

# 운영 배포 컨텍스트 — promote-prod.sh 와 동일 계약(SSOT 는 그 스크립트; 배포 레인 무접촉
# 원칙상 공유 소스로 리팩터하지 않고, await-promotion.test.ts 가 같은 픽스처로 드리프트를
# 막는다). 데모 전용 컨텍스트("Vercel – wagcrm-demo")는 배제한다.
PROD_CONTEXT="Vercel – wag-crm"       # 비통합(per-project) 설정 (en-dash)
PROD_CONTEXT_CONSOLIDATED="Vercel"    # 통합(Consolidated Commit Status) 설정

POLL_INTERVAL="${AWAIT_POLL_INTERVAL:-120}" # 대기 폴링 간격(초). 테스트에서 0
POLL_ATTEMPTS="${AWAIT_POLL_ATTEMPTS:-150}" # 120s × 150 ≈ 5h (시간 상한 4h + 여유)
MERGE_ATTEMPTS="${AWAIT_MERGE_ATTEMPTS:-240}" # --await-merge 의 머지 대기 상한(120s × 240 ≈ 8h)
WALK_LIMIT="${AWAIT_WALK_LIMIT:-15}"        # release 이력에서 '현재 배포됨' 탐색 상한

# deploy_status <sha> → completed | canceled | failure | pending | none
# 커밋상태를 컨텍스트 필터로 운영만 골라 한 단어로 정규화한다. gh 는 컨텍스트별 상태를
# TSV 로 평탄화만 하고, 운영 컨텍스트 선택은 awk 에서 한다 — 테스트가 gh 를 스텁으로
# 갈아끼워 이 선택 로직을 픽스처로 고정할 수 있게 하기 위함(promote-prod.sh 와 동형).
deploy_status() {
  local sha="$1" line
  line=$(gh api "repos/$REPO_SLUG/commits/$sha/status" \
    --jq '.statuses[] | "\(.context)\t\(.state) \(.description)"' 2>/dev/null \
    | awk -F'\t' -v ctx="$PROD_CONTEXT" -v cons="$PROD_CONTEXT_CONSOLIDATED" \
        '$1 == ctx || $1 == cons { print $2; exit }' || true)
  case "$line" in
    *"Deployment has completed"*) echo completed ;;
    *Canceled*|*canceled*)        echo canceled ;;
    failure*|error*)              echo failure ;;
    "")                           echo none ;;
    *)                            echo pending ;;
  esac
}

# 현재 prod 에 실제로 배포된(=완료된) 최신 release 커밋 sha 를 stdout 으로. 없으면 1 반환.
# release first-parent 라인이 배포 커밋 계보다. 완료 상태를 만난 첫(=최신) 커밋이 '지금
# 살아있는' 배포다. 실패/취소/빌드중(pending)·상태없음(none)은 prod 를 바꾸지 못하므로
# 건너뛰고 더 이전 완료본을 본다(예: 최신 배포가 진행 중이어도, 그 직전 완료본이 현 prod).
resolve_live_sha() {
  local sha st
  while read -r sha; do
    [ -n "$sha" ] || continue
    st=$(deploy_status "$sha")
    if [ "$st" = completed ]; then
      echo "$sha"
      return 0
    fi
  done < <(git rev-list --first-parent --max-count="$WALK_LIMIT" "refs/remotes/$REMOTE/$LANE" 2>/dev/null || true)
  return 1
}

# evaluate_vercel <target_sha> → 한 단어 stdout: live | pending | notpromoted | failed
# 구 플랫폼(롤백 창구) 레인 판정. 종전 `evaluate` 를 이름만 바꾼 것이고 내용은 무수정이다.
evaluate_vercel() {
  local target="$1" live_sha lane_ref="refs/remotes/$REMOTE/$LANE" tip tip_st
  if live_sha=$(resolve_live_sha); then
    if git merge-base --is-ancestor "$target" "$live_sha" 2>/dev/null; then
      echo "live"
      return 0
    fi
  fi
  # 아직 살아있는 배포에 안 실렸다 — release 에 편입은 됐는데 빌드 중인가, 아직 미승격인가.
  if git rev-parse -q --verify "$lane_ref" >/dev/null 2>&1 \
     && git merge-base --is-ancestor "$target" "$lane_ref" 2>/dev/null; then
    tip=$(git rev-parse "$lane_ref")
    tip_st=$(deploy_status "$tip")
    if [ "$tip_st" = failure ] || [ "$tip_st" = canceled ]; then
      echo "failed"   # C 가 편입된 승격이 실패/취소됨(그 전 완료본에도 없었음 = 첫 배포 실패)
      return 0
    fi
    echo "pending"     # C 는 release 에 있고 빌드가 아직 안 끝남
    return 0
  fi
  echo "notpromoted"   # C 가 아직 어떤 release 커밋에도 편입되지 않음(미승격)
  return 0
}

# read_marker → 마커 SHA 를 stdout 으로, 못 읽으면 1 반환(사유는 stderr).
# ⚠️ "못 읽음"과 "배포된 것이 없음"을 섞지 않는다 — 빈 파일·쓰다 만 파일을 후자로 읽으면
# 모든 커밋이 미배포로 뒤집힌다. 형태가 아니면 전부 판정 불가다.
read_marker() {
  local raw sha
  if ! raw=$(cat "$DEPLOY_MARKER" 2>/dev/null); then
    echo "마커 파일이 없다: $DEPLOY_MARKER (이 기계가 프로덕션 호스트가 아니다 — 클라우드 세션·fresh clone 이면 정상)" >&2
    return 1
  fi
  # 🪤 파이프를 쓰지 않는다. `| grep -q` · `| head` 처럼 **먼저 끝나는 소비자**를 파이프에
  # 두면 `set -euo pipefail` 아래에서 생산자가 SIGPIPE(141)로 죽고 그 값이 스크립트의
  # 종료코드 계약을 깬다 — 이 레포의 실사고이고 promote-prod-check.test.ts 가 승격 경로
  # 3종(이 파일 포함)에 그 형태 금지를 고정한다. 여기서는 bash 내장만으로 충분하다.
  sha="${raw//[[:space:]]/}"
  if [[ ! "$sha" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
    echo "마커를 읽었지만 커밋 SHA 형태가 아니다: $DEPLOY_MARKER" >&2
    return 1
  fi
  if ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    echo "마커가 가리키는 커밋($sha)을 이 체크아웃이 모른다 — fetch 범위 밖이거나 다른 레포다" >&2
    return 1
  fi
  printf '%s' "$sha"
}

# evaluate_selfhost <target_sha> → live | notdeployed | unverifiable
# ⚠️ 이 레인에 `failed` 는 없다. deploy.sh 는 성공했을 때만 마커를 쓰므로 배포 실패는
# "마커가 안 움직임"으로만 보이고 미배포와 구분되지 않는다 — 실패를 지어내지 않고
# 계속 기다린다(--watch 는 타임아웃 exit 2). 거짓 성공보다 거짓 대기가 낫다.
evaluate_selfhost() {
  local target="$1" marker
  if ! marker=$(read_marker); then
    echo "unverifiable"
    return 0
  fi
  if git merge-base --is-ancestor "$target" "$marker" 2>/dev/null; then
    echo "live"
  else
    echo "notdeployed"
  fi
}

# evaluate <target_sha> — 레인 디스패처.
evaluate() {
  if [ "$LANE_MODE" = "vercel" ]; then evaluate_vercel "$1"; else evaluate_selfhost "$1"; fi
}

# ── 대상 커밋 해석 헬퍼 ───────────────────────────────────────────────────────
resolve_target_sha() {
  # 인자: 남은 위치인자들. --pr <NN> 또는 <sha|ref>. TARGET_SHA 를 echo.
  if [ "${1:-}" = "--pr" ]; then
    local pr="${2:?--pr <NN> 인자가 필요하다}" merged oid
    merged=$(gh api "repos/$REPO_SLUG/pulls/$pr" --jq '.merged' 2>/dev/null || echo "")
    oid=$(gh api "repos/$REPO_SLUG/pulls/$pr" --jq '.merge_commit_sha // empty' 2>/dev/null || echo "")
    if [ "$merged" != "true" ] || [ -z "$oid" ]; then
      echo "⛔ PR #$pr 이 아직 머지되지 않았거나 머지커밋을 찾을 수 없다(merged=$merged)." >&2
      return 1
    fi
    echo "$oid"
  else
    local ref="${1:?<sha|ref> 또는 --pr <NN> 가 필요하다}" sha
    sha=$(git rev-parse --verify --quiet "${ref}^{commit}" 2>/dev/null || true)
    if [ -z "$sha" ]; then
      echo "⛔ ref 를 커밋으로 해석하지 못했다: $ref" >&2
      return 1
    fi
    echo "$sha"
  fi
}

# ── PR 머지 대기(--await-merge) ───────────────────────────────────────────────
# 왜 필요한가: `--watch --pr <NN>` 은 머지커밋 SHA 를 요구하므로 **미머지 PR 이면 즉시
# exit 1** 이다. 그래서 "머지되면 배포까지 확인해줘" 라는 가장 흔한 요청에는 앞단에
# 머지 대기가 필요했고, 세션마다 임시 래퍼 스크립트를 새로 짜고 있었다(2026-07-29
# 하루에 #122·#126·#128 세 번). 그 앞단을 여기로 흡수한다 — 판정 계약은 그대로다.
pr_field() {
  gh api "repos/$REPO_SLUG/pulls/$1" --jq "$2" 2>/dev/null || echo ""
}

await_merge() {
  local pr="$1" merged state
  echo "⏳ PR #$pr 머지 대기 (간격 ${POLL_INTERVAL}s · 최대 ${MERGE_ATTEMPTS}회)…"
  for _ in $(seq 1 "$MERGE_ATTEMPTS"); do
    merged=$(pr_field "$pr" '.merged')
    if [ "$merged" = "true" ]; then
      echo ""
      echo "✅ PR #$pr 머지 확인 — 승격 배포 대기로 전환한다."
      return 0
    fi
    state=$(pr_field "$pr" '.state')
    if [ "$state" = "closed" ]; then
      echo ""
      echo "⛔ PR #$pr 이 머지되지 않고 닫혔다 — 대기 중단." >&2
      exit 4
    fi
    printf '.'
    sleep "$POLL_INTERVAL" 2>/dev/null || true
  done
  echo ""
  echo "⛔ 제한 시간 내 PR #$pr 머지 미확인 — 대기 중단(--check 로 상태 재조회)." >&2
  exit 2
}

# ── 엔트리 ────────────────────────────────────────────────────────────────────
# `--await-merge` 는 위치인자가 아니라 플래그다 — 먼저 걷어내고 나머지를 기존 규칙대로 판다.
AWAIT_MERGE=0
_ARGS=()
_want_lane=0
for _a in "$@"; do
  if [ "$_want_lane" = "1" ]; then
    case "$_a" in
      selfhost|vercel) LANE_MODE="$_a" ;;
      *) echo "⛔ --lane 은 selfhost|vercel 이다(받은 값: $_a)." >&2; exit 1 ;;
    esac
    _want_lane=0
  elif [ "$_a" = "--await-merge" ]; then AWAIT_MERGE=1
  elif [ "$_a" = "--lane" ]; then _want_lane=1
  else _ARGS+=("$_a"); fi
done
if [ "$_want_lane" = "1" ]; then echo "⛔ --lane 뒤에 selfhost|vercel 이 필요하다." >&2; exit 1; fi
set -- ${_ARGS[@]+"${_ARGS[@]}"}

MODE="${1:-}"
shift || true

# --status <sha>: 내부/디버그 — 배포상태 한 단어(git 불필요, gh 만 사용).
if [ "$MODE" = "--status" ]; then
  SHA="${1:?--status <sha> 인자가 필요하다}"
  deploy_status "$SHA"
  exit 0
fi

if [ "$MODE" != "--check" ] && [ "$MODE" != "--watch" ]; then
  echo "사용법: await-promotion.sh --check|--watch <sha|ref> | --pr <NN> [--await-merge] [--lane selfhost|vercel]" >&2
  exit 1
fi

if [ "$AWAIT_MERGE" = "1" ]; then
  # 머지 대기는 --watch 전용이다. --check 는 "지금 상태 1회 조회"라 대기와 섞이면 계약이 흐려진다.
  if [ "$MODE" != "--watch" ]; then
    echo "⛔ --await-merge 는 --watch 에서만 쓴다(--check 는 1회 조회다)." >&2
    exit 1
  fi
  if [ "${1:-}" != "--pr" ]; then
    echo "⛔ --await-merge 는 --pr <NN> 과 함께 써야 한다(sha 는 머지 여부를 알 수 없다)." >&2
    exit 1
  fi
fi

# 정본 리모트 탐지 — 구 레포(indexzigu/wag-crm)와 혼동 금지(P6 Repo Migration).
# ⚠️ awk 를 첫 매치에서 `exit` 시키지 말 것 — `set -euo pipefail` 아래에서 소비자가 먼저
# 끝나면 git 이 SIGPIPE 로 죽고 그 141 이 이 할당의 실패가 된다(리모트가 멀쩡한데 워처가
# 죽는다). promote-prod.sh 와 **동일 계약**이라 그쪽과 같은 형태로 맞춘다 — 첫 매치만 쓰되
# 입력은 끝까지 읽는다. 드리프트는 scripts/__tests__/promote-prod-check.test.ts 가 고정한다.
REMOTE=$(git remote -v | awk '$2 ~ /indexzigu\/wagcrm_git(\.git)?$/ && $3 == "(push)" && !found { print $1; found = 1 }')
if [ -z "$REMOTE" ]; then
  echo "⛔ indexzigu/wagcrm_git 을 가리키는 리모트가 없다. git remote -v 확인 필요." >&2
  exit 1
fi

# 머지 대기는 fetch 앞이다 — 머지되기 전엔 머지커밋이 없어 fetch·resolve 가 의미 없다.
if [ "$AWAIT_MERGE" = "1" ]; then
  await_merge "${2:?--pr <NN> 인자가 필요하다}"
fi

if [ "${AWAIT_SKIP_FETCH:-}" != "1" ]; then
  git fetch -q "$REMOTE" main
  # 구 플랫폼 브랜치는 그 레인을 판정할 때만 받는다(기본 레인은 볼 이유가 없다).
  if [ "$LANE_MODE" = "vercel" ]; then
    git fetch -q "$REMOTE" "$LANE" 2>/dev/null || true # 첫 승격 전엔 없다
  fi
fi

TARGET_SHA=$(resolve_target_sha "$@")
SHORT=$(git rev-parse --short "$TARGET_SHA" 2>/dev/null || echo "$TARGET_SHA")

if [ "$MODE" = "--check" ]; then
  case "$(evaluate "$TARGET_SHA")" in
    live)
      echo "✅ prod 에 실렸다: $SHORT (배포 완료)"
      exit 0 ;;
    notdeployed)
      echo "🕓 아직 서버에 반영 안 됨: $SHORT (배포는 수동 발화다 — 메뉴바 릴리스 섹션 또는 infra/selfhost/release-deploy.sh)"
      exit 3 ;;
    unverifiable)
      # ⚠️ 3(아직) 으로 접지 말 것 — 모르는 것을 "안 실렸다"로 답하면 멀쩡한 기능에
      # 재착수가 걸린다. 판정 불가는 별도 코드로 표면화한다.
      echo "🌫️ 배포 판정 불가: $SHORT — 위 사유 참조. **미배포가 아니다**(마커는 프로덕션 호스트에만 있다). 롤백 창구를 보려면 --lane vercel." >&2
      exit 5 ;;
    pending)
      echo "⏳ 승격됨 · 배포 빌드 진행 중: $SHORT (아직 prod 아님)"
      exit 3 ;;
    notpromoted)
      echo "🕓 아직 미승격: $SHORT (release 에 편입 안 됨 — 다음 배칭 승격 대기)"
      exit 3 ;;
    failed)
      echo "⛔ 이 커밋이 편입된 승격이 실패/취소됐다: $SHORT — promote-failed 이슈·Vercel 확인" >&2
      exit 1 ;;
  esac
fi

# --watch: 실릴 때까지 폴링. 종료 = 하네스의 세션 자동 재소환 트리거.
echo "⏳ prod 배포 대기: $SHORT (레인 $LANE_MODE · 간격 ${POLL_INTERVAL}s · 최대 ${POLL_ATTEMPTS}회)…"
for _ in $(seq 1 "$POLL_ATTEMPTS"); do
  case "$(evaluate "$TARGET_SHA")" in
    live)
      echo ""
      echo "✅ prod 에 실렸다: $SHORT — 배포 완료(대기 종료)."
      exit 0 ;;
    unverifiable)
      # 🪤 판정 근거가 없는 워처는 **영원히 깨지 않는다** — 이 도구가 없애려던 조용한
      # 미통지 그 자체다. 기다리는 척하지 말고 즉시 중단해 사람이 알아차리게 한다.
      echo ""
      echo "🌫️ 배포 판정 불가라 대기를 걸 수 없다: $SHORT — 위 사유 참조. 이 기계에서 판정할 수 없으므로 워처가 영원히 깨지 않는다(즉시 중단)." >&2
      exit 5 ;;
    failed)
      echo ""
      echo "⛔ 승격 실패/취소로 대기 중단: $SHORT — promote-failed 이슈·Vercel 대시보드 확인." >&2
      exit 1 ;;
    *)
      printf '.'
      # 마지막 시도면 sleep 없이 루프 종료 → 타임아웃
      sleep "$POLL_INTERVAL" 2>/dev/null || true ;;
  esac
done
echo ""
echo "⏳ 제한 시간 내 prod 도달 미확인: $SHORT — 승격이 지연 중일 수 있다. --check 로 재조회하라." >&2
exit 2
