#!/usr/bin/env bash
set -euo pipefail

# 확장 고리 push 관문 — 노출 점검과 push 를 한 스크립트로 묶는다.
# 사용: expansion-push.sh <worktree-절대경로> <slug> <제목-파일>
# 점검기·커밋 가드는 fetch 한 main SHA 에서 꺼낸 신뢰 사본을 쓴다(작업 트리 사본은 브랜치가 바꿀 수 있다).
# 커밋 가드(scripts/commit-guard.mjs)는 점검기에 --guard 로 넘겨 시크릿·이메일·금액 표기도 push 시점에 본다.
# 통과 = 점검기 종료코드 0 그리고 stdout 에 `OK:` 줄(표지 `PR 제목`·`커밋 가드` 포함).
# 종료코드: 0 push 성공 · 1 BLOCKED/push 실패 · 2 사용법 오류. 금지어 파일 내용은 출력하지 않는다.
#
# 신뢰 경계: 이 스크립트는 「성실하지만 실수할 수 있는 운영자」를 막는다 — 점검 없는 push·상속된 git 설정/환경변수의
#   대상 바꿔치기·이름(origin/main)으로 기준 가로채기·태그/추가 ref 동반 push·브랜치 자신의 점검기 사본 사용·
#   replace ref 로 점검 기준이나 점검 대상 커밋 바꿔치기(GIT_NO_REPLACE_OBJECTS).
#   막지 않는 것: 설정 파일을 의도적으로 경합 갱신하거나, PATH 에 가짜 바이너리를 심거나, 네트워크/TLS 를 장악하거나,
#   core.fsmonitor 등 설정이 실행하는 코드를 쓰는 행위자. 그런 행위자는 같은 push 자격증명으로 exp/* 를 직접 올릴 수 있다.
#   진짜 경계는 push 자격증명의 분리(오너 설정 항목)이며, 이 스크립트가 그것을 대신하지 않는다.
#
# env: EXPANSION_NODE_BIN(node). 원격 주소·금지어 파일 경로는 상수다(env 로 못 바꾼다) — 테스트는 이 상수 줄을 바꾼 사본을 쓴다.
# 호스트 bash 는 3.2: 연관 배열·${v,,} 금지.

export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin"

# 기대하는 origin 주소 — env 로 덮어쓸 수 없다(덮어쓰기 자체가 우회다). 테스트는 이 상수 줄을 바꾼 사본을 쓴다.
readonly EXPECTED_ORIGIN="https://github.com/indexzigu/wagcrm_git.git"
# 금지어 파일 경로 — 같은 이유로 상수다(약한 목록을 가리키는 env 가 상속되면 점검이 조용히 약해진다).
readonly DENYLIST="$HOME/Projects/wag-crm/docs/private/expansion/denylist.txt"

# 상속된 환경변수로 git 설정·대상이 바뀌는 흔한 경로를 줄인다(PATH 의 가짜 git 등은 막지 못한다 — 위 신뢰 경계).
unset GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_DIR GIT_WORK_TREE GIT_SSH GIT_SSH_COMMAND GIT_ASKPASS GIT_REPLACE_REF_BASE
# replace ref(refs/replace/*)를 끈다: `git replace <기준> <가짜>` 로 꺼내는 점검기를 바꾸거나 점검 대상 커밋을 가리지 못하게.
export GIT_NO_REPLACE_OBJECTS=1
for _v in $(env | grep -aE '^GIT_CONFIG_(KEY|VALUE)_[0-9]+=' | cut -d= -f1 || true); do unset "$_v"; done

usage() { printf 'usage: expansion-push.sh <worktree-abs-path> <slug> <title-file>\n' >&2; exit 2; }
blocked() { printf 'BLOCKED: %s\n' "$1" >&2; exit 1; }

[ "$#" -eq 3 ] || usage
WT="$1"; SLUG="$2"; TITLE="$3"
case "$WT" in /*) ;; *) printf '사용법 오류: 워크트리 경로는 절대 경로여야 한다\n' >&2; usage ;; esac
[[ $SLUG =~ ^[a-z0-9][a-z0-9-]{2,48}$ ]] || { printf '사용법 오류: slug 형식 불일치\n' >&2; usage; }
[ -s "$TITLE" ] || { printf '사용법 오류: 제목 파일이 없거나 비어 있다\n' >&2; usage; }
case "$TITLE" in /*) ;; *) TITLE="$PWD/$TITLE" ;; esac

NODE_BIN="${EXPANSION_NODE_BIN:-node}"
BRANCH="exp/$SLUG"

TMP_DIR=""
cleanup() { [ -z "$TMP_DIR" ] || rm -rf "$TMP_DIR"; }
trap cleanup EXIT
trap 'exit 143' INT TERM HUP

cd "$WT" 2>/dev/null || blocked "워크트리로 이동할 수 없다"
# 하위 폴더를 받아도 최상위에서 점검한다(점검기 쪽 diff.relative 고정과 겹치는 이중 방벽).
TOP="$(git rev-parse --show-toplevel 2>/dev/null)" || blocked "워크트리 최상위를 찾을 수 없다"
cd "$TOP" 2>/dev/null || blocked "워크트리 최상위로 이동할 수 없다"
[ "$(git branch --show-current 2>/dev/null)" = "$BRANCH" ] || blocked "현재 브랜치가 $BRANCH 가 아니다"
PORC="$(git status --porcelain 2>/dev/null)" || blocked "git status 실패"
[ -z "$PORC" ] || blocked "작업 트리가 깨끗하지 않다"
if git config --get remote.origin.pushurl >/dev/null 2>&1; then
  blocked "remote.origin.pushurl 이 설정돼 있다 (fetch 와 push 대상이 갈릴 수 있다)"
fi
FETCH_URLS="$(git remote get-url --all origin 2>/dev/null)" || blocked "origin 주소를 읽을 수 없다"
PUSH_URLS="$(git remote get-url --push --all origin 2>/dev/null)" || blocked "origin push 주소를 읽을 수 없다"
if [ "$FETCH_URLS" != "$EXPECTED_ORIGIN" ] || [ "$PUSH_URLS" != "$EXPECTED_ORIGIN" ]; then
  blocked "origin 주소가 기대값과 다름"
fi
git fetch origin refs/heads/main >/dev/null 2>&1 || blocked "git fetch origin main 실패"
# 이름(origin/main)은 로컬 브랜치·태그로 가릴 수 있다 — 방금 가져온 커밋 SHA 만 쓴다.
BASE="$(git rev-parse --verify 'FETCH_HEAD^{commit}' 2>/dev/null)" || blocked "FETCH_HEAD 를 읽을 수 없다"
SHA="$(git rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" || blocked "HEAD 를 읽을 수 없다"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/exp-push.XXXXXX")" || blocked "임시 디렉터리를 만들 수 없다"
CHECKER="$TMP_DIR/expansion-prepush-check.mjs"
git show "$BASE:scripts/expansion-prepush-check.mjs" > "$CHECKER" 2>/dev/null || blocked "점검 기준 커밋에서 점검기를 꺼내지 못했다"
[ -s "$CHECKER" ] || blocked "점검 기준 커밋의 점검기가 비어 있다"
GUARD="$TMP_DIR/commit-guard.mjs"
git show "$BASE:scripts/commit-guard.mjs" > "$GUARD" 2>/dev/null || blocked "점검 기준 커밋에서 커밋 가드를 꺼내지 못했다"
[ -s "$GUARD" ] || blocked "점검 기준 커밋의 커밋 가드가 비어 있다"

[ -s "$DENYLIST" ] || blocked "금지어 파일이 없거나 비어 있다"

OUT_FILE="$TMP_DIR/out"; ERR_FILE="$TMP_DIR/err"
RC=0
"$NODE_BIN" "$CHECKER" "$BASE" "$DENYLIST" --title-file "$TITLE" --guard "$GUARD" > "$OUT_FILE" 2> "$ERR_FILE" || RC=$?
if [ "$RC" -ne 0 ]; then
  cat "$ERR_FILE" >&2 || true
  blocked "노출 점검기 실패 (종료코드 $RC)"
fi
OK_LINES="$(grep -a '^OK:' "$OUT_FILE" || true)"
case "$OK_LINES" in
  *"PR 제목"*"커밋 가드"*) ;;
  *) cat "$ERR_FILE" >&2 || true; blocked "노출 점검기가 PR 제목·커밋 가드 점검 통과 OK 줄을 내지 않았다" ;;
esac

[ "$(git rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" = "$SHA" ] || blocked "점검 중 HEAD 가 바뀌었다"
[ "$(git branch --show-current 2>/dev/null)" = "$BRANCH" ] || blocked "점검 중 브랜치가 바뀌었다"
REMOTE_MAIN="$(git ls-remote origin refs/heads/main 2>/dev/null | cut -f1)" || true
[ "$REMOTE_MAIN" = "$BASE" ] || blocked "원격 main 이 점검 기준과 다름"

# core.hooksPath=/dev/null 은 push 중 훅 실행만 끈다 — 샌드박스가 아니다.
git -c push.followTags=false -c core.hooksPath=/dev/null push --no-follow-tags --recurse-submodules=no origin "$SHA:refs/heads/$BRANCH" || blocked "git push 실패"
printf 'PUSHED: %s %s\n' "$BRANCH" "$SHA"
