#!/usr/bin/env bash
set -euo pipefail

# 프리뷰 인스턴스 온디맨드 제어 — 오너가 직접 실행하는 유일한 진입점.
# 설계 정본: docs/private/specs/2026-08-13-preview-on-demand-design.md
#
#   preview.sh up [<브랜치>]   # 열기. 브랜치 생략 시 main. 매번 DB 를 최신 백업으로 재구축.
#   preview.sh down            # 닫기. 앱 서비스 + plist + DB 컨테이너 + 빌드 산출물까지
#                              # 전부 정리(멱등). 닫으면 프로덕션 사본에서 나온 것은
#                              # 디스크에 아무것도 남지 않는다.
#   preview.sh status          # 현재 상태.
#
# 상태 SSOT 는 ~/Library/LaunchAgents/ 의 plist 존재 여부다 — 파일이 남아 있으면
# launchd 가 로그인 시 다시 로드해 재부팅이 프리뷰를 되살린다. down 이 반드시 지운다.
#
# ⚠️ 이 스크립트는 프로덕션과 같은 docker 데몬·launchd 도메인을 조작한다. 프로덕션
# 라벨·컨테이너 이름은 이 파일에 아예 등장하지 않는다(계약:
# scripts/__tests__/preview-control.test.ts — 파괴적 줄 스캔 + 리터럴 부재).

PREVIEW_LABEL="kr.ygrd.wagcrm.preview"
PREVIEW_CONTAINER="wagcrm-preview-db"
PREVIEW_CHECKOUT="$HOME/selfhost/wagcrm-preview"
PLIST_NAME="kr.ygrd.wagcrm.preview.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME"
PREVIEW_PORT=3001
# deploy.sh 가 쓰는 배포 완료 마커. 그쪽의 유도 규칙(마커 디렉터리는 체크아웃의
# 부모 + 파일명은 라벨 끝단에서 파생)을 그대로 재현한다 — 경로를 손으로 박아두면
# deploy.sh 가 규칙을 바꿀 때 여기만 조용히 낡는다.
PREVIEW_MARKER="$(dirname "$PREVIEW_CHECKOUT")/logs/deployed.${PREVIEW_LABEL##*.}.sha"

# launchd/cron 계열 스크립트와 같은 PATH 방어(이 레포에서 4회 재발) — 사람이
# 터미널에서 부르는 스크립트지만, psql(keg-only libpq)을 쓰는 preview-db.sh 를
# 자식으로 부르므로 같은 후보를 물려준다.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/local/opt/libpq/bin:/opt/homebrew/opt/libpq/bin:$PATH"

log() { printf '[preview] %s\n' "$*"; }
abort() { printf '[preview] 중단: %s\n' "$*" >&2; exit 1; }

# 실체 대조 — `pwd -P` 로 물리 경로를 풀어 기대 경로와 비교한다. 이 함수만 단독으로
# 놓고 보면 체크아웃 자체가 심링크인 경우도 여기서 걸린다(링크를 따라간 실체가
# 기대 경로와 달라지므로). 하지만 실제 호출부는 이 함수를 부르기 **전에**
# `[ -L "$PREVIEW_CHECKOUT" ]` 로 그 경우를 이미 배제한다 — 그 전제 위에서 이 함수가
# 실제로 거부할 수 있는 유일한 경우는 **대상이 존재하지만 디렉터리가 아닌 경우**
# (`cd` 자체가 실패)뿐이다. 부모 경로 **중간**에 심링크가 있어도 실제 경로와 기대
# 경로가 **함께** 풀려 나오므로 이 비교는 통과한다 — 그 방어는 이 함수의 역할이
# 아니라 위 `-L` 검사의 역할이다. 그래도 남겨두는 것은 `-L` 검사가 미래에 없어지거나
# 순서가 바뀌어도 살아있는 이중 방어(defence-in-depth)이기 때문이다.
checkout_is_physically_expected() {
  local target="$1" actual expected_parent
  actual="$(cd "$target" 2>/dev/null && pwd -P)" || return 1
  expected_parent="$(cd "$(dirname "$target")" 2>/dev/null && pwd -P)" || return 1
  [ -n "$actual" ] && [ "$actual" = "$expected_parent/$(basename "$target")" ]
}

# 이름 가드 — 변수가 오염돼도 파괴적 명령이 엉뚱한 대상을 잡지 않게 한다.
case "$PREVIEW_LABEL" in
  kr.ygrd.wagcrm.preview) ;;
  *) abort "프리뷰 라벨이 비정상입니다($PREVIEW_LABEL) — 안전을 위해 중단합니다." ;;
esac
case "$PREVIEW_CONTAINER" in
  wagcrm-preview-db) ;;
  *) abort "프리뷰 컨테이너 이름이 비정상입니다($PREVIEW_CONTAINER) — 안전을 위해 중단합니다." ;;
esac

# 체크아웃 경로 가드 — cmd_down 이 이 경로 **아래를 재귀 삭제**한다(.next).
#
# ⚠️ **이것은 트립와이어이지 런타임 방어가 아니다.** 지금 소스에서 이 비교는 두 줄 위
# 대입식과 같은 문자열을 다시 보는 것이라 항상 참이다(env 오버라이드 경로가 없다).
# 값이 하는 일은 **미래의 편집을 잡는 것**뿐이다 — 누가 PREVIEW_CHECKOUT 의 정의를
# 바꾸거나 오버라이드를 열면 여기서 멈춘다.
# 실제 런타임 방어는 cmd_down 의 삭제 직전 검사다(심링크 거부 + 물리 경로 대조 +
# git 체크아웃 확인). **문자열이 같아도 그 경로의 실체는 다를 수 있기 때문이다.**
#
# ⚠️ **부분일치로 쓰면 안 된다.** 프로덕션 체크아웃 "$HOME/selfhost/wagcrm" 은 프리뷰
# 체크아웃 "$HOME/selfhost/wagcrm-preview" 의 **접두사**다. 그래서 눈에 먼저 들어오는
# 두 가지 검사가 **둘 다 틀린다**:
#   - `case "$PREVIEW_CHECKOUT" in *wagcrm*)` — 프로덕션 경로도 통과한다(위음성:
#     막아야 할 것을 통과시킨다).
#   - "프로덕션 경로 문자열을 포함하면 거부" 로 뒤집기 — 정당한 프리뷰 경로가 그
#     문자열을 접두사로 품고 있으므로 항상 거부된다(위양성: 기능이 아예 안 돈다).
# 접두사 관계인 두 이름은 부분일치로 가를 수 없다. 정확 일치만이 답이다.
[ -n "${HOME:-}" ] || abort "HOME 이 비어 있습니다 — 삭제 대상 경로를 유도할 수 없어 중단합니다."
case "$PREVIEW_CHECKOUT" in
  "$HOME/selfhost/wagcrm-preview") ;;
  *) abort "프리뷰 체크아웃 경로가 예상과 다릅니다($PREVIEW_CHECKOUT) — 재귀 삭제가 걸린 경로라 안전을 위해 중단합니다." ;;
esac

# 마커 경로 가드 — 위 유도(deploy.sh 규칙 재현)가 낡거나 라벨이 바뀌면 이 경로가
# **프로덕션 마커**(deployed.sha)로 미끄러질 수 있고, cmd_down 은 이 파일을 지운다.
# 유도 자체는 그대로 둔다(규칙 변경을 따라가야 하므로) — 대신 결과가 프리뷰 마커인지
# 정확 일치로 확인해서, 규칙이 바뀌면 조용히 낡는 대신 시끄럽게 멈추게 한다.
case "$PREVIEW_MARKER" in
  "$HOME/selfhost/logs/deployed.preview.sha") ;;
  *) abort "프리뷰 배포 마커 경로가 예상과 다릅니다($PREVIEW_MARKER) — deploy.sh 의 마커 유도 규칙이 바뀌었는지 확인하세요. 다른 레인의 마커를 지울 위험이 있어 중단합니다." ;;
esac

cmd_up() {
  local branch="${1:-main}"

  [ -d "$PREVIEW_CHECKOUT/.git" ] || abort "프리뷰 체크아웃이 없습니다: $PREVIEW_CHECKOUT (infra/selfhost/README.md 프리뷰 절 참고)"
  local missing=""
  for bin in git docker curl; do
    command -v "$bin" >/dev/null 2>&1 || missing="${missing:+$missing }$bin"
  done
  [ -z "$missing" ] || abort "필수 실행파일을 PATH 에서 찾지 못함: $missing (PATH=$PATH)"

  # 브랜치 존재는 DB 를 건드리기 **전에** 확인한다 — 오타로 DB 만 갈아엎는 것을 막는다.
  git -C "$PREVIEW_CHECKOUT" fetch --quiet origin
  git -C "$PREVIEW_CHECKOUT" rev-parse --verify --quiet "origin/$branch" >/dev/null \
    || abort "원격에 없는 브랜치입니다: $branch"

  log "체크아웃을 $branch 로 맞춥니다"
  git -C "$PREVIEW_CHECKOUT" checkout -q -B "$branch" "origin/$branch"

  log "프리뷰 DB 를 최신 백업으로 재구축합니다"
  bash "$PREVIEW_CHECKOUT/infra/selfhost/preview-db.sh"

  # 서비스 로드. 이미 로드돼 있으면 내렸다 다시 올린다(bootstrap 은 중복 로드를 거부한다).
  launchctl bootout "gui/$(id -u)/$PREVIEW_LABEL" 2>/dev/null || true

  # bootout 은 비동기다 — launchd 가 서비스를 도메인에서 완전히 빼기 전에 반환한다.
  # 반환 직후 곧바로 bootstrap 하면 아직 빠져나가는 중인 서비스와 경합해 실패하고,
  # bootout 은 이미 적용된 뒤이므로 그 실패는 프리뷰를 죽은 채로 남긴다(편도 사고 —
  # 실측: bootout 직후 bootstrap 은 실패했지만 같은 명령을 시간차를 두고 다시 실행하니
  # 성공했다). "빠져나갔다"는 신호(launchctl list 가 서비스를 못 찾음)를 폴링해서
  # bootstrap 전에 확실히 기다린다 — 고정 sleep 으로 "단순화"하지 말 것, 기기 부하에
  # 따라 소요 시간이 달라진다.
  local unloaded=0
  for _ in $(seq 1 15); do
    launchctl list "$PREVIEW_LABEL" >/dev/null 2>&1 || { unloaded=1; break; }
    sleep 1
  done
  [ "$unloaded" = 1 ] \
    || abort "launchctl bootout 대기 실패 — $PREVIEW_LABEL 이 도메인에서 빠지지 않습니다(15초 초과). launchctl list $PREVIEW_LABEL 로 상태를 직접 확인하세요."

  cp "$PREVIEW_CHECKOUT/infra/selfhost/launchd/$PLIST_NAME" "$PLIST_DST"
  launchctl bootstrap "gui/$(id -u)" "$PLIST_DST" || abort "launchctl bootstrap 실패 — plist: $PLIST_DST"

  log "빌드·기동 (deploy.sh 재사용)"
  APP_TRACK_BRANCH="$branch" APP_PORT="$PREVIEW_PORT" APP_LAUNCHD_LABEL="$PREVIEW_LABEL" \
    bash "$PREVIEW_CHECKOUT/infra/selfhost/deploy.sh" \
    || abort "deploy.sh 실패 — 위 출력에서 실패 단계를 확인하세요. down 으로 정리할 수 있습니다."

  # 구버전 가드: 이 브랜치의 deploy.sh 가 APP_TRACK_BRANCH 를 모르면 main 으로
  # 되돌려 빌드한다 — "요청한 브랜치를 보고 있다"는 착각이 최악이므로 여기서 잡는다.
  local head want
  head="$(git -C "$PREVIEW_CHECKOUT" rev-parse HEAD)"
  want="$(git -C "$PREVIEW_CHECKOUT" rev-parse "origin/$branch")"
  [ "$head" = "$want" ] \
    || abort "체크아웃이 요청 브랜치와 다릅니다 — 이 브랜치의 deploy.sh 가 APP_TRACK_BRANCH 오버라이드 이전 버전일 수 있습니다(main 이후 브랜치만 지정 가능). down 으로 정리할 수 있습니다."

  # 기동 확인 — deploy.sh 가 "변경 없음"으로 조기 종료하면 그 안의 헬스체크가 아예
  # 돌지 않으므로, 여기서 직접 확인해야 "열렸다"고 말할 수 있다. down 이 마커를 지우게
  # 된 뒤로 그 경로는 "닫았다가 같은 커밋을 다시 여는" 경우가 아니라 **down 없이 up 을
  # 연달아 실행하는** 경우에만 남는다(그때는 이전 빌드가 그대로 있어 정상이다).
  local ok=0
  for _ in $(seq 1 30); do
    if curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$PREVIEW_PORT/"; then ok=1; break; fi
    sleep 2
  done
  [ "$ok" = 1 ] || abort "프리뷰가 :$PREVIEW_PORT 에서 응답하지 않습니다 — ~/selfhost/logs/preview.err.log 확인. down 으로 정리할 수 있습니다."

  log "열림: https://crm-test.ygrd.kr — $branch @ $(git -C "$PREVIEW_CHECKOUT" rev-parse --short HEAD)"
  log "확인이 끝나면: bash $PREVIEW_CHECKOUT/infra/selfhost/preview.sh down"
}

cmd_down() {
  # 멱등 — 이미 내려가 있어도 exit 0. 없는 것을 지우려다 실패하면 사람이 손으로
  # 정리해야 하므로, 각 단계는 "없으면 조용히 통과"다.
  #
  # ⚠️ 각 명령의 실패를 `|| true` 로 삼키는 것은 **멱등성** 때문이지 "실패해도
  # 괜찮다"는 뜻이 아니다. 종전에는 그 뒤에 성공 문구를 무조건 찍었는데, 그 조합이
  # 이 기능의 존재 이유를 통째로 무너뜨린다: docker 데몬이 죽어 있거나 rm 이
  # 거부되면 **프로덕션 사본을 담은 DB 컨테이너가 살아남은 채**로 down 은 성공을
  # 보고하고, status 는 (plist 는 지워졌으므로) down 을 보고한다 — 사람이 "닫았다"고
  # 믿는 상태와 실제 상태가 정반대인데 어디에도 신호가 없다.
  # 그래서 명령의 실행 결과가 아니라 **최종 상태**를 확인하고, 어긋나면 실패한다.
  launchctl bootout "gui/$(id -u)/$PREVIEW_LABEL" 2>/dev/null || true
  rm -f "$PLIST_DST" || true
  if command -v docker >/dev/null 2>&1; then
    docker rm -f "$PREVIEW_CONTAINER" >/dev/null 2>&1 || true
  fi

  local problems=""

  # bootout 은 비동기다(cmd_up 의 대기 주석 참고) — 도메인에서 빠질 시간을 준 뒤 판정한다.
  local unloaded=0
  for _ in $(seq 1 15); do
    launchctl list "$PREVIEW_LABEL" >/dev/null 2>&1 || { unloaded=1; break; }
    sleep 1
  done
  if [ "$unloaded" != 1 ]; then
    problems="$problems
  - launchd 서비스가 아직 도메인에 남아 있습니다($PREVIEW_LABEL) — 앱이 계속 :$PREVIEW_PORT 를 서빙 중일 수 있습니다. 확인: launchctl list $PREVIEW_LABEL"
  fi

  # ── 파일 삭제는 **언로드 확인 이후에만** 한다 ──
  # bootout 이 비동기라, 위 폴링 전에 지우면 아직 살아 있는 앱 프로세스와 경합한다.
  # 프리뷰 앱은 체크아웃 안의 .live/current/server.js 로 돌고 런타임 캐시를 그 릴리스
  # 폴더 아래에 **쓰는 중**이라, 살아 있는 동안의 재귀 삭제는 ENOTEMPTY 로 깨지기 쉽다.
  # 서비스가 도메인에서 빠진 것을 확인한 뒤에 지운다.
  # ⛔ 종전 서술 「.next/standalone/server.js 로 돌고」는 SUPERSEDED — 2026-08-29 실사고로
  #    빌드 트리(.next)와 서빙 트리(.live)를 갈랐다(deploy.sh 안전장치 ⑧).
  if [ "$unloaded" != 1 ]; then
    problems="$problems
  - 그래서 배포 마커·빌드 산출물을 **지우지 않았습니다** — 살아 있는 프로세스가 쓰는 중인 디렉터리를 지우면 중간에 깨집니다. 서비스를 먼저 내린 뒤 down 을 다시 실행하세요."
  else
    # ── 배포 마커 제거 ──
    # 이것이 down 과 up 을 정합하게 유지하는 지점이다. deploy.sh 는 마커 SHA 가 브랜치
    # 팁과 같으면 "변경 없음" 으로 조기 종료하며 **빌드를 건너뛴다.** 아래에서 .next 를
    # 지우면서 마커를 남기면, 같은 커밋으로 다시 up 할 때 빌드가 생략된 채 서비스가
    # 올라가고(산출물 없음) up 의 헬스체크가 실패한다 — 프리뷰가 열리지 않는다.
    # up 쪽에서 FORCE=1 로 우회하는 선택지도 있었지만 쓰지 않았다: 그건 "마커를
    # 무시한다"는 뜻이라 마커가 참인 국면에서도 늘 재빌드하게 되고, 무엇보다 **마커가
    # 사실이 아닌 상태를 그대로 방치한다.** 마커의 의미는 "이 SHA 의 빌드가 배포돼
    # 서빙 중이다"인데 down 이후에는 서빙 중인 것이 없다. 지우는 쪽이 상태를 사실로
    # 되돌리는 것이고, status 의 "서빙 중인 빌드" 표시도 그래야 정확해진다.
    # 마커의 원래 목적("빌드 실패를 배포 완료로 기록하지 않는다")은 그대로다 — 여기서
    # 지우는 것은 프리뷰 레인 마커뿐이고(위 마커 경로 정확 일치 가드가 강제), 프로덕션
    # 마커(deployed.sha)는 파일명이 달라 이 삭제와 무관하다.
    # ⚠️ 아래 체크아웃 블록과 **묶지 말 것.** 마커는 체크아웃 밖(~/selfhost/logs)에 있어
    # 체크아웃이 사라져도 남는다 — 묶어두면 그 상황에서 마커만 살아남아 down 이 멱등성을
    # 잃는다(스텁 하네스 실측으로 잡은 실제 결함).
    # `|| true` 는 이 함수의 계약이다(위 ⚠️ 참고) — 실패해도 **아래 최종 상태 확인까지
    # 도달해야** 무엇이 남았는지 사람에게 말해줄 수 있다. set -e 로 여기서 죽으면
    # 이 함수가 존재하는 이유인 진단이 통째로 사라진다(로그 디렉터리 쓰기 불가로 실측).
    rm -f "$PREVIEW_MARKER" || true

    # ── 빌드 산출물 제거 ──
    # 이 앱은 cacheComponents: true 아래 **빌드 타임에 DB 를 읽어** 페이지를 프리렌더한다
    # (`"use cache"` — src/lib/cached-crm-data.ts·cached-portal-data.ts). 프리뷰 빌드가
    # 읽는 DB 는 프로덕션 사본이므로, 그 결과가 .next/server/app/** 과
    # .live/releases/*/.next/server/app/** 에 직렬화된 채 남는다. DB 컨테이너만 지우고
    # 이것을 남기면 "닫는 동안 프로덕션 사본이 디스크에 존재하지 않는다"는 이 기능의
    # 기준을 데이터의 **절반에만** 적용하는 셈이다.
    # ⛔ 종전 결정 "빌드 재사용을 위해 .next 는 남긴다" 는 오너가 뒤집었다(2026-08-13) —
    # 재오픈 속도보다 잔여 사본 0 이 우선이다. 대가는 매 up 이 재빌드라는 것(수 분).
    #
    # ⚠️ 이 스크립트에서 **유일한 재귀 삭제**다. 상단의 경로 문자열 가드는 미래의 편집을
    # 잡는 **트립와이어**일 뿐 런타임 방어가 아니다 — 문자열이 같아도 그 경로가 가리키는
    # **실체**는 다를 수 있기 때문이다. 실제 방어는 아래 두 가지다:
    #   ① 심볼릭 링크 거부 + 물리 경로 일치. `~/selfhost/wagcrm-preview` 가 프로덕션
    #      체크아웃으로 향하는 심링크면 문자열 가드도(같은 문자열), `.git` 검사도(링크를
    #      따라가므로) 전부 통과하고 rm -rf 가 **프로덕션 체크아웃에 떨어진다**(실측).
    #      그래서 pwd -P 로 물리 경로를 풀어 기대 경로와 대조한다. 기대 경로 쪽도 부모를
    #      풀어서 비교한다 — ~/selfhost 자체가 심링크인 정상 배치를 거짓 양성으로
    #      잡지 않기 위해서다.
    #   ② git 체크아웃인지 확인. 아니면 지우지 않고 문제로 보고한다.
    # (rm 대상에 끝 슬래시를 붙이지 않는 것도 계약이다 — 대상이 심링크일 때 끝 슬래시는
    #  링크를 **따라가** 실체를 지운다. 슬래시가 없으면 링크 자신만 지워진다.)
    if [ ! -e "$PREVIEW_CHECKOUT" ]; then
      : # 체크아웃 자체가 없다 — 지울 산출물도 없다(멱등)
    elif [ -L "$PREVIEW_CHECKOUT" ]; then
      problems="$problems
  - 빌드 산출물을 지우지 **않았습니다**: $PREVIEW_CHECKOUT 이 심볼릭 링크입니다. 링크를 따라가면 다른 체크아웃(프로덕션일 수 있음)을 지우게 되므로 손대지 않았습니다 — 프리뷰 체크아웃은 실제 디렉터리여야 합니다."
    elif ! checkout_is_physically_expected "$PREVIEW_CHECKOUT"; then
      problems="$problems
  - 빌드 산출물을 지우지 **않았습니다**: $PREVIEW_CHECKOUT 이 디렉터리가 아니거나 접근할 수 없습니다(위 -L 검사를 통과했으므로 심볼릭 링크는 아닙니다). 재귀 삭제 대상이 맞는지 확정할 수 없어 손대지 않았습니다."
    elif [ ! -d "$PREVIEW_CHECKOUT/.git" ]; then
      problems="$problems
  - 빌드 산출물을 지우지 **않았습니다**: $PREVIEW_CHECKOUT 이 git 체크아웃으로 보이지 않습니다(.git 없음). 재귀 삭제 대상이 맞는지 확인되지 않아 손대지 않았습니다 — 경로를 직접 확인하세요."
    else
      rm -rf "$PREVIEW_CHECKOUT/.next" || true
      # ⚠️ 서빙 트리도 반드시 함께 지운다 (2026-08-29). deploy.sh 안전장치 ⑧ 이후
      # 프리렌더 산출물의 **실제 사본**은 이쪽에 있다 — `.next` 만 지우면 프로덕션
      # 사본 DB 로 만든 페이지가 디스크에 그대로 남아, 「잔여 사본 0」(오너 확정
      # 2026-08-13)이 데이터의 절반에만 적용된다. 위 심링크·물리경로·.git 3중 가드를
      # 통과한 같은 체크아웃 안이므로 추가 가드는 필요 없다.
      rm -rf "$PREVIEW_CHECKOUT/.live" || true
    fi
  fi

  if [ -e "$PLIST_DST" ]; then
    problems="$problems
  - plist 가 지워지지 않았습니다: $PLIST_DST — 남아 있으면 launchd 가 로그인 시 다시 로드해 재부팅이 프리뷰를 되살립니다."
  fi

  # ⚠️ `docker inspect` 의 실패는 **양의적이다** — "컨테이너가 없다"와 "데몬에 못
  # 붙었다"가 같은 nonzero 로 온다. 그런데 후자는 위 `docker rm` 도 실패했다는
  # 뜻이라 정확히 위험한 쪽이다. 그래서 데몬 도달 가능 여부를 먼저 갈라서 본다 —
  # 확인하지 못한 것을 "없음"으로 읽지 않는다.
  if ! command -v docker >/dev/null 2>&1; then
    problems="$problems
  - docker 실행파일을 PATH 에서 찾지 못해 DB 컨테이너가 정말 없는지 **확인하지 못했습니다**(PATH=$PATH)."
  elif ! docker info >/dev/null 2>&1; then
    problems="$problems
  - docker 데몬에 연결하지 못했습니다 — 방금 실행한 컨테이너 삭제도 함께 실패했을 것이고, 그렇다면 DB 컨테이너가 그대로 남아 있습니다. Docker Desktop 을 띄운 뒤 down 을 다시 실행하세요."
  elif docker inspect "$PREVIEW_CONTAINER" >/dev/null 2>&1; then
    problems="$problems
  - DB 컨테이너가 아직 존재합니다($PREVIEW_CONTAINER). 확인: docker inspect $PREVIEW_CONTAINER"
  fi

  if [ -e "$PREVIEW_CHECKOUT/.next" ]; then
    problems="$problems
  - 빌드 산출물이 아직 남아 있습니다: $PREVIEW_CHECKOUT/.next — 그 안에는 프리뷰 DB(프로덕션 사본)로 프리렌더된 페이지가 들어 있습니다."
  fi

  if [ -e "$PREVIEW_CHECKOUT/.live" ]; then
    problems="$problems
  - 서빙 산출물이 아직 남아 있습니다: $PREVIEW_CHECKOUT/.live — 그 안에는 프리뷰 DB(프로덕션 사본)로 프리렌더된 페이지가 들어 있습니다."
  fi

  if [ -e "$PREVIEW_MARKER" ]; then
    problems="$problems
  - 배포 마커가 아직 남아 있습니다: $PREVIEW_MARKER — 남으면 다음 up 이 deploy.sh 의 '변경 없음' 경로로 빠져 빌드를 건너뛰고, 산출물 없는 서비스를 올립니다."
  fi

  if [ -n "$problems" ]; then
    printf '[preview] 중단: down 이 목표 상태에 도달하지 못했습니다.%s\n' "$problems" >&2
    printf '[preview] ⚠️ 프리뷰 DB 는 프로덕션 사본입니다 — 위 항목을 정리하기 전까지 "닫혔다"고 볼 수 없습니다.\n' >&2
    exit 1
  fi

  log "닫힘 — 앱 서비스·plist·DB 컨테이너·빌드 산출물·배포 마커 다섯의 **부재를 확인**했습니다. crm-test.ygrd.kr 은 502 가 정상입니다."
  log "프로덕션 사본에서 나온 것은 디스크에 남지 않았습니다. 다음 up 은 항상 전량 재빌드입니다(수 분)."
}

cmd_status() {
  if [ -f "$PLIST_DST" ]; then
    echo "상태: up (plist 있음)"
  else
    echo "상태: down (plist 없음)"
  fi
  echo "launchd: $(launchctl list "$PREVIEW_LABEL" 2>/dev/null | grep '"PID"' || echo '미로드')"
  echo "DB 컨테이너: $(docker inspect --format '{{.State.Status}} (생성 {{.Created}})' "$PREVIEW_CONTAINER" 2>/dev/null || echo '없음')"

  # curl 은 접속 실패 시 stdout 에 `000` 을 **쓰면서** nonzero 로 끝난다 — 종전처럼
  # `|| echo '무응답'` 를 붙이면 둘 다 찍혀 "000무응답" 이 된다. 코드를 먼저 받아
  # 하나로 정리한다.
  local http_code
  http_code="$(curl -o /dev/null -s -m 5 -w '%{http_code}' "http://127.0.0.1:$PREVIEW_PORT/" || true)"
  case "$http_code" in
    ""|000) http_code="무응답" ;;
  esac
  echo "HTTP :$PREVIEW_PORT → $http_code"

  # ⚠️ 체크아웃 HEAD 는 "up 이 어느 브랜치로 맞췄는가"일 뿐 **"지금 서빙 중인 빌드가
  # 무엇인가"가 아니다.** cmd_up 은 체크아웃을 먼저 옮기고 그 다음에 빌드하므로,
  # 빌드가 실패해 up 이 중단되면 서비스는 **이전 빌드**를 계속 서빙하는데 체크아웃만
  # 새 브랜치다. HEAD 만 보여주면 이 명령이 존재하는 이유("무엇이 떠 있는가")에
  # 정확히 거짓을 답하게 된다 — 그것도 하필 실패한 국면에서.
  # 배포 마커는 deploy.sh 가 빌드·PID 교체·헬스체크·DB 프로브를 전부 통과했을 때만
  # 쓰므로, 그쪽이 "서빙 중인 빌드"의 좌표다. 둘을 함께 내고 어긋나면 못 지나치게 한다.
  if [ -d "$PREVIEW_CHECKOUT/.git" ]; then
    local head_ref head_sha marker_sha
    head_ref="$(git -C "$PREVIEW_CHECKOUT" rev-parse --abbrev-ref HEAD)"
    head_sha="$(git -C "$PREVIEW_CHECKOUT" rev-parse HEAD)"
    marker_sha="$(cat "$PREVIEW_MARKER" 2>/dev/null || true)"
    echo "체크아웃: $head_ref @ ${head_sha:0:7}"
    if [ -z "$marker_sha" ]; then
      echo "서빙 중인 빌드: 없음 — 배포 마커가 없습니다($PREVIEW_MARKER). down 이 마커와 빌드 산출물을 함께 지우므로, 닫힌 상태에서는 이것이 정상입니다(성공한 배포가 아직 없는 경우도 같은 표시)."
    elif [ "$marker_sha" = "$head_sha" ]; then
      echo "서빙 중인 빌드: ${marker_sha:0:7} (체크아웃과 일치)"
    else
      echo "서빙 중인 빌드: ${marker_sha:0:7}"
      echo "⚠️ 불일치 — 체크아웃은 $head_ref @ ${head_sha:0:7} 인데, 마지막으로 성공한 배포는 ${marker_sha:0:7} 입니다."
      echo "   지금 :$PREVIEW_PORT 이 서빙하는 것은 위 체크아웃 브랜치가 **아닙니다**(up 이 빌드 단계에서 실패하면 이 상태가 됩니다)."
      echo "   해결: bash $PREVIEW_CHECKOUT/infra/selfhost/preview.sh up $head_ref  (실패 원인은 ~/selfhost/logs/preview.err.log)"
    fi
  fi
  # 마지막 복원 소스 — 오래 열어둔 프리뷰가 낡은 데이터를 보여주는 상황을 사람이 알아챈다.
  echo "데이터: $(grep '복원 완료' "$HOME/selfhost/logs/preview-db.log" 2>/dev/null | tail -1 || echo '기록 없음')"
}

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *) echo "사용법: preview.sh up [<브랜치>] | down | status" >&2; exit 2 ;;
esac
