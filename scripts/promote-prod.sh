#!/usr/bin/env bash
# 프로덕션 승격 — main 에 쌓인 머지를 release 로 fast-forward 해서
# "승격 1회 = Vercel 프로덕션 빌드 1회"로 배칭한다 (P6 배포 정본, 2026-07-24).
#
# 배경: PR 머지 = 즉시 빌드 시절, main 머지 50회/4일 × 빌드당 ~20 CPU분이
# Pro 포함 크레딧을 소진했다. main 은 빌드 없는 통합 브랜치로 두고,
# 배포하고 싶은 시점에 이 스크립트로 승격한다. 긴급 픽스도 머지 직후
# 바로 승격하면 된다(그래도 빌드 1회).
#
# 사용법:
#   bash scripts/promote-prod.sh                  # 미승격 커밋 확인 후 프롬프트
#   bash scripts/promote-prod.sh --yes            # 확인 생략(비대화형)
#   bash scripts/promote-prod.sh --dry-run        # push 없이 미승격 커밋만 표시
#   bash scripts/promote-prod.sh --check          # 승격 기준 평가(P6 Promotion Policy)
#   bash scripts/promote-prod.sh --poll-only <sha> # push 없이 배포 확인만 재실행
#
# --check 종료코드 계약 (세션/자동화가 판정을 소비할 수 있게 고정):
#   0 = 미승격 0건(배포 불필요) · 3 = 기준 충족(승격 권장) ·
#   2 = 미승격 있으나 기준 미달(내용 보고 판단 — 사용자 대면 변경이면 승격 고려)
#
# 안전장치:
#   - main 스냅샷을 배포한다(로컬 트리·로컬 main 미개입 — commit-tree 로 커밋
#     객체만 만들어 push, 워킹트리 안 건드림. 커밋된 스냅샷만 배포하는 P6 원칙 그대로).
#   - 배포 커밋 방식: release 에 "배포 커밋"(트리=main 과 동일, 부모=[release,main],
#     메시지=배치 PR목록 예 "deploy #105.106.107")을 쌓는다 — Vercel 배포 목록에서
#     배치에 담긴 PR 을 한눈에 보기 위함. push 직전 배포 커밋 트리 == main 트리를
#     해시로 검증한다(다르면 중단) — "정확히 main 내용만 배포"를 ff 보다 강하게 보증.
#     release 로의 push 는 배포 커밋의 첫 부모가 직전 release 라 항상 ff(강제 push 없음).
#   - push 후 커밋 상태 description 이 "Deployment has completed" 가 될 때까지
#     폴링한다. state 초록만 믿지 않는다 — "Canceled by Ignored Build Step"
#     초록 미배포 실사고(#68~#72)의 재발 감지가 목적.
#   - ⚠️ 폴링은 반드시 운영 프로젝트 컨텍스트("Vercel – wag-crm")만 본다.
#     release push 는 wagcrm-demo 에도 상태를 만들고, 데모의 정상 자기-취소
#     ("Canceled by Ignored Build Step")가 updated_at 순서상 항상 먼저 온다 —
#     컨텍스트 무필터 + head -1 이면 매 승격이 거짓 실패가 된다(리뷰 실증).
#     분류 로직은 scripts/__tests__/promote-prod-poll.test.ts 가 고정한다.
#   - 폴링이 취소·실패·타임아웃으로 끝나면 promote-auto.yml 과 같은 `promote-failed`
#     라벨로 GitHub 이슈를 연다(2026-08-02, 실사고: 사람이 직접 돌린 승격의 폴링
#     타임아웃은 터미널 밖으로 안 나가서 아무도 몰랐다 — push 는 이미 됐는데 배포
#     확인만 안 된 상태가 방치됐다). 이슈 열기 자체가 실패해도(권한 부족 등) 폴링의
#     판정(exit code)은 절대 바뀌지 않는다 — 항상 `|| true` 로 감싼다(P0: 부차 기능의
#     실패가 주 기능의 신호를 가리면 안 된다).

set -euo pipefail

REPO_SLUG="indexzigu/wagcrm"
LANE="release"
# 운영 배포 컨텍스트. 레포 Git 설정 "Consolidated Commit Status" 가 켜지면 Vercel 이
# 프로젝트별(Vercel – wag-crm / Vercel – wagcrm-demo) 대신 단일 "Vercel" 로 상태를 올린다.
# 둘 다 수용하되(어느 설정이든 동작), 데모 전용 컨텍스트(Vercel – wagcrm-demo)는 배제한다
# — 데모의 정상 자기-취소를 운영 취소로 오판하지 않기 위함(#104 CRITICAL 유지).
PROD_CONTEXT="Vercel – wag-crm"       # 비통합 설정일 때 (en-dash)
PROD_CONTEXT_CONSOLIDATED="Vercel"    # 통합 설정일 때 (실측: 2026-07-24 이 값이 옴)
POLL_INTERVAL="${PROMOTE_POLL_INTERVAL:-15}" # 테스트에서 0 으로 재정의
POLL_ATTEMPTS="${PROMOTE_POLL_ATTEMPTS:-60}" # 15s × 60 = 최대 15분
# --check 의 권장 문턱.
#
# ⛔ 종전 서술 "정본은 promote-auto.yml 의 COUNT_THRESHOLD·schedule cron 이고 이 두 값은
# 그것을 사람이 읽는 창구에 비출 뿐"은 **SUPERSEDED**(2026-08-13 자체호스팅 컷오버).
# 그 워크플로의 자동 트리거를 제거했으므로 **비출 대상 자체가 없다** — 이제 아무도
# 자동으로 승격하지 않는다.
#
# 두 값의 의미가 바뀌었다: "곧 자동 승격이 발화할 나이인가"가 아니라 **"구 플랫폼
# 롤백 창구가 얼마나 낡았는가"** 다. 낡아도 프로덕션에는 영향이 없다(자체호스팅이
# 서빙한다) — 롤백이 필요해지는 순간 그 시점의 코드로 수동 승격하면 되고, 그때
# 지켜야 할 순서는 rollback.sh 안내에 있다(자체호스팅 크론을 먼저 끈다).
#
# 배경(2026-08-04): MAX_AGE_HOURS 가 24 로 남아 있어 --check 가 "하루는 기다려야 한다"고
# 답하던 드리프트가 있었다. 그 교훈은 값이 아니라 **문구가 실제 발화 주체와 어긋나면
# 사람이 헛판단한다**는 것이고, 이번 변경에서 문구를 함께 고친 이유도 같다.
MAX_PENDING="${PROMOTE_MAX_PENDING:-5}"     # 롤백 창구 신선도 — 미승격 건수
MAX_AGE_HOURS="${PROMOTE_MAX_AGE_HOURS:-4}" # 롤백 창구 신선도 — 최고령 시간

MODE="${1:-}"

ISSUE_LABEL="promote-failed"

# 폴링이 취소·실패·타임아웃으로 끝났을 때 GitHub 이슈로 알린다 — promote-auto.yml
# 의 같은 라벨 관례를 재사용해 자동·수동 승격이 같은 감시선(그 라벨을 보는 사람·
# 도구)에 걸리게 한다. 열린 이슈가 있으면 새로 만들지 않고 코멘트한다(중복 방지,
# promote-auto.yml 과 동일한 판단).
#
# ⚠️ 이 함수의 실패(gh 권한 부족·네트워크 등)는 절대 poll_deployment 의 판정을
# 바꾸지 않는다 — 호출부가 항상 `|| true` 로 감싸고, 이 함수 내부도 각 gh 호출을
# 개별적으로 관용한다. 부차 기능(알림)의 실패가 주 기능(승격 판정)의 신호를
# 가리면 P0 원칙("실패를 삼키지 않는다")이 스스로 무너진다.
report_promotion_uncertain() {
  local sha="$1" subject="$2" reason="$3"
  gh label create "$ISSUE_LABEL" --repo "$REPO_SLUG" --color B60205 \
    --description "승격/배포 실패 또는 미확인 — 자동·수동 공통 (P6)" \
    >/dev/null 2>&1 || true

  local body_file
  body_file="$(mktemp)"
  {
    echo "승격 push는 됐지만 배포 완료를 확인하지 못했습니다(수동 실행 — GitHub Actions 아님)."
    echo ""
    echo "- **커밋**: \`$sha\`${subject:+ ($subject)}"
    echo "- **사유**: $reason"
    echo "- **재확인**: \`bash scripts/promote-prod.sh --poll-only $sha\`"
    echo "- **원인 판별**: 커밋 상태 description 을 직접 읽는다 —"
    echo "  \`gh api repos/$REPO_SLUG/commits/$sha/status --jq '.statuses[]'\`"
    echo ""
    echo "release 로의 push 자체는 이미 성공했다 — 이 이슈는 \"승격 실패\"가 아니라"
    echo "\"배포 완료를 아직 확인 못함\"이다. 흔한 원인: Vercel 빌드 실패(prod 는 기존"
    echo "배포 유지 중)·배포 확인 타임아웃(수 분 뒤 재확인하면 성공으로 바뀔 수 있음)·"
    echo "Ignored Build Step 오설정."
  } > "$body_file"

  local existing
  existing=$(gh issue list --repo "$REPO_SLUG" --label "$ISSUE_LABEL" --state open \
    --json number --jq '.[0].number // empty' 2>/dev/null || true)
  if [ -n "$existing" ]; then
    gh issue comment "$existing" --repo "$REPO_SLUG" --body-file "$body_file" >/dev/null 2>&1 \
      && echo "   → 기존 이슈 #$existing 에 코멘트했다." >&2 \
      || echo "   → 기존 이슈 #$existing 코멘트 실패(권한 부족 등) — 위 재확인 명령을 직접 실행하라." >&2
  else
    local created
    if created=$(gh issue create --repo "$REPO_SLUG" --label "$ISSUE_LABEL" \
        --title "⛔ 승격 배포 확인 실패 (수동, sha=${sha:0:7})" \
        --body-file "$body_file" 2>/dev/null); then
      echo "   → 이슈를 열었다: $created" >&2
    else
      echo "   → 이슈 생성 실패(권한 부족 등) — 위 재확인 명령을 직접 실행하라." >&2
    fi
  fi
  rm -f "$body_file"
}

poll_deployment() {
  local sha="$1" subject="${2:-}"
  local status_line
  for _ in $(seq 1 "$POLL_ATTEMPTS"); do
    # gh 는 컨텍스트별 상태를 TSV 로 평탄화만 하고, 운영 컨텍스트 선택은
    # bash(awk)에서 한다 — 테스트가 gh 를 스텁으로 갈아끼워 이 선택 로직을
    # 픽스처로 고정할 수 있게 하기 위함.
    status_line=$(gh api "repos/$REPO_SLUG/commits/$sha/status" \
      --jq '.statuses[] | "\(.context)\t\(.state) \(.description)"' 2>/dev/null \
      | awk -F'\t' -v ctx="$PROD_CONTEXT" -v cons="$PROD_CONTEXT_CONSOLIDATED" \
          '$1 == ctx || $1 == cons { print $2; exit }' || true)
    case "$status_line" in
      *"Deployment has completed"*)
        echo ""
        echo "✅ 배포 완료: [$PROD_CONTEXT] $status_line"
        return 0
        ;;
      *Canceled*|*canceled*)
        echo ""
        echo "⛔ 운영 빌드가 취소됐다: [$PROD_CONTEXT] $status_line" >&2
        echo "   wag-crm 프로젝트의 Ignored Build Step 인자가 '$LANE' 인지 확인하라(#68~#72 유형)." >&2
        report_promotion_uncertain "$sha" "$subject" "운영 빌드가 취소됨: $status_line" || true
        return 1
        ;;
      failure*|error*)
        echo ""
        echo "⛔ 배포 실패: [$PROD_CONTEXT] $status_line" >&2
        report_promotion_uncertain "$sha" "$subject" "Vercel 배포 실패: $status_line" || true
        return 1
        ;;
      *)
        # 상태 미생성(빈 문자열)·pending 포함 — 계속 대기
        printf '.'
        sleep "$POLL_INTERVAL"
        ;;
    esac
  done
  echo ""
  echo "⏳ 제한 시간 내 완료 확인 실패 — Vercel 대시보드에서 직접 확인 필요." >&2
  report_promotion_uncertain "$sha" "$subject" \
    "${POLL_ATTEMPTS}회(${POLL_INTERVAL}s 간격) 안에 [$PROD_CONTEXT] 상태를 확인 못함" || true
  return 1
}

if [ "$MODE" = "--poll-only" ]; then
  SHA="${2:?--poll-only 는 <sha> 인자가 필요하다}"
  echo "Vercel 배포 확인 중 (sha=$SHA)…"
  poll_deployment "$SHA"
  exit $?
fi

# 정본 리모트 탐지 — 구 레포(indexzigu/wag-crm)와 혼동 금지 (P6 Repo Migration)
# ⚠️ awk 를 첫 매치에서 `exit` 시키지 말 것 — 아래 --check 의 `| head` 와 **같은 SIGPIPE
# 함정**이다. awk 가 먼저 끝나면 git 이 SIGPIPE 로 죽고 `set -euo pipefail` 이 그 141 을
# 이 할당의 실패로 만들어, 리모트가 멀쩡한데도 승격이 통째로 죽는다. 첫 매치만 쓰되
# 입력은 끝까지 읽는다(리모트 목록은 몇 줄이라 비용 차이가 없다).
REMOTE=$(git remote -v | awk '$2 ~ /indexzigu\/wagcrm(\.git)?$/ && $3 == "(push)" && !found { print $1; found = 1 }')
if [ -z "$REMOTE" ]; then
  echo "⛔ indexzigu/wagcrm 을 가리키는 리모트가 없다. git remote -v 확인 필요." >&2
  exit 1
fi

git fetch -q "$REMOTE" main
git fetch -q "$REMOTE" "$LANE" 2>/dev/null || true # 첫 승격 전엔 release 가 없다

MAIN_SHA=$(git rev-parse "refs/remotes/$REMOTE/main")

if git rev-parse -q --verify "refs/remotes/$REMOTE/$LANE" >/dev/null; then
  LANE_SHA=$(git rev-parse "refs/remotes/$REMOTE/$LANE")
  # 승격 모델: release 에 "배포 커밋"(트리=main, 부모=[release,main], 메시지=배치 PR목록)을
  # 쌓는다 — Vercel 배포 목록에서 배치에 담긴 PR 을 한눈에 보기 위함. 따라서 release 는
  # main 의 조상이 아니다(과거 ff-조상 가드는 폐기). 판단은 "release 가 아직 담지 않은
  # main 커밋 수"(rev-list release..main)로 하고, 배포 커밋 트리를 main 트리와 동일하게
  # 만들어(commit-tree) "정확히 main 내용만 배포"를 트리 해시로 보증한다(push 직전 검증).
  PENDING=$(git rev-list --count "$LANE_SHA..$MAIN_SHA")
  if [ "$PENDING" -eq 0 ]; then
    echo "✅ $LANE 이 main($MAIN_SHA)을 모두 포함한다 — 승격할 것이 없다."
    exit 0
  fi
  echo "미승격 커밋 ($LANE..main):"
  git log --oneline "$LANE_SHA..$MAIN_SHA"
else
  LANE_SHA="" # 첫 승격 — release 없음
  echo "리모트에 $LANE 브랜치가 없다 — 첫 승격으로 생성한다 (main=$MAIN_SHA)."
  if [ "$MODE" = "--check" ]; then
    echo "📣 승격 권장: $LANE 브랜치 부재(첫 승격 필요). → bash scripts/promote-prod.sh"
    exit 3
  fi
fi

if [ "$MODE" = "--check" ]; then
  # P6 Promotion Policy — 기계 판정 가능한 두 축만 여기서 본다.
  # (즉시 승격 축 — 보안/장애 픽스·마이그레이션 동반 — 은 내용 판단이라
  #  머지를 수행한 세션이 P6 규율로 직접 판정한다.)
  PENDING=$(git rev-list --count "$LANE_SHA..$MAIN_SHA")
  # ⚠️ `git log … | head -1` 로 쓰지 말 것 — head 가 먼저 파이프를 닫아 git 이 SIGPIPE 로
  # 죽고, `set -euo pipefail` 아래에서 그 141 이 그대로 스크립트를 넘어뜨린다(--check 의
  # 0/2/3 종료코드 계약이 깨진다). 실측: 이 계약 테스트가 CI 에서 141 로 실패했다
  # (미승격이 많을수록 잘 터지는 타이밍 의존이라 로컬에선 통과했다).
  # tail 은 입력을 끝까지 읽으므로 안전하고, git log 는 최신순이라 마지막 줄이 최고령이다.
  OLDEST_TS=$(git log --format=%ct "$LANE_SHA..$MAIN_SHA" | tail -1)
  AGE_HOURS=$(( ( $(date +%s) - OLDEST_TS ) / 3600 ))
  if [ "$PENDING" -ge "$MAX_PENDING" ] || [ "$AGE_HOURS" -ge "$MAX_AGE_HOURS" ]; then
    echo "📣 승격 권장: 미승격 ${PENDING}건 · 최고령 ${AGE_HOURS}h (문턱: ≥${MAX_PENDING}건 또는 ≥${MAX_AGE_HOURS}h)"
    echo "   → bash scripts/promote-prod.sh"
    exit 3
  fi
  echo "ℹ️ 문턱 미달: 미승격 ${PENDING}건 · 최고령 ${AGE_HOURS}h (문턱: ≥${MAX_PENDING}건 또는 ≥${MAX_AGE_HOURS}h)"
  echo "   ⚠️ 자동 승격은 꺼져 있다(2026-08-13 자체호스팅 컷오버) — 기다려도 나가지 않는다."
  echo "   프로덕션은 자체호스팅이 서빙하고 $LANE 은 구 플랫폼 롤백 창구로만 남는다."
  echo "   그 창구를 지금 최신화할 이유가 있으면 수동 승격하라(P6)."
  exit 2
fi

if [ "$MODE" = "--dry-run" ]; then
  echo "(dry-run) push 생략."
  exit 0
fi

if [ "$MODE" != "--yes" ]; then
  read -r -p "release 로 승격(= 프로덕션 배포)할까? [y/N] " answer
  [ "$answer" = "y" ] || { echo "중단."; exit 1; }
fi

# 배포 커밋 메시지: 배치에 담긴 PR 번호를 모아 subject 로 (Vercel 배포 목록 가독성).
if [ -n "$LANE_SHA" ]; then
  RANGE="$LANE_SHA..$MAIN_SHA"
  # ⚠️ `|| true` 필수. 범위 안의 커밋 제목에 `#NN` 프리픽스가 하나도 없으면 grep 이
  #    종료코드 1 을 내고, `set -e` 가 **여기서 스크립트를 죽인다**. 아래 258행에 빈 값
  #    폴백(`deploy <sha>`)이 있는데도 거기 도달하지 못한다 — 2026-08-12 실사고:
  #    squash 머지 직전 PR 제목 변경이 반영되지 않아 프리픽스 없는 머지 커밋이 생겼고,
  #    그 결과가 머지 시점이 아니라 **승격 시점에** 원인 불명의 exit 1 로 나타났다.
  NUMS=$(git log --reverse --format=%s "$RANGE" | grep -oE '^#[0-9]+' | tr -d '#' | tr '\n' '.' | sed 's/\.$//' || true)
else
  RANGE="$MAIN_SHA" # 첫 승격 — 전체 이력이라 번호 나열 대신 sha
  NUMS=""
fi
if [ -n "$NUMS" ]; then
  SUBJECT="deploy #$NUMS" # 예: deploy #105.106.107
else
  SUBJECT="deploy $(git rev-parse --short "$MAIN_SHA")"
fi

# 배포 커밋: 트리는 main 과 100% 동일(정확히 main 내용만 배포), 부모=[release,main]
# (첫 승격이면 [main]). commit-tree 는 워킹트리·HEAD 를 건드리지 않는다.
if [ -n "$LANE_SHA" ]; then PARENTS=(-p "$LANE_SHA" -p "$MAIN_SHA"); else PARENTS=(-p "$MAIN_SHA"); fi
DEPLOY_SHA=$(
  { printf '%s\n\n승격 배치 (main→%s):\n' "$SUBJECT" "$LANE"
    if [ -n "$LANE_SHA" ]; then git log --format='- %s' "$RANGE"; else echo "- (첫 승격) $MAIN_SHA"; fi
  } | GIT_AUTHOR_NAME="wagcrm-promote" GIT_AUTHOR_EMAIL="promote@wagcrm.local" \
      GIT_COMMITTER_NAME="wagcrm-promote" GIT_COMMITTER_EMAIL="promote@wagcrm.local" \
      git commit-tree "$MAIN_SHA^{tree}" "${PARENTS[@]}"
)

# 안전: 배포 커밋 트리가 main 트리와 정확히 같은지 검증(다르면 절대 push 안 함).
if [ "$(git rev-parse "$DEPLOY_SHA^{tree}")" != "$(git rev-parse "$MAIN_SHA^{tree}")" ]; then
  echo "⛔ 배포 커밋 트리가 main 트리와 다르다 — 중단(내용 불일치)." >&2
  exit 1
fi
echo "배포 커밋: $DEPLOY_SHA  [$SUBJECT]  (트리=main 확인)"

git push "$REMOTE" "$DEPLOY_SHA:refs/heads/$LANE"
echo "push 완료. Vercel 배포 확인 중 (sha=$DEPLOY_SHA, $SUBJECT)…"
if [ "${PROMOTE_NO_POLL:-}" = "1" ]; then
  echo "(PROMOTE_NO_POLL) 배포 확인 폴링 생략."
  exit 0
fi
poll_deployment "$DEPLOY_SHA" "$SUBJECT"
