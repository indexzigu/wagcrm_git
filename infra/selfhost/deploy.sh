#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"

# ── P0 안전장치 ①: 이 스크립트는 `npm run build` 를 부르고, 그 안의
# prisma-migrate-on-deploy 가 (VERCEL_ENV=production 가드를 통과한 경우에만)
# DATABASE_URL 대상 DB 에 마이그레이션을 적용한다. 아래 host 가드가 검사하는
# 값이 바로 이 줄에서 export 되는 DATABASE_URL 이다.
# ⛔ 종전 주석 "로컬 Supabase 가 아닌 곳을 가리키면 프로덕션에 쓰게 된다" 는
# SUPERSEDED (2026-08-13 셀프호스트 컷오버) — 프로덕션 DB 가 곧 이 기계의 로컬
# Supabase 라 방향이 뒤집혔다. 지금 막는 것은 "로컬이 아닌 원격 DB(은퇴한
# 클라우드 프로젝트·외부 스테이징·장래의 관리형 DB)에 마이그레이션이 나가는 것"
# 이다. 근거 정본은 infra/selfhost/README.md 「DATABASE_URL 가드」.
set -a; . infra/selfhost/.env; set +a

# ── P0 안전장치 ⓪: `scripts/prisma-migrate-on-deploy.mjs` 는 "지금이
# Vercel 프로덕션인가"를 `VERCEL_ENV === "production"` 하나로만 판정한다.
# 이 iMac 에는 Vercel 이 그 값을 주입해줄 사람이 없다 — `.env` 가 유일한
# 공급원이다. 빠뜨리면(또는 오타) 그 스크립트가 "production 아님"으로 착각해
# 마이그레이션 적용을 조용히 건너뛰고 exit 0(성공)을 보고한다 — 빌드는
# 초록인데 스키마는 구버전에 멈춰, 다음 스키마 변경 배포 때 P2022 전면
# 장애로 터진다. (부수 효과: `src/lib/agent-lane.ts`·
# `src/lib/supabase/middleware.ts` 의 에이전트 우회 레인 1차 조건도 이 값에
# 걸려 있어 같이 풀리지만, 그 레인은 `AGENT_BYPASS_TOKEN` 미설정으로도
# 막혀 있어야 한다 — README ".env 필수 변수 계약" 참고.) 이 가드를 "Vercel
# 잔재"로 여겨 지우지 말 것 — 이 스크립트가 유일한 방어선이다.
if [ "${VERCEL_ENV:-}" != "production" ]; then
  echo "중단: VERCEL_ENV 가 'production' 이 아닙니다(현재: '${VERCEL_ENV:-없음}'). infra/selfhost/.env 에 VERCEL_ENV=production 을 설정하세요 — 이 값이 없으면 마이그레이션이 조용히 건너뛰어지고 에이전트 우회 레인의 1차 방어선도 풀립니다." >&2
  exit 1
fi

# ⚠️ 단순 `case "$DATABASE_URL" in *localhost*|*127.0.0.1*)` 는 URL 전체
# 문자열에 대한 부분일치라서 잘못됐다 — 예를 들어 자격증명(비밀번호)이나
# 쿼리스트링에 우연히 "127.0.0.1" 이라는 글자만 섞여 있어도 host 는
# 원격인데 가드를 통과해버린다. 오늘은 이론상 문제지만, 향후 크리덴셜
# 교체로 비밀번호에 그 문자열이 들어가는 순간 이 가드가 유일한 방어선인
# "의도하지 않은 원격 DB 오염"을 놓친다. 그래서 host 부분만 정확히 추출해 정확히
# 비교한다: scheme(`://`) 제거 → 마지막 `@` 까지(자격증명) 제거 → 첫 `:`
# 또는 `/` 에서 절단.
db_host_of() {
  local url="$1" authority host
  if [[ "$url" =~ ^[A-Za-z][A-Za-z0-9+.-]*://([^/]*) ]]; then
    authority="${BASH_REMATCH[1]}"
  else
    authority="$url"
  fi
  # 자격증명 제거: 마지막 '@' 이후만 남긴다(비밀번호 안에 '@' 가 있어도
  # host 앞부분이 아니라 자격증명 쪽에 남아 안전하다).
  authority="${authority##*@}"
  # host:port 에서 port 분리
  host="${authority%%:*}"
  printf '%s' "$host"
}
DB_HOST="$(db_host_of "${DATABASE_URL:-}")"
case "$DB_HOST" in
  localhost|127.0.0.1) ;;
  *) echo "중단: DATABASE_URL 이 로컬 Supabase 가 아닙니다(host=${DB_HOST:-없음}). 배포를 실행하지 않습니다." >&2; exit 1;;
esac

# ── P0 안전장치 ②: 개발 워크트리에서 실행되면 메인 레포와 공유하는
# node_modules 를 망가뜨린다.
case "$REPO_ROOT" in
  *"/.claude/worktrees/"*) echo "중단: 개발 워크트리입니다. 운영 체크아웃에서 실행하세요." >&2; exit 1;;
esac

# 배포 완료 마커: 체크아웃 안(레포 트리)에 두면 `git reset --hard` 가
# 다음 배포 때 같이 지워버린다 — 반드시 체크아웃 밖, 기존 로그/상태
# 디렉터리(~/selfhost/logs) 관례를 따르는 경로에 둔다.
MARKER_DIR="$(dirname "$REPO_ROOT")/logs"

# ── 프리뷰 레인 오버라이드 — 안 주면 프로덕션 기본값 그대로 ──
APP_LAUNCHD_LABEL="${APP_LAUNCHD_LABEL:-kr.ygrd.wagcrm.app}"
APP_PORT="${APP_PORT:-3000}"

# ⚠️ 마커 파일명은 **레인마다 갈라야 한다.** 위 MARKER_DIR 은 체크아웃의 부모
# 디렉터리에서 나오는데, 프로덕션(~/selfhost/wagcrm)과 프리뷰
# (~/selfhost/wagcrm-preview)의 부모가 **같은 ~/selfhost** 라 두 레인의 마커
# 디렉터리가 겹친다. 파일명까지 같으면 프리뷰 배포가 프로덕션 마커를 덮어쓰고,
# 두 레인 모두 `main` 을 추종하므로 SHA 까지 일치해 프로덕션 deploy.sh 가
# "변경 없음" 으로 **조용히 종료**한다 — 프로덕션은 구버전을 서빙 중인데 마커는
# 최신인, 이 스크립트가 애초에 방어하려던 바로 그 실패 모드다.
# 라벨에서 파생하므로 새 레인이 지정을 잊을 수 없고, 프로덕션 파일명은 기존
# 그대로라 첫 배포가 전량 재빌드되지 않는다.
if [ "$APP_LAUNCHD_LABEL" = "kr.ygrd.wagcrm.app" ]; then
  MARKER_NAME="deployed.sha"
else
  MARKER_NAME="deployed.${APP_LAUNCHD_LABEL##*.}.sha"
fi
MARKER_FILE="$MARKER_DIR/$MARKER_NAME"

# ── 추종 브랜치: main (2026-08-13 자체호스팅 컷오버 이후) ──
# ⛔ 종전에는 `release` 를 추종했다. 그 레인은 **구 플랫폼의 빌드 비용을 배칭하려고**
# 만든 장치였는데(승격 1회 = Vercel 빌드 1회), 자체호스팅에는 빌드 한도가 없어 그
# 배칭이 순수한 지연으로만 남는다. 실제로 컷오버 당일, cutover.sh 결함을 고칠 때마다
# 머지 → **승격** → pull 을 반복해야 했다 — deploy.sh 가 체크아웃을 `origin/release`
# 로 하드 리셋하기 때문에 승격 없이는 수정이 이 기계에 도달하지 못했다.
#
# 이제 머지 → `git pull` 만으로 반영된다. `release` 는 구 플랫폼 롤백 창구로만 남고,
# 그 갱신은 수동 승격(promote-auto.yml workflow_dispatch)이 담당한다.
# APP_TRACK_BRANCH 를 주면 그 브랜치를 추종한다(프리뷰 레인 — 머지 전 브랜치 확인용).
# 안 주면 프로덕션 기본값 main.
TRACK_BRANCH="${APP_TRACK_BRANCH:-main}"

# ── P0 안전장치 ⑤: 프로덕션 레인은 이 오버라이드를 **거부한다**(무시가 아니라 중단).
# 이 실패 모드는 APP_TRACK_BRANCH 와 함께 새로 생겼다: 프리뷰를 디버깅하던 셸에
# `export APP_TRACK_BRANCH=<기능브랜치>` 가 남은 채로 프로덕션 배포를 돌리면,
# 프로덕션이 그 기능 브랜치를 빌드해 그대로 서빙한다. 그런데 PID 교체·헬스체크·
# DB 프로브가 **전부 정상 통과**하고 마커까지 갱신되므로 어디에도 이상 신호가
# 남지 않는다 — 사람이 알아챌 단서가 없는 조용한 오배포다.
# 값이 우연히 `main` 이어도 거부한다: "이 변수가 설정돼 있다"는 사실 자체가 셸이
# 오염됐다는 신호이고, 여기서 멈추는 비용은 `unset` 한 줄뿐이다.
# ⚠️ 오버라이드를 **안 준** 프로덕션 경로는 이 블록을 그냥 통과한다 — 기본 동작은
# 종전과 완전히 동일하다(`scripts/__tests__/selfhost-lane-defaults.test.ts`).
if [ "$APP_LAUNCHD_LABEL" = "kr.ygrd.wagcrm.app" ] && [ -n "${APP_TRACK_BRANCH:-}" ]; then
  echo "중단: 프로덕션 레인에서는 APP_TRACK_BRANCH 오버라이드를 받지 않습니다(현재 값: '$APP_TRACK_BRANCH'). 프리뷰를 만지던 셸이라면 'unset APP_TRACK_BRANCH' 후 다시 실행하세요 — 프로덕션은 항상 main 을 추종합니다." >&2
  exit 1
fi

# 어느 레인을 어느 브랜치로 배포하는지 **먼저 말한다.** 종전에는 이 스크립트의 어떤
# 출력도 브랜치를 언급하지 않아, 엉뚱한 브랜치를 배포해도 로그만 봐서는 알 수 없었다.
# "변경 없음" 조기 종료 경로보다 앞에 둬서 그 경우에도 좌표가 남게 한다.
echo "[deploy] 레인 $APP_LAUNCHD_LABEL · 포트 $APP_PORT · 추종 브랜치 $TRACK_BRANCH"

git fetch origin "$TRACK_BRANCH"
LATEST="$(git rev-parse "origin/$TRACK_BRANCH")"
MARKER_SHA="$(cat "$MARKER_FILE" 2>/dev/null || true)"
# ⚠️ "변경 없음" 판정은 HEAD(체크아웃 상태)가 아니라 이 마커와 비교한다.
# HEAD 로 비교하면, 빌드가 실패해도 체크아웃 자체는 이미 최신으로
# 리셋돼 있어서 다음 실행이 "변경 없음"으로 조용히 종료해버린다 — 서비스는
# 여전히 구버전을 서빙 중인데 재배포 시도조차 안 하게 된다. 마커는
# 헬스체크까지 전부 성공했을 때만 갱신하므로, 빌드 실패 시 마커가 이전
# sha 에 머물러 있어 재실행이 FORCE 없이도 정상적으로 재시도한다.
if [ "$LATEST" = "$MARKER_SHA" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "[deploy] 변경 없음 ($LATEST) — FORCE=1 로 강제 재배포"; exit 0
fi

# ── P0 안전장치 ⑦: 배포 직전 CI 게이트 (T-069, 2026-08-27) ─────────────────
# (⑥ 은 아래 `.env` 공란 점검의 번호다 — 이 레포는 가드를 번호로 상호 참조하므로
#  번호는 등재 차례대로 하나씩만 쓴다. ⑥ 의 주석에 그 계약이 있다.)
# 2026-08-26 비공개 전환으로 GitHub 무료 플랜이 브랜치 보호를 정지시켰다
# (rulesets API 403 — P6 「Main Push Guard」). 검사 실패 PR 머지·main 직접
# push 를 서버가 더는 막지 않으므로, 프로덕션에 나가기 직전 여기서 판정한다:
# 이번에 나가는 커밋 구간(마커..origin/main)의 각 커밋이 「required 3종
# (guard·preflight·test)을 전부 통과한 머지된 PR」로 들어왔는가. 연결 PR 이
# 없는 커밋(= main 직접 push)도 거부한다.
# - main 커밋 자체의 검사로는 판정할 수 없다: main push run 에는 guard 가
#   아예 없고 test 는 skip 이다(실측 2026-08-27) — 그래서 커밋의 원 PR 을
#   되짚는다(squash 전용 레포라 main 커밋 1개 = 머지된 PR 1개).
# - 판정 불능(gh 부재·미인증·네트워크)은 fail-closed 다. 비상시에만
#   SKIP_CI_GATE=1 로 명시 우회한다(FORCE=1 과 같은 결 — 로그에 남는다).
# - 프로덕션 레인 전용: 프리뷰는 PR 없는 기능 브랜치를 띄우므로 걸면 안 된다.
# 짝 계약: scripts/__tests__/main-push-guard.contract.test.ts
if [ "$APP_LAUNCHD_LABEL" = "kr.ygrd.wagcrm.app" ]; then
  if [ "${SKIP_CI_GATE:-0}" = "1" ]; then
    echo "[deploy] ⚠️ SKIP_CI_GATE=1 — 배포 직전 CI 게이트를 명시 우회합니다"
  else
    command -v gh >/dev/null 2>&1 || { echo "중단: gh CLI 가 없어 CI 게이트를 판정할 수 없습니다(fail-closed). 비상시에만 SKIP_CI_GATE=1 로 우회하세요." >&2; exit 1; }
    GATE_REPO="$(git remote get-url origin | sed -E 's#\.git$##; s#.*[:/]([^/]+/[^/]+)$#\1#')"
    if [ -n "$MARKER_SHA" ] && git merge-base --is-ancestor "$MARKER_SHA" "$LATEST" 2>/dev/null; then
      # --first-parent: main 에 실제로 착지한 커밋만 센다. 이 레포는 squash 전용이라
      # (allow_merge_commit=false) 평시엔 차이가 없지만, 이관 초기 merge commit 6건이
      # 이력에 남아 있어 그때는 병합된 브랜치 커밋까지 전부 훑게 된다(API 폭주).
      GATE_COMMITS="$(git rev-list --first-parent "$MARKER_SHA..$LATEST")"
    else
      # 마커가 없거나(신규 레인) 조상이 아니면(마커 유실·이력 재작성) 구간을 정할 수
      # 없다. 전 이력 검사는 API 폭주라 기각하고, **상한을 둔 창**으로 훑는다.
      # ⚠️ 1커밋만 보는 초판은 마커 유실 사이에 쌓인 커밋을 조용히 통과시켰다 —
      # 이 게이트가 막으려는 바로 그 형태다. 창을 넘긴 부분은 아래처럼 **미검증이라고
      # 말한다**(P6 「No silent caps」 — 조용한 절단은 "전부 봤다"로 읽힌다).
      # ⛔ 여기서 fail-closed 로 가지 말 것: 마커 유실만으로 배포가 영구 차단되면
      # 운영자가 SKIP_CI_GATE=1 을 습관으로 쓰게 되어 게이트 전체가 죽는다.
      GATE_FALLBACK_MAX=20
      GATE_COMMITS="$(git rev-list --first-parent --max-count="$GATE_FALLBACK_MAX" "$LATEST")"
      echo "[deploy] ⚠️ CI 게이트: 마커 기준 구간을 정할 수 없어 최신 ${GATE_FALLBACK_MAX}커밋만 검사합니다(그보다 오래된 커밋은 미검증으로 남습니다)"
    fi
    # FORCE=1 재배포는 구간이 비는 것이 정상이다(이미 검증된 같은 커밋을 다시 올린다).
    # 빈 채로 조용히 통과하면 "게이트가 돌았나"를 로그로 알 수 없으므로 명시한다.
    [ -n "$GATE_COMMITS" ] || echo "[deploy] CI 게이트: 새로 나가는 커밋이 없습니다(재배포)"
    for GATE_SHA in $GATE_COMMITS; do
      # 루트 커밋(부모 없음)은 **구조적으로 PR 을 거칠 수 없다** — 레포의 첫 커밋은
      # 비교할 베이스가 없어 PR 을 만들 수 없기 때문이다. 아래 「연결 PR 없음 = 직접
      # push 의심」 판정에 그대로 걸리면 **새 레포의 첫 배포가 영구 차단**된다
      # (2026-08-28 실측: wagcrm_git 전환에서 실제로 여기서 멈췄다).
      # 🪤 판정을 `git rev-list --parents | cut -d' ' -f2-` 로 하지 말 것 — `cut` 은
      # 구분자가 없으면 **줄 전체를 반환**해서 루트 커밋이 "부모 있음"으로 보인다
      # (같은 날 실측). 필드 수로 세거나 `rev-parse <sha>^` 의 실패로 판정한다.
      # ⛔ **얕은 복제(shallow)에서는 판정할 수 없다 — fail-closed.** 얕은 복제는
      # 잘린 지점의 커밋에 부모가 없는 것처럼 보이므로, 아래 루트 예외가 **모든
      # 커밋을 건너뛰어 게이트를 통째로 무력화**한다(조용한 전면 통과). 배포
      # 체크아웃은 전체 복제여야 한다.
      if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
        echo "중단: 배포 체크아웃이 얕은 복제(shallow)라 커밋 계보를 판정할 수 없습니다 — 게이트가 무력화되므로 fail-closed 로 멈춥니다. 'git fetch --unshallow' 로 전체 이력을 받으십시오." >&2
        exit 1
      fi
      if ! git rev-parse -q --verify "${GATE_SHA}^" >/dev/null 2>&1; then
        echo "[deploy] CI 게이트 건너뜀: ${GATE_SHA:0:8} 는 루트 커밋(부모 없음) — PR 이 존재할 수 없다"
        continue
      fi
      GATE_PR="$(gh api "repos/$GATE_REPO/commits/$GATE_SHA/pulls" \
        --jq '[.[] | select(.merged_at != null)][0] // empty | "\(.number) \(.head.sha)"')" \
        || { echo "중단: CI 게이트 조회 실패(커밋 ${GATE_SHA:0:8} 의 PR 조회). 네트워크·gh 인증을 확인하세요 — 판정 불능은 fail-closed 입니다." >&2; exit 1; }
      if [ -z "$GATE_PR" ]; then
        echo "중단: 커밋 ${GATE_SHA:0:8} 는 머지된 PR 로 들어온 커밋이 아닙니다(main 직접 push 의심 — T-069). PR 경로로 다시 태우거나, 조사 후 비상시에만 SKIP_CI_GATE=1 로 우회하세요." >&2
        exit 1
      fi
      GATE_PR_NUM="${GATE_PR%% *}"
      GATE_HEAD_SHA="${GATE_PR##* }"
      # ⚠️ `test` 는 **이름이 하나가 아니다.** 2026-08-28 에 4분할하면서 체크 이름이
      # `test` → `test (1)`…`test (4)` 로 바뀌었다(공개 레포 이전 직후 CI 가속).
      # 종전처럼 `test` 를 정확 일치로 찾으면 **분할된 뒤로는 영원히 못 찾아** 모든
      # 배포가 막힌다 — 실제로 이 전환에서 그렇게 멈췄다. 그래서 `test` 로 시작하는
      # 검사를 **전부** 모으고 **전부 success** 를 요구한다(하나라도 빠지면 조각이
      # 조용히 누락된 채 통과한다).
      GATE_CHECKS="$(gh api "repos/$GATE_REPO/commits/$GATE_HEAD_SHA/check-runs" \
        --jq '.check_runs[] | select(.name == "guard" or .name == "preflight" or (.name | startswith("test"))) | "\(.name)=\(.conclusion)"')" \
        || { echo "중단: CI 게이트 조회 실패(PR #$GATE_PR_NUM 의 검사 결과 조회)." >&2; exit 1; }
      GATE_FAIL_NAME=""
      for GATE_NAME in guard preflight; do
        grep -qx "${GATE_NAME}=success" <<<"$GATE_CHECKS" || { GATE_FAIL_NAME="$GATE_NAME"; break; }
      done
      if [ -z "$GATE_FAIL_NAME" ]; then
        # 분할 여부와 무관하게: 최소 1개 존재 + 전부 success.
        GATE_TEST_LINES="$(grep -E '^test( \(|=)' <<<"$GATE_CHECKS" || true)"
        # 🪤 **`grep -qv` 로 판정하지 말 것 — 이 맥에서 거짓말을 한다.** `grep` 이
        # ugrep 이라 `-q` 가 **반전 전 패턴** 기준으로 종료코드를 낸다: 실측(2026-08-28)
        # 에서 `grep -v '=success$'` 는 실패한 조각을 출력하는데 `grep -qv` 는 1(미발견)
        # 을 냈다 ⇒ 조각 하나가 failure 여도 게이트가 **통과**했다. 종료코드가 아니라
        # **출력의 유무**로 판정한다.
        GATE_BAD_TEST="$(grep -v '=success$' <<<"$GATE_TEST_LINES" || true)"
        if [ -z "$GATE_TEST_LINES" ]; then
          GATE_FAIL_NAME="test(검사 없음)"
        elif [ -n "$GATE_BAD_TEST" ]; then
          GATE_FAIL_NAME="$(head -1 <<<"$GATE_BAD_TEST" | cut -d= -f1)"
        fi
      fi
      if [ -n "$GATE_FAIL_NAME" ]; then
        {
          echo "중단: PR #$GATE_PR_NUM (커밋 ${GATE_SHA:0:8}) 의 required 검사 '${GATE_FAIL_NAME}' 이 success 가 아닙니다."
          echo "  실측: $(tr '\n' ' ' <<<"${GATE_CHECKS:-(검사 기록 없음)}")"
          echo "  GitHub 브랜치 보호가 무료 플랜에서 정지된 상태라(T-069) 이 게이트가 마지막 방어선입니다."
          echo "  검사를 통과시킨 뒤 재배포하거나, 원인 파악 후 비상시에만 SKIP_CI_GATE=1 로 우회하세요."
        } >&2
        exit 1
      fi
      echo "[deploy] CI 게이트 통과: ${GATE_SHA:0:8} ← PR #$GATE_PR_NUM ($(tr '\n' ' ' <<<"$GATE_CHECKS"))"
    done
  fi
fi

git checkout "$TRACK_BRANCH"
git reset --hard "origin/$TRACK_BRANCH"
AFTER="$(git rev-parse HEAD)"

echo "[deploy] ${MARKER_SHA:-(마커 없음)} → $AFTER"
npm install --no-audit --no-fund

# ── P0 안전장치 ⑥: `.env` 필수 항목 공란 점검 (T-067) ──────────────────────────
# 컷오버 때 구 플랫폼이 sensitive 값을 빈 문자열로 내려줘 "이름은 있는데 값이 없는"
# 줄이 여럿 남았고, 그중 하나(`INGEST_TOKEN`)가 카카오 인제스트 분단 사고의 두 번째
# 원인이었다 — fail-closed 라 수집이 전량 401 인데 러너가 레포 밖이라 **CRM 쪽에는
# 신호가 하나도 남지 않았다.** 처분 선언은 `scripts/selfhost-env-contract.ts`.
#
# ⚠️ **번호가 ⑥ 인 것은 순서가 아니라 등재 차례다** — 이 파일의 ⓪~⑤ 는 이미 임자가 있고,
# 특히 ③ 은 아래 HTTP 헬스체크가 쓰고 있다(초판이 ③ 을 중복으로 붙였다가 교차 검증에서
# 잡혔다). 이 레포는 가드를 번호로 상호 참조하므로 중복은 곧 「어느 ③ 인가」가 된다.
# ⚠️ **왜 위쪽 가드 ⓪·①·② 와 나란히 두지 않고 여기 두는가:** 이 점검기는 `tsx` 로
# 도는 TypeScript 라 `npm install` 이 끝나야 실행할 수 있다. 그래도 `npm run build`
# 와 `launchctl kickstart` 보다는 **앞**이라, 걸리면 서비스는 구버전을 계속 서빙한 채
# 배포만 멈춘다(fail-safe 방향은 위 가드들과 같다).
# ⛔ 이 점검을 크론으로 옮기지 말 것 — 런타임에 `process.env` 를 덮어쓰는 경로가 있어
#    돌고 있는 프로세스를 보면 파일이 비어 있어도 초록이 나온다(거짓 성공).
if ! npx --no-install tsx scripts/check-selfhost-env.ts infra/selfhost/.env; then
  echo "중단: infra/selfhost/.env 의 필수 항목이 비어 있습니다(위 [env:selfhost] 줄 참고). 배포를 실행하지 않습니다." >&2
  exit 1
fi

BUILD_STANDALONE=1 npm run build

# standalone 산출물은 server.js 옆에 .next/static 과 public 이 있기를 기대한다.
rm -rf .next/standalone/public .next/standalone/.next/static
cp -R public .next/standalone/public
mkdir -p .next/standalone/.next
cp -R .next/static .next/standalone/.next/static

# ── P0 안전장치 ③: HTTP 헬스체크만으로는 "새 프로세스가 떴다"를
# 증명하지 못한다 — kickstart 가 조용히 실패하면 구 프로세스가 계속
# 3000 번을 물고 있어서 헬스체크는 통과해버린다. PID 가 실제로 바뀌었는지
# 함께 확인한다(PID 교체 = 재시작됨, HTTP 200 = 정상 기동됨 — 둘 다 필요).
get_app_pid() {
  launchctl list "$APP_LAUNCHD_LABEL" 2>/dev/null \
    | awk -F'= ' '/"PID"/ { gsub(/[; ]/, "", $2); print $2 }'
}
PID_BEFORE="$(get_app_pid || true)"

if ! launchctl kickstart -k "gui/$(id -u)/$APP_LAUNCHD_LABEL"; then
  echo "중단: launchctl kickstart 명령이 실패했습니다." >&2
  exit 1
fi

echo "[deploy] PID 교체 확인 중 (이전: ${PID_BEFORE:-없음})"
PID_AFTER=""
for _ in $(seq 1 10); do
  sleep 1
  PID_AFTER="$(get_app_pid || true)"
  if [ -n "$PID_AFTER" ] && [ "$PID_AFTER" != "$PID_BEFORE" ]; then
    break
  fi
done
if [ -z "$PID_AFTER" ] || [ "$PID_AFTER" = "$PID_BEFORE" ]; then
  echo "중단: launchctl kickstart 이후 PID 가 바뀌지 않았습니다(이전 PID: ${PID_BEFORE:-없음}) — 구 프로세스가 계속 응답 중일 수 있습니다. ~/selfhost/logs/app.err.log 확인" >&2
  exit 1
fi
echo "[deploy] PID 교체 확인: ${PID_BEFORE:-없음} → $PID_AFTER"

echo "[deploy] 헬스체크"
HEALTH_OK=0
for _ in $(seq 1 30); do
  # 이 curl 이 증명하는 것은 딱 하나 — "앱 프로세스가 HTTP 요청에 응답한다"뿐이다.
  # `/` 는 미인증 요청을 `/login` 으로 리다이렉트하고 그 화면은 DB 접근 없이
  # 렌더링되므로, DB 가 완전히 죽어 있어도 이 curl 은 200 을 반환한다(아래
  # P0 안전장치 ④ 참고 — 리허설에서 Supabase 컨테이너 0개인 상태로 실측).
  if curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$APP_PORT/"; then
    HEALTH_OK=1
    break
  fi
  sleep 5
done
if [ "$HEALTH_OK" != "1" ]; then
  echo "[deploy] FAIL — 헬스체크 30회 실패. ~/selfhost/logs/app.err.log 확인" >&2
  exit 1
fi

# ── P0 안전장치 ④: DB 연결 확인. 위 HTTP 헬스체크와 이 프로브는 서로 다른
# 것을 증명한다 — 혼동하지 말 것:
#   - HTTP 200 (위)  → 앱 프로세스가 요청을 서빙 중이다.
#   - PID 교체 (위)  → 방금 올라온 게 새 빌드다.
#   - 이 DB 프로브   → 앱의 DATABASE_URL 로 실제 DB 에 도달 가능하다.
# 새 공용 헬스 엔드포인트는 일부러 추가하지 않았다 — 인터넷에 노출된 CRM에
# 인증 없는 DB 프로브 경로를 새로 여는 비용이 배포 편의보다 크다고 판단했다
# (기존 미인증 경로 `/login`·`/coupang-partners`·`/auth/*` 는 전부 DB 없이
# 렌더링되고, `/api/cron/*` 는 시크릿 필요 + 실부수효과가 있어 프로브로 쓸 수
# 없다). 대신 이 스크립트가 직접 별도 node 프로세스를 띄워 Prisma 로
# `SELECT 1` 을 실행한다 — 이 프로브는 **완전히 별도의 프로세스/커넥션**이므로
# "이 DATABASE_URL 로 지금 DB 에 붙을 수 있다"까지만 증명하고, "방금
# kickstart 로 재시작된 앱 프로세스 자신이 지금 활성 DB 커넥션을 물고
# 있다"는 것은 증명하지 못한다(그건 앱 프로세스 내부 커넥션 풀의 문제이고
# 이 스크립트가 볼 수 있는 범위 밖이다). 애플리케이션 테이블 이름은 절대
# 조회하지 않는다 — 스키마와 무관한 `SELECT 1` 뿐이다.
echo "[deploy] DB 연결 확인"
if ! DATABASE_URL="$DATABASE_URL" node -e '
(async () => {
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    process.exitCode = 0;
  } catch (e) {
    console.error(String((e && e.message) || e));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
'; then
  echo "중단: DB 연결 확인 실패 — 앱의 DATABASE_URL 로 SELECT 1 을 실행하지 못했습니다. HTTP 헬스체크는 통과했지만(앱 프로세스는 응답 중) DB 가 죽어 있으면 로그인 이후 모든 화면이 깨집니다. Supabase 컨테이너 상태를 먼저 확인하세요(docker ps)." >&2
  exit 1
fi

mkdir -p "$MARKER_DIR"
printf '%s\n' "$AFTER" > "$MARKER_FILE"
echo "[deploy] OK $AFTER"
exit 0
