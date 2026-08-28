#!/usr/bin/env bash
set -euo pipefail

# 메뉴바 릴리스 섹션의 판정 SSOT — 읽기 전용. 로컬 git 상태를 바꾸지 않는다
# (fetch·reset 금지 — 배포 스크립트의 fetch 와 경합하지 않기 위해서다).
# 화면 문구(detail·checkText·note)는 운영자 언어로 **여기서 완성**한다 —
# 앱(Swift)은 파싱·표시만 한다.
#
#   release-status.sh                          # JSON 한 줄 출력
#   release-status.sh --deployed-since <sha>   # + 「배포 완료」 판정(개정 5)
#
# 설계 정본: docs/private/specs/2026-08-14-menubar-release-section-design.md
#            docs/private/specs/2026-08-14-menubar-server-control-design.md 개정 5
# 계약 테스트: scripts/__tests__/menubar-release.test.ts

# 앱(launchd)이 주는 PATH 는 /usr/bin:/bin:/usr/sbin:/sbin 뿐이라 gh 가 안 보인다(실측).
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"

GH="${RELEASE_GH_CMD:-gh}"
REPO="indexzigu/wagcrm"
MARKER_FILE="$HOME/selfhost/logs/deployed.sha"
MAX_COMMITS=5
# 알림 본문에 싣는 최대 건수 — 나머지는 「외 N건」으로 접는다. 목록 표시용
# MAX_COMMITS 와 다른 숫자인 것은 의도다: 저쪽은 패널의 세로 공간, 이쪽은
# macOS 알림 본문이 잘리기 전까지의 폭이 상한을 정한다.
DEPLOY_BODY_MAX=3

# ── 인자 ─────────────────────────────────────────────────────
# --deployed-since <sha> = 앱이 **직전에 관측한** 배포 마커. 지금 마커와 다르면
# 그 사이 구간을 조회해 「무엇이 방금 올라갔나」를 문구까지 완성해 돌려준다.
# ⛔ 이 판정을 앱으로 올리지 말 것 — 앱은 계약상 gh 를 직접 부를 수 없고
#    (menubar-app-delegation.test.ts), PR 번호 파싱 규약은 이 파일이 소유한다.
# ⚠️ 오타는 조용히 무시하지 않는다(exit 1). 무시하면 앱이 플래그를 넘겼다고 믿는
#    동안 배포 알림이 영원히 안 나가고, 그 침묵은 「배포가 없었다」와 구분되지 않는다.
DEPLOYED_SINCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --deployed-since)
      if [ -z "${2:-}" ]; then
        echo "중단: --deployed-since 에 sha 가 필요합니다" >&2
        exit 1
      fi
      DEPLOYED_SINCE="$2"
      shift 2
      ;;
    *)
      echo "중단: 알 수 없는 인자 '$1' — 사용법: release-status.sh [--deployed-since <sha>]" >&2
      exit 1
      ;;
  esac
done

json_str() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

# gh 실패 사유를 3버킷으로 접는다 — 원시 stderr 를 상시 표시 행에 흘리지 않는다.
fail_reason() { # $1 = stderr 전문
  case "$1" in
    *"auth login"*|*"authentication"*|*"HTTP 401"*) printf '확인 불가 — GitHub 로그인이 필요합니다' ;;
    *) printf '확인 불가 — GitHub 조회에 실패했습니다' ;;
  esac
}

# 🪤 템플릿을 명시한다 — `mktemp -t <접두사>` 는 BSD(macOS) 전용이고 GNU
# coreutils(CI ubuntu)에서는 `too few X's in template` 로 즉사한다.
ERR_FILE="$(mktemp "/tmp/release-status.XXXXXX")"
trap 'rm -f "$ERR_FILE"' EXIT

# ── 배포 대기 ────────────────────────────────────────────────
DEPLOY_LEVEL="unknown"
DEPLOY_DETAIL="확인 불가 — 배포 기록을 찾지 못했습니다"
DEPLOY_COUNT=0
DEPLOY_CAN="false"
DEPLOY_NOTE=""
DEPLOY_COMMITS=""
DEPLOY_MORE=0

MARKER_SHA="$(cat "$MARKER_FILE" 2>/dev/null || true)"
if [ -n "$MARKER_SHA" ]; then
  # 커밋 목록과 변경 파일 목록이 같은 응답에 있다 — 호출 1회로 둘 다 얻는다.
  if COMPARE_OUT="$($GH api "repos/$REPO/compare/$MARKER_SHA...main" \
      --jq '"COUNT\t\(.total_commits)",
            (.commits | reverse | .[] | "COMMIT\t\(.sha[0:7])\t\(.commit.message | split("\n")[0])"),
            (.files // [] | .[] | "FILE\t\(.filename)")' 2>"$ERR_FILE")"; then
    SHOWN=0
    while IFS="$(printf '\t')" read -r kind a b; do
      case "$kind" in
        COUNT) DEPLOY_COUNT="${a:-0}" ;;
        COMMIT)
          if [ "$SHOWN" -lt "$MAX_COMMITS" ]; then
            DEPLOY_COMMITS="${DEPLOY_COMMITS:+$DEPLOY_COMMITS,}{\"sha\":\"$(json_str "$a")\",\"title\":\"$(json_str "$b")\"}"
            SHOWN=$((SHOWN + 1))
          fi ;;
        FILE)
          case "$a" in
            ygrd-link/*) case "$DEPLOY_NOTE" in *링크*) ;; *) DEPLOY_NOTE="${DEPLOY_NOTE:+$DEPLOY_NOTE · }링크 서버(go.ygrd.kr) 변경 포함" ;; esac ;;
            prisma/migrations/*) case "$DEPLOY_NOTE" in *데이터베이스*) ;; *) DEPLOY_NOTE="${DEPLOY_NOTE:+$DEPLOY_NOTE · }데이터베이스 구조 변경 포함" ;; esac ;;
          esac ;;
      esac
    done <<EOF
$COMPARE_OUT
EOF
    case "$DEPLOY_COUNT" in ''|*[!0-9]*) DEPLOY_COUNT=0 ;; esac
    [ "$DEPLOY_COUNT" -gt "$SHOWN" ] && DEPLOY_MORE=$((DEPLOY_COUNT - SHOWN))
    if [ "$DEPLOY_COUNT" -eq 0 ]; then
      DEPLOY_LEVEL="ok"; DEPLOY_DETAIL="서버가 최신입니다"; DEPLOY_NOTE=""
    else
      DEPLOY_LEVEL="info"; DEPLOY_DETAIL="서버에 아직 안 올라간 변경 ${DEPLOY_COUNT}건"; DEPLOY_CAN="true"
    fi
  else
    DEPLOY_DETAIL="$(fail_reason "$(cat "$ERR_FILE" 2>/dev/null || true)")"
  fi
fi

# ── 최근 반영(배포 기록) ─────────────────────────────────────
# "지금 서버에 실려 있는 것"의 최신 커밋 5건 — 마커 sha 에서 거슬러 올라간
# 목록이다. 배포 이벤트 단위 이력이 아니라 코드 단위다: 오너의 질문("어떤 PR 이
# 배포돼 있나")에는 이쪽이 답하고, 별도 이벤트 로그를 새로 만들지 않는다.
# 이 레포의 main 커밋은 squash 머지라 1커밋 ≈ 1PR 이고 제목이 `#NN ` 로 시작한다
# (P6 제목 규약) — 그 번호로 PR 페이지 URL 을 만든다. 규약을 벗어난 제목은
# 커밋 페이지로 보낸다(추측하지 않는다).
RECENT_DETAIL=""
RECENT_ITEMS=""

# 커밋 한 건의 이동 주소. `#NN ` 제목은 PR 페이지로, 규약을 벗어난 제목은 커밋
# 페이지로 보낸다(추측하지 않는다).
# ⛔ 이 파생을 호출부에서 다시 쓰지 말 것 — 「최근 반영」과 「배포 완료」가 각자
#    손으로 만들면 같은 커밋이 두 표면에서 다른 곳으로 간다(이 레포의 반복 결함).
# 알림 본문에 쓸 짧은 제목. squash 커밋 제목은 앞에 `#NN `(P6 규약)이 있고 뒤에
# GitHub 이 붙인 `(#NN)`이 또 있어 **같은 번호가 한 줄에 두 번** 나온다. 알림 본문은
# 폭이 좁으므로 뒤쪽 중복만 걷어낸다.
# ⚠️ `items[].title` 은 손대지 않는다 — 그쪽은 「최근 반영」과 같은 원문이어야 한다.
body_label() { # $1=제목
  printf '%s' "$1" | sed -e 's/ (#[0-9][0-9]*)$//'
}

item_url() { # $1=sha $2=제목
  local pr_num
  pr_num="$(printf '%s' "$2" | sed -n 's/^#\([0-9][0-9]*\) .*/\1/p')"
  if [ -n "$pr_num" ]; then
    printf 'https://github.com/%s/pull/%s' "$REPO" "$pr_num"
  else
    printf 'https://github.com/%s/commit/%s' "$REPO" "$1"
  fi
}

# 마커 mtime = deploy.sh 가 마지막으로 헬스체크까지 성공한 시각("변경 없음" 회차는
# 마커를 다시 쓰지 않는다). BSD/GNU date 플래그가 갈리므로 perl 로 통일한다
# (status.sh stamp_epoch 와 같은 계열).
marker_stamp() {
  perl -e 'my @t = localtime((stat($ARGV[0]))[9]);
    printf "%02d/%02d %02d:%02d", $t[4] + 1, $t[3], $t[2], $t[1];' "$MARKER_FILE" 2>/dev/null || true
}

if [ -n "$MARKER_SHA" ]; then
  if RECENT_OUT="$($GH api "repos/$REPO/commits?sha=$MARKER_SHA&per_page=$MAX_COMMITS" \
      --jq '.[] | "RECENT\t\(.sha[0:7])\t\(.commit.message | split("\n")[0])"' 2>"$ERR_FILE")"; then
    while IFS="$(printf '\t')" read -r kind sha title; do
      [ "$kind" = "RECENT" ] || continue
      [ -n "$sha" ] || continue
      url="$(item_url "$sha" "$title")"
      RECENT_ITEMS="${RECENT_ITEMS:+$RECENT_ITEMS,}{\"sha\":\"$(json_str "$sha")\",\"title\":\"$(json_str "$title")\",\"url\":\"$(json_str "$url")\"}"
    done <<EOF
$RECENT_OUT
EOF
    STAMP="$(marker_stamp)"
    [ -n "$STAMP" ] && RECENT_DETAIL="마지막 배포 $STAMP"
  else
    RECENT_DETAIL="$(fail_reason "$(cat "$ERR_FILE" 2>/dev/null || true)")"
  fi
fi

# ── 배포 완료 판정 (개정 5) ──────────────────────────────────
# 마커가 움직였다 = deploy.sh 가 빌드·PID 교체·헬스체크·DB 프로브를 전부 통과했다.
# 그래서 이 블록이 채워지는 것은 "배포가 실제로 끝났다"와 같은 뜻이다.
# ⚠️ 반대로 **실패는 여기서 볼 수 없다** — deploy.sh 는 성공했을 때만 마커를 쓰므로
#    실패는 "마커가 안 움직임"으로만 보여 미배포와 구분되지 않는다. 실패 통지는
#    종료코드를 직접 쥐는 앱의 배포 버튼 경로가 담당한다(설계서 개정 5의 한계 절).
DEPLOYED_JSON="null"
if [ -n "$MARKER_SHA" ] && [ -n "$DEPLOYED_SINCE" ] && [ "$DEPLOYED_SINCE" != "$MARKER_SHA" ]; then
  D_COUNT=0
  D_SHOWN=0
  D_ITEM_N=0
  D_ITEMS=""
  D_BODY=""
  D_TITLE="배포 완료"
  if D_OUT="$($GH api "repos/$REPO/compare/$DEPLOYED_SINCE...$MARKER_SHA" \
      --jq '"COUNT\t\(.total_commits)",
            (.commits | reverse | .[] | "COMMIT\t\(.sha[0:7])\t\(.commit.message | split("\n")[0])")' 2>"$ERR_FILE")"; then
    while IFS="$(printf '\t')" read -r kind sha title; do
      case "$kind" in
        # COUNT 줄은 2번째 필드가 **개수**다 — 자리를 재사용하므로 변수 이름(sha)이
        # 이 분기에서만 뜻이 다르다(위 대기 목록 루프의 기존 관례를 따른다).
        COUNT) D_COUNT="${sha:-0}" ;;
        COMMIT)
          [ -n "$sha" ] || continue
          # items 는 MAX_COMMITS 까지만 싣는다 — compare 는 최대 250건을 돌려주는데
          # 그대로 실으면 JSON 한 줄이 비대해진다. **총계는 count 가 들고 있다.**
          # ⚠️ 카운터가 D_SHOWN 과 별개인 것은 의도다 — 그쪽 상한(본문 3건)이 더
          # 낮아서 공유하면 items 가 3건에서 멈춘다.
          if [ "$D_ITEM_N" -lt "$MAX_COMMITS" ]; then
            url="$(item_url "$sha" "$title")"
            D_ITEMS="${D_ITEMS:+$D_ITEMS,}{\"sha\":\"$(json_str "$sha")\",\"title\":\"$(json_str "$title")\",\"url\":\"$(json_str "$url")\"}"
            D_ITEM_N=$((D_ITEM_N + 1))
          fi
          if [ "$D_SHOWN" -lt "$DEPLOY_BODY_MAX" ]; then
            D_BODY="${D_BODY:+$D_BODY · }$(body_label "$title")"
            D_SHOWN=$((D_SHOWN + 1))
          fi ;;
      esac
    done <<EOF
$D_OUT
EOF
    case "$D_COUNT" in ''|*[!0-9]*) D_COUNT=0 ;; esac
    if [ "$D_COUNT" -eq 0 ]; then
      # 마커는 움직였는데 사이 커밋이 0건 = 앞으로 간 것이 아니다(되돌림·재지정).
      # ⛔ 「올라갔다」고 말하지 말 것 — 오너가 방금 배포한 내용이 실렸다고 읽는다.
      D_BODY="이전 버전으로 되돌렸습니다 (${MARKER_SHA:0:7})"
    else
      # ⚠️ **건수를 맨 앞에 둔다.** macOS 알림 본문은 두 줄쯤에서 잘리는데, 뒤에
      #    「외 N건」으로 붙이면 그게 먼저 사라져 총 건수를 잃는다(제목 하나만 보이는
      #    상태에서 "몇 건이 나갔나"를 못 읽는다). 앞에 두면 잘려도 살아남는다.
      D_BODY="${D_COUNT}건 — $D_BODY"
    fi
  else
    # 목록을 못 읽은 것과 배포가 없었던 것은 **다른 사실이다.** 마커가 움직인 이상
    # 배포는 확실히 일어났으므로 침묵하지 않고, 내용 불명을 본문에 적는다.
    # count = -1 은 「세지 못했다」로 0(되돌림)과 구분한다.
    D_COUNT=-1
    D_ITEMS=""
    D_BODY="무엇이 올라갔는지는 확인하지 못했습니다 — 메뉴바 패널의 「최근 반영」을 열어 보세요"
  fi
  DEPLOYED_JSON="{\"from\":\"$(json_str "$DEPLOYED_SINCE")\",\"to\":\"$(json_str "$MARKER_SHA")\",\"count\":$D_COUNT,\"title\":\"$(json_str "$D_TITLE")\",\"body\":\"$(json_str "$D_BODY")\",\"items\":[$D_ITEMS]}"
fi

# ── 열린 PR ──────────────────────────────────────────────────
PR_LEVEL="unknown"
PR_DETAIL="확인 불가"
PR_ITEMS=""
PR_COUNT=0

# 체크 상태 접기 — 판정은 스크립트가 소유한다(앱은 문자열만 받는다).
fold_checks() { # $1 = conclusion/state 를 콤마로 이은 값
  case ",$1," in
    ,,) printf 'none'; return ;;
  esac
  case ",$1," in
    *,FAILURE,*|*,ERROR,*|*,TIMED_OUT,*|*,CANCELLED,*|*,ACTION_REQUIRED,*|*,STARTUP_FAILURE,*)
      printf 'fail'; return ;;
  esac
  case ",$1," in
    *,PENDING,*|*,IN_PROGRESS,*|*,QUEUED,*|*,WAITING,*|*,EXPECTED,*|*,REQUESTED,*)
      printf 'pending'; return ;;
  esac
  printf 'pass'
}

# 🪤 **`.conclusion // .state // .status` 로 쓰지 말 것 (실사고 2026-08-27, 오너 신고).**
# gh 는 아직 도는 체크의 `conclusion` 을 **빈 문자열**로 준다(null 이 아니다 — 실측:
# `status=IN_PROGRESS conclusion= state=null`). jq 의 `//` 는 **null·false 에서만**
# 오른쪽으로 넘어가므로 그 빈 문자열이 그대로 채택되고, 「도는 중」이라는 사실이
# fold_checks 에 닿기 전에 지워진다. 남는 것은 이미 끝난 체크의 SUCCESS 뿐이라
# **아직 도는 PR 이 「체크 통과」로 초록불이 된다**(실측 입력 `,SUCCESS,`).
# 그래서 세 필드 중 **비어 있지 않은 첫 값**을 고른다.
if PR_OUT="$($GH pr list --repo "$REPO" --state open --limit 20 \
    --json number,title,url,isDraft,statusCheckRollup \
    --jq '.[] | [ .number, .url, (.isDraft | tostring),
                  ([ .statusCheckRollup[]?
                     | [.conclusion, .state, .status]
                     | map(select(. != null and . != ""))
                     | first // "" ] | join(",")),
                  .title ] | @tsv' 2>"$ERR_FILE")"; then
  # bash 의 IFS=탭 read 는 연속 탭(=빈 필드)을 하나로 뭉갠다(체크 없는 PR 의 checks
  # 필드가 중간에서 비어 있으면 뒤 필드가 밀린다 — 실측 확인). cut 은 뭉개지 않는다.
  while IFS= read -r pr_line; do
    [ -z "$pr_line" ] && continue
    num="$(printf '%s' "$pr_line" | cut -f1)"
    url="$(printf '%s' "$pr_line" | cut -f2)"
    draft="$(printf '%s' "$pr_line" | cut -f3)"
    checks="$(printf '%s' "$pr_line" | cut -f4)"
    title="$(printf '%s' "$pr_line" | cut -f5)"
    [ -z "${num:-}" ] && continue
    case "$(fold_checks "$checks")" in
      pass)    lvl="ok";      txt="체크 통과" ;;
      fail)    lvl="error";   txt="체크 실패" ;;
      pending) lvl="warn";    txt="확인 중" ;;
      *)       lvl="unknown"; txt="체크 없음" ;;
    esac
    badge=""
    [ "$draft" = "true" ] && badge="초안"
    PR_ITEMS="${PR_ITEMS:+$PR_ITEMS,}{\"number\":$num,\"title\":\"$(json_str "$title")\",\"url\":\"$(json_str "$url")\",\"checkLevel\":\"$lvl\",\"checkText\":\"$txt\",\"badge\":\"$badge\"}"
    PR_COUNT=$((PR_COUNT + 1))
  done <<EOF
$PR_OUT
EOF
  if [ "$PR_COUNT" -eq 0 ]; then
    PR_LEVEL="ok"; PR_DETAIL="열린 PR 이 없습니다"
  else
    PR_LEVEL="info"; PR_DETAIL="머지 대기 ${PR_COUNT}건"
  fi
else
  PR_DETAIL="$(fail_reason "$(cat "$ERR_FILE" 2>/dev/null || true)")"
fi

# markerSha = 지금 서버에 실린 커밋(마커 전문). 앱이 다음 호출에 그대로
# --deployed-since 로 되돌려 주는 값이라 **짧게 자르지 않는다**.
if [ -n "$MARKER_SHA" ]; then
  MARKER_JSON="\"$(json_str "$MARKER_SHA")\""
else
  MARKER_JSON="null"
fi

printf '{"schemaVersion":1,"generatedAt":"%s","markerSha":%s,"deployed":%s,"deploy":{"level":"%s","title":"서버 반영","detail":"%s","count":%s,"canDeploy":%s,"note":"%s","commits":[%s],"more":%s},"recent":{"title":"최근 반영","detail":"%s","items":[%s]},"prs":{"level":"%s","title":"열린 PR","detail":"%s","items":[%s]}}\n' \
  "$(date +%Y-%m-%dT%H:%M:%S%z)" \
  "$MARKER_JSON" "$DEPLOYED_JSON" \
  "$DEPLOY_LEVEL" "$(json_str "$DEPLOY_DETAIL")" "$DEPLOY_COUNT" "$DEPLOY_CAN" "$(json_str "$DEPLOY_NOTE")" "$DEPLOY_COMMITS" "$DEPLOY_MORE" \
  "$(json_str "$RECENT_DETAIL")" "$RECENT_ITEMS" \
  "$PR_LEVEL" "$(json_str "$PR_DETAIL")" "$PR_ITEMS"
