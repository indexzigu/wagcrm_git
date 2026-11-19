#!/usr/bin/env bash
set -euo pipefail

# 확장 고리 일일 실행 — crontab 이 하루 1회 부른다.
# 헤드리스 claude 운영자를 띄워 $EXPANSION_REPO/docs/private/expansion/ 의 프롬프트·장부를 읽고
# 일하게 한다. 운영자는 프로덕션 DB 를 expansion-readonly-sql.sh 로만 읽는다.
# 실패(종료코드≠0 · 타임아웃 · 결과 JSON is_error · 결과 JSON 파손)면 cron.log 에 FAIL 줄을 쓰고
# 「오늘은 건너뜀」 카드 1장을 hermes 게시 CLI 로 올린 뒤 exit 1 한다.
#
# env: EXPANSION_REPO · EXPANSION_OPS_WT(운영 트리, none=끔) · EXPANSION_CLAUDE_BIN · EXPANSION_TIMEOUT_S(3600) · EXPANSION_DRY(1=claude 미호출)
#      EXPANSION_LOG · EXPANSION_PROMPT(레포 기준 상대경로 가능; 기본 daily-run.md, 첫 회차는 명시 지정)
#      EXPANSION_HERMES_DIR · EXPANSION_POST_BIN · EXPANSION_POST_TIMEOUT_S(120)
#      EXPANSION_APP_KEY(앱 개인키, none=끔) · EXPANSION_APP_ID · EXPANSION_APP_INSTALLATION_ID · EXPANSION_APP_TOKEN_SCRIPT
#
# Slack 게시는 이 래퍼만 한다. 운영자는 out/YYYY-MM-DD-cards.json 만 쓰고, 성공 시 래퍼가 그 파일을 게시한다.
#
# cron.log 한 줄: [STAMP] OK|FAIL|SKIP expansion-loop cost=<usd|unknown> ...  (incident-notify.sh 와 같은 STAMP)
# cost 는 claude 가 실패·타임아웃이어도 결과 JSON 에서 먼저 읽는다. 못 읽으면 unknown(0 이 아니다 — 지출이 있었을 수 있다);
# runs 파일에는 null 로 쓴다.
# JSON 파싱은 node — selfhost 스크립트가 이미 node 를 쓰고(PATH 보강 목록 동일), 추가 의존이 없다.
# 호스트 bash 는 3.2: wait -n·연관 배열·${v,,} 금지.

export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin"

REPO="${EXPANSION_REPO:-$HOME/Projects/wag-crm}"
# 운영자는 메인 체크아웃이 아니라 매 회차 최신 main 으로 맞춘 전용 분리 트리에서 돈다 — 메인 체크아웃은
# 다른 세션이 아무 브랜치에나 둘 수 있어, 거기서 돌면 main 에만 있는 프로젝트 에이전트 정의를 못 찾는다.
# docs/private 는 메인 체크아웃 한 곳에만 살므로 운영 트리에는 그쪽을 가리키는 링크를 둔다.
# 운영자 프롬프트는 메인 체크아웃 절대 경로(카드·장부·실행 워크트리)에 쓰므로 claude 에 --add-dir "$REPO" 로 그 쓰기 범위를 준다.
OPS_WT="${EXPANSION_OPS_WT-$REPO/.claude/worktrees/expansion-ops}"
[ "$OPS_WT" = "none" ] && OPS_WT=""
CLAUDE_BIN="${EXPANSION_CLAUDE_BIN:-claude}"
TIMEOUT_S="${EXPANSION_TIMEOUT_S:-3600}"
DRY="${EXPANSION_DRY:-0}"
LOG="${EXPANSION_LOG:-$HOME/selfhost/logs/cron.log}"
HERMES_DIR="${EXPANSION_HERMES_DIR:-$HOME/.hermes/hermes-agent}"
POST_BIN="${EXPANSION_POST_BIN:-$HERMES_DIR/.venv/bin/python}"
POST_TIMEOUT_S="${EXPANSION_POST_TIMEOUT_S:-120}"
case "$POST_TIMEOUT_S" in ''|*[!0-9]*) POST_TIMEOUT_S=120 ;; esac
case "$TIMEOUT_S" in ''|*[!0-9]*) TIMEOUT_S=3600 ;; esac
# 회차의 GitHub 신원은 오너 계정이 아니라 전용 GitHub App(wag-expansion-bot) 이다 — 저장소 규칙
# `expansion-bot-exp-only` 가 그 신원에게 exp/** 밖 브랜치 생성·갱신·삭제(= main 반영)를 막는다.
# 키 파일이 없거나 발급이 실패하면 오너 자격으로 물러서지 않고 회차를 멈춘다. ID 는 비밀이 아니다(키가 비밀).
# 한계: 같은 macOS 사용자로 돌므로 회차가 일부러 오너 keyring 토큰을 꺼내 쓰는 것까지는 못 막는다.
APP_KEY="${EXPANSION_APP_KEY-$HOME/selfhost/expansion-app.pem}"
[ "$APP_KEY" = "none" ] && APP_KEY=""
APP_ID="${EXPANSION_APP_ID:-5832880}"
APP_INSTALLATION_ID="${EXPANSION_APP_INSTALLATION_ID:-183673676}"
APP_TOKEN_SCRIPT="${EXPANSION_APP_TOKEN_SCRIPT:-$(cd "$(dirname "$0")" && pwd)/expansion-app-token.mjs}"
# 앱 설치 토큰 수명은 1시간(GitHub 고정) — 회차 시간 상한이 그보다 길면 끝 무렵 push·PR 이 만료 토큰으로 실패한다.
APP_TOKEN_TTL_S=3600

EXP_DIR="$REPO/docs/private/expansion"
RUNS_DIR="$EXP_DIR/runs"
SKIP_CARD="$EXP_DIR/prompts/skipped-card.json"
# 실행 날짜는 시작 시 한 번만 잰다 — 자정을 넘겨도 카드 파일명·건너뜀 카드·운영자가 같은 날짜를 쓴다.
RUN_DATE="$(date '+%Y-%m-%d')"
export EXPANSION_DATE="$RUN_DATE"
CARDS_FILE="$EXP_DIR/out/$RUN_DATE-cards.json"
LOCK_DIR="$HOME/selfhost/locks/expansion-loop"

mkdir -p "$(dirname "$LOG")"

log_line() { # label body
  printf '[%s] %s expansion-loop %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" \
    "$(printf '%s' "$2" | tr '\000-\037' ' ' | cut -c1-400)" >> "$LOG"
}

# ── 잠금(mkdir 원자성). 소유하지 않은 잠금은 SKIP 경로에서 절대 지우지 않는다. ──
OWNS_LOCK=0
WORK_DIR=""
GROUP_PID=""
cleanup() {
  if [ -n "$GROUP_PID" ]; then kill -KILL -- "-$GROUP_PID" 2>/dev/null || true; fi
  [ -z "$WORK_DIR" ] || rm -rf "$WORK_DIR"
  [ "$OWNS_LOCK" -eq 1 ] && rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 143' INT TERM HUP

# GNU stat 먼저, 안 되면 BSD(macOS). 순서가 중요하다: GNU 의 `-f` 는 파일시스템 정보라 `stat -f %m X` 가
# 실패하면서도 stdout 에 정보를 뱉는다(BSD 의 `-c` 는 stdout 없이 실패). 숫자가 아니면 현재 시각
# (= 낡지 않음으로 취급 → 건드리지 않는다).
mtime_of() {
  local t
  t=$(stat -c %Y "$1" 2>/dev/null) || t=$(stat -f %m "$1" 2>/dev/null) || t=""
  case "$t" in ''|*[!0-9]*) date +%s ;; *) echo "$t" ;; esac
}

mkdir -p "$(dirname "$LOCK_DIR")"
lock_age() { echo $(( $(date +%s) - $(mtime_of "$1") )); }
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  # 잠근 쪽이 SIGKILL·전원 손실로 죽으면 잠금이 영영 남는다 — 타임아웃+600초보다 오래된 잠금은 넘겨받는다.
  # 넘겨받기(rmdir→mkdir)는 원자적이지 않다: 두 실행이 함께 하면 한쪽이 다른 쪽의 새 잠금을 지워
  # 둘 다 소유하게 된다. 그래서 회수 표지(.reclaim, mkdir 원자성)를 쥔 한 실행만 넘겨받고,
  # 표지를 쥔 뒤 나이를 다시 잰다(먼저 넘겨받은 실행이 만든 새 잠금이면 낡지 않았다).
  STALE_S=$(( TIMEOUT_S + 600 ))
  RECLAIM_DIR="$LOCK_DIR.reclaim"
  reclaimed=0
  age=$(lock_age "$LOCK_DIR")
  if [ "$age" -gt "$STALE_S" ]; then
    if mkdir "$RECLAIM_DIR" 2>/dev/null; then
      age=$(lock_age "$LOCK_DIR")
      if [ "$age" -gt "$STALE_S" ] && rmdir "$LOCK_DIR" 2>/dev/null && mkdir "$LOCK_DIR" 2>/dev/null; then
        reclaimed=1
      fi
      rmdir "$RECLAIM_DIR" 2>/dev/null || true
    elif [ "$(lock_age "$RECLAIM_DIR")" -gt 600 ]; then
      # 회수 도중 죽은 실행이 남긴 표지 — 지우기만 하고 이번 회차는 쉰다(잠금은 다음 회차가 넘겨받는다).
      rmdir "$RECLAIM_DIR" 2>/dev/null || true
    fi
  fi
  if [ "$reclaimed" -eq 1 ]; then
    log_line SKIP "stale-lock-reclaimed age=${age}s cost=0"
  else
    log_line SKIP "locked cost=0"
    exit 0
  fi
fi
OWNS_LOCK=1

# 프롬프트: 항상 daily-run.md. 첫 회차는 EXPANSION_PROMPT 로 명시해서만 고른다.
PROMPT="${EXPANSION_PROMPT:-docs/private/expansion/prompts/daily-run.md}"
case "$PROMPT" in /*) PROMPT_PATH="$PROMPT" ;; *) PROMPT_PATH="$REPO/$PROMPT" ;; esac

if [ "$DRY" = "1" ]; then
  echo "DRY: cd ${OPS_WT:-$REPO}; $CLAUDE_BIN -p --permission-mode auto --output-format json --model opus --add-dir $REPO < $PROMPT_PATH (timeout ${TIMEOUT_S}s)"
  log_line OK "cost=0 dry=1"
  exit 0
fi

# 명령 하나를 자기 프로세스 그룹으로 띄우고 1초 틱으로 시간을 잰다(macOS 에는 timeout 이 없다).
# 결과: RG_RC(종료코드) · RG_TIMEOUT(1=시간 초과). 정상 종료 뒤에도 그룹에 TERM 1회를 보내
# 남은 자식(MCP 서버 등)이 매일 쌓이지 않게 한다.
run_grouped() { # timeout_s stdin_file out_file err_file cmd...
  local t="$1" inp="$2" out="$3" err="$4" elapsed=0
  shift 4
  RG_TIMEOUT=0; RG_RC=0
  perl -e 'setpgrp(0,0); exec @ARGV or die "exec: $!"' -- "$@" < "$inp" > "$out" 2> "$err" &
  GROUP_PID=$!
  while kill -0 "$GROUP_PID" 2>/dev/null; do
    if [ "$elapsed" -ge "$t" ]; then
      RG_TIMEOUT=1
      kill -TERM -- "-$GROUP_PID" 2>/dev/null || true
      sleep 2
      kill -KILL -- "-$GROUP_PID" 2>/dev/null || true
      break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  wait "$GROUP_PID" 2>/dev/null || RG_RC=$?
  kill -TERM -- "-$GROUP_PID" 2>/dev/null || true
  GROUP_PID=""
}

# 카드 게시. 결과는 POST_RESULT = ok|failed|timeout.
post_card() { # card_file
  POST_RESULT=failed
  [ -f "$1" ] && [ -e "$POST_BIN" ] || return 0
  run_grouped "$POST_TIMEOUT_S" /dev/null "$WORK_DIR/post.out" "$WORK_DIR/post.err" \
    "$POST_BIN" "$HERMES_DIR/plugins/wag-operator/expansion_cards.py" post "$1"
  if [ "$RG_TIMEOUT" -eq 1 ]; then POST_RESULT=timeout
  elif [ "$RG_RC" -eq 0 ]; then POST_RESULT=ok; fi
}

write_run() { # status cost(숫자|unknown) is_error
  local cost_json="$2"
  [ "$cost_json" != "unknown" ] || cost_json=null
  mkdir -p "$RUNS_DIR" 2>/dev/null || return 0
  printf '{"date":"%s","status":"%s","total_cost_usd":%s,"is_error":%s}\n' \
    "$RUN_DATE" "$1" "$cost_json" "$3" > "$RUNS_DIR/$RUN_DATE.json" 2>/dev/null || true
}

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/expansion-loop.XXXXXX")"
OUT="$WORK_DIR/out.json"
ERR="$WORK_DIR/err.txt"

# 실패: FAIL 줄을 먼저 쓰고, 「오늘은 건너뜀」 카드를 올린 뒤 결과를 둘째 줄에 남긴다. 항상 exit 1.
fail() { # reason [cost]
  local cost="${2:-0}"
  write_run FAIL "$cost" true
  log_line FAIL "cost=$cost $1"
  # 자리표시 날짜(2000-01-01)는 게시 CLI 검증용이다 — 원본은 두고 실행 날짜로 바꾼 임시 사본을 올린다.
  # 사본 만들기가 실패하거나 빈 파일이면 원본을 그대로 올린다(원본은 어느 경우에도 수정하지 않는다).
  if [ -f "$SKIP_CARD" ]; then
    if sed "s/\"date\": *\"2000-01-01\"/\"date\": \"$RUN_DATE\"/" "$SKIP_CARD" > "$WORK_DIR/skipped-card.json" 2>/dev/null \
       && [ -s "$WORK_DIR/skipped-card.json" ]; then
      post_card "$WORK_DIR/skipped-card.json"
    else
      post_card "$SKIP_CARD"
    fi
  else
    post_card "$SKIP_CARD"
  fi
  log_line POST "post=$POST_RESULT card=skipped"
  exit 1
}

[ -f "$PROMPT_PATH" ] || fail "프롬프트 없음"
RUN_DIR="$REPO"
if [ -n "$OPS_WT" ]; then
  # 공유 FETCH_HEAD 는 다른 세션의 fetch 가 덮을 수 있다 — 전용 참조로 받는다. 저속 연결은 60초에 끊는다
  # (run_grouped 밖이라 여기서 멈추면 락을 쥔 채 무기한 대기한다).
  GIT_TERMINAL_PROMPT=0 git -C "$REPO" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 \
    fetch -q origin +refs/heads/main:refs/expansion-ops/main 2> "$WORK_DIR/git.err" \
    || fail "운영 트리: fetch 실패 $(head -n 1 "$WORK_DIR/git.err" 2>/dev/null)"
  OPS_SHA="$(git -C "$REPO" rev-parse --verify 'refs/expansion-ops/main^{commit}' 2>/dev/null)" || fail "운영 트리: main SHA 없음"
  if [ -f "$OPS_WT/.git" ] && ! git -C "$OPS_WT" rev-parse --git-dir >/dev/null 2>&1; then
    # 관리 폴더가 prune 돼 끊긴 운영 트리(.git 파일 = 분리 트리) — 지우지 않고 옆으로 옮긴 뒤(안의 수기 편집 보존)
    # 아래에서 새로 만든다.
    mv "$OPS_WT" "$OPS_WT.broken-$(date +%Y%m%d%H%M%S)" || fail "운영 트리: 끊긴 트리 옮기기 실패"
  fi
  if [ -e "$OPS_WT/.git" ]; then
    # 운영 트리는 아무도 고치지 않는다 — 추적 파일이 바뀌어 있으면 덮지 않고 멈춘다(조용히 버리지 않는다).
    [ -z "$(git -C "$OPS_WT" status --porcelain --untracked-files=no 2>/dev/null)" ] || fail "운영 트리: 추적 파일 변경 있음"
    git -C "$OPS_WT" checkout -q --detach "$OPS_SHA" 2> "$WORK_DIR/git.err" \
      || fail "운영 트리: checkout 실패 $(head -n 1 "$WORK_DIR/git.err" 2>/dev/null)"
  else
    # 폴더만 지워지고 등록이 남아 있으면 worktree add 가 거부한다 — -f 로 이 경로의 등록만 덮는다
    # (worktree prune 은 다른 세션의 등록까지 지우므로 쓰지 않는다). 비어 있지 않은 폴더는 -f 로도 거부된다.
    mkdir -p "$(dirname "$OPS_WT")" 2>/dev/null || true
    git -C "$REPO" worktree add -q -f --detach "$OPS_WT" "$OPS_SHA" 2> "$WORK_DIR/git.err" \
      || fail "운영 트리: 생성 실패 $(head -n 1 "$WORK_DIR/git.err" 2>/dev/null)"
  fi
  mkdir -p "$OPS_WT/docs" 2>/dev/null || true
  [ -e "$OPS_WT/docs/private" ] || [ -L "$OPS_WT/docs/private" ] || ln -s "$REPO/docs/private" "$OPS_WT/docs/private" \
    || fail "운영 트리: docs/private 링크 실패"
  [ -L "$OPS_WT/docs/private" ] || fail "운영 트리: docs/private 가 링크가 아님"
  RUN_DIR="$OPS_WT"
fi
cd "$RUN_DIR" 2>/dev/null || fail "레포 경로 없음"
rm -f "$CARDS_FILE"

# 앱 토큰은 회차 직전에 발급한다(수명 1시간). gh 와 git(전역 자격 도우미 = gh auth git-credential)이 GH_TOKEN 을 쓴다.
if [ -n "$APP_KEY" ]; then
  [ "$TIMEOUT_S" -le "$APP_TOKEN_TTL_S" ] || fail "시간 상한 ${TIMEOUT_S}s 가 앱 토큰 수명 ${APP_TOKEN_TTL_S}s 보다 길다"
  [ -s "$APP_KEY" ] || fail "앱 키 없음"
  APP_TOKEN="$(node "$APP_TOKEN_SCRIPT" "$APP_ID" "$APP_INSTALLATION_ID" "$APP_KEY" 2> "$WORK_DIR/app.err")" \
    || fail "앱 토큰 발급 실패 $(head -n 1 "$WORK_DIR/app.err" 2>/dev/null)"
  [ -n "$APP_TOKEN" ] || fail "앱 토큰 발급 실패 (빈 토큰)"
  unset GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
  export GH_TOKEN="$APP_TOKEN"
  unset APP_TOKEN
fi

run_grouped "$TIMEOUT_S" "$PROMPT_PATH" "$OUT" "$ERR" \
  "$CLAUDE_BIN" -p --permission-mode auto --output-format json --model opus --add-dir "$REPO"

# 비용은 종료코드·타임아웃 판정보다 먼저 읽는다(best-effort) — 실패한 실행도 지출은 남겨야 한다.
COST="$(node -e '
const fs=require("fs");
try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const c=j&&typeof j==="object"&&typeof j.total_cost_usd==="number"?j.total_cost_usd:NaN;
if(!Number.isFinite(c))process.exit(3);
console.log(String(c));}catch(e){process.exit(3);}' "$OUT" 2>/dev/null)" || COST=unknown
[ -n "$COST" ] || COST=unknown

# 실패 사유: claude 는 --output-format json 에서 오류 문구(예: 로그인 만료)를 stderr 가 아니라 결과 JSON 의
# result 에 쓴다 — 그 앞부분을 사유에 붙인다(없으면 빈 값; 판정에는 쓰지 않는다).
RES_SNIP="$(node -e '
const fs=require("fs");
try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
if(j&&typeof j.result==="string")console.log(j.result.replace(/\s+/g," ").slice(0,160));}catch(e){}' "$OUT" 2>/dev/null)" || RES_SNIP=""

[ "$RG_TIMEOUT" -eq 0 ] || fail "타임아웃 ${TIMEOUT_S}s" "$COST"
[ "$RG_RC" -eq 0 ] || fail "claude exit=$RG_RC ${RES_SNIP:+$RES_SNIP | }$(tail -c 200 "$ERR" 2>/dev/null)" "$COST"

# node 의 stderr 는 버리지 않는다 — node 가 없거나 깨진 것을 「결과 JSON 파손」으로 오인하지 않게 첫 줄을 사유에 붙인다.
PARSE_ERR="$WORK_DIR/parse.err"
IS_ERR="$(node -e '
const fs=require("fs");
let j;
try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));}catch(e){process.exit(3);}
if(!j||typeof j!=="object"||typeof j.is_error!=="boolean")process.exit(3);
console.log(j.is_error?"1":"0");' "$OUT" 2> "$PARSE_ERR")" \
  || fail "결과 JSON 파손 $(head -n 1 "$PARSE_ERR" 2>/dev/null)" "$COST"

[ "$IS_ERR" = "0" ] || fail "결과 is_error=true $RES_SNIP" "$COST"

# 운영자가 쓴 카드 파일: 유효 JSON 이고 cards 배열이 비어 있지 않아야 한다.
node -e '
const fs=require("fs");
try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
process.exit(j&&Array.isArray(j.cards)&&j.cards.length>0?0:3);}catch(e){process.exit(3);}' "$CARDS_FILE" 2>/dev/null \
  || fail "no-cards" "$COST"

post_card "$CARDS_FILE"
if [ "$POST_RESULT" != "ok" ]; then
  write_run FAIL "$COST" true
  log_line FAIL "cost=$COST post=$POST_RESULT"
  exit 1
fi

write_run OK "$COST" false
log_line OK "cost=$COST post=ok"
exit 0
