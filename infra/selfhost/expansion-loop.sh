#!/usr/bin/env bash
set -euo pipefail

# 확장 고리 일일 실행 — crontab 이 하루 1회 부른다.
# 헤드리스 claude 운영자를 띄워 $EXPANSION_REPO/docs/private/expansion/ 의 프롬프트·장부를 읽고
# 일하게 한다. 운영자는 프로덕션 DB 를 expansion-readonly-sql.sh 로만 읽는다.
# 실패(종료코드≠0 · 타임아웃 · 결과 JSON is_error · 결과 JSON 파손)면 cron.log 에 FAIL 줄을 쓰고
# 「오늘은 건너뜀」 카드 1장을 hermes 게시 CLI 로 올린 뒤 exit 1 한다.
#
# env: EXPANSION_REPO · EXPANSION_OPS_WT(운영 트리, none=끔) · EXPANSION_CLAUDE_BIN · EXPANSION_TIMEOUT_S(3600) · EXPANSION_MAX_BUDGET_USD(12) · EXPANSION_DRY(1=claude 미호출)
#      EXPANSION_PHASES(fork=공통 준비 1회 + 분기 3갈래 · single=예전처럼 한 번에, 되돌림 스위치; 그 밖의 값은 fork)
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
# Per-run spend cap (claude --max-budget-usd). Main-context growth made cost climb run over run; this bounds it.
# Invalid values fall back to the default rather than running uncapped.
MAX_BUDGET_USD="${EXPANSION_MAX_BUDGET_USD:-12}"
case "$MAX_BUDGET_USD" in ''|*[!0-9.]*|*.*.*|.*|*.) MAX_BUDGET_USD=12 ;; esac
# 회차의 GitHub 신원은 오너 계정이 아니라 전용 GitHub App(wag-expansion-bot) 이다 — 저장소 규칙
# `expansion-bot-exp-only` 가 그 신원에게 exp/** 밖 브랜치 생성·갱신·삭제(= main 반영)를 막는다.
# 키 파일이 없거나 발급이 실패하면 오너 자격으로 물러서지 않고 회차를 멈춘다. ID 는 비밀이 아니다(키가 비밀).
# 한계: 같은 macOS 사용자로 돌므로 회차가 일부러 오너 keyring 토큰을 꺼내 쓰는 것까지는 못 막는다.
# 끄는 값은 none 하나뿐이다 — 빈 값은 끄지 않고 아래에서 「앱 키 없음」 FAIL 로 간다(빈 대입 오타로 오너 자격 회차가 되지 않게).
APP_KEY="${EXPANSION_APP_KEY-$HOME/selfhost/expansion-app.pem}"
APP_OFF=0
[ "$APP_KEY" = "none" ] && APP_OFF=1
APP_ID="${EXPANSION_APP_ID:-5832880}"
APP_INSTALLATION_ID="${EXPANSION_APP_INSTALLATION_ID:-183673676}"
APP_TOKEN_SCRIPT="${EXPANSION_APP_TOKEN_SCRIPT:-$(cd "$(dirname "$0")" && pwd)/expansion-app-token.mjs}"
# 앱 설치 토큰 수명은 1시간(GitHub 고정) — 회차 시간 상한이 그보다 길면 끝 무렵 push·PR 이 만료 토큰으로 실패한다.
APP_TOKEN_TTL_S=3600

# 회차 실행 방식. fork: 단계 A(새 세션, 0~3절)를 한 번 돌리고 B(4·5절)·C(7절)·D(6·8~11절)를 모두 A 의 세션에서
# `--resume <A> --fork-session` 으로 갈라 차례로 돌린다 — 각 갈래는 A 까지의 앞부분만 캐시로 다시 읽고 서로의 차례는
# 읽지 않는다(결과는 장부·run.md·out/ 파일로 넘겨받는다). 장부를 모든 단계가 고치므로 동시에 돌리지 않는다.
# single: 예전처럼 daily-run.md 를 한 번에 돌린다(되돌림 스위치).
PHASES="${EXPANSION_PHASES:-fork}"
case "$PHASES" in single|fork) ;; *) PHASES=fork ;; esac
# 지시문을 EXPANSION_PROMPT 로 따로 고른 회차(첫 회차 first-run.md 등)는 절 구성이 daily-run.md 와 달라
# 단계 줄(「0~3절만」 등)이 맞지 않는다 — 그런 회차는 EXPANSION_PHASES 와 무관하게 한 번에 돌린다.
[ -z "${EXPANSION_PROMPT:-}" ] || PHASES=single
# 단계 안내 줄 — 운영자가 읽는 고정 문구다(작은따옴표 안: 백틱이 명령 치환으로 돌지 않게).
PHASE_LINE_A='【단계 A】 이번 호출은 0~3절만 한다. 3절을 마치면 run.md 에 `단계 A 끝` 한 줄을 쓰고 멈춘다. 4절 이후는 래퍼가 별도 호출로 시킨다.'
PHASE_LINE_B='【단계 B】 앞 대화(단계 A)에 이어 4·5절만 한다. 장부·run.md 는 파일에서 다시 읽고 시작한다. 끝나면 run.md 에 `단계 B 끝` 을 쓰고 멈춘다.'
PHASE_LINE_C='【단계 C】 앞 대화(단계 A)에 이어 7절만 한다. 장부·run.md 는 파일에서 다시 읽고 시작한다(단계 B 결과가 반영돼 있다). 끝나면 run.md 에 `단계 C 끝` 을 쓰고 멈춘다.'
PHASE_LINE_D='【단계 D】 앞 대화(단계 A)에 이어 6·8·9·10·11절만 한다. 장부·run.md·out/ 은 파일에서 다시 읽는다(단계 B·C 결과 반영). 카드 파일을 쓰고 11절 점검표를 마친 뒤 멈춘다.'

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
  if [ "$PHASES" = "single" ]; then
    echo "DRY: cd ${OPS_WT:-$REPO}; $CLAUDE_BIN -p --permission-mode auto --output-format json --model opus --max-budget-usd $MAX_BUDGET_USD --add-dir $REPO < $PROMPT_PATH (timeout ${TIMEOUT_S}s)"
  else
    echo "DRY: 단계 A: cd ${OPS_WT:-$REPO}; $CLAUDE_BIN -p --permission-mode auto --output-format json --model opus --max-budget-usd $MAX_BUDGET_USD --add-dir $REPO < $PROMPT_PATH + 단계 A 줄 (timeout ${TIMEOUT_S}s)"
    for p in B C D; do
      echo "DRY: 단계 $p: cd ${OPS_WT:-$REPO}; $CLAUDE_BIN -p --resume <A session_id> --fork-session --permission-mode auto --output-format json --model opus --max-budget-usd <cost(A)+남은 예산> --add-dir $REPO < 단계 $p 줄 (timeout 남은 시간)"
    done
  fi
  log_line OK "cost=0 dry=1 phases=$PHASES"
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

# Per-model cost + turn count from the result JSON (observation only — never used for OK/FAIL).
# Filled after the run; null until then and whenever the fields are missing or malformed.
TURNS_JSON=null
MODELS_JSON=null
MODELS_TXT=unknown
write_run() { # status cost(숫자|unknown) is_error
  local cost_json="$2"
  [ "$cost_json" != "unknown" ] || cost_json=null
  mkdir -p "$RUNS_DIR" 2>/dev/null || return 0
  printf '{"date":"%s","status":"%s","total_cost_usd":%s,"is_error":%s,"num_turns":%s,"model_cost_usd":%s}\n' \
    "$RUN_DATE" "$1" "$cost_json" "$3" "$TURNS_JSON" "$MODELS_JSON" > "$RUNS_DIR/$RUN_DATE.json" 2>/dev/null || true
}

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/expansion-loop.XXXXXX")"
OUT="$WORK_DIR/out.json"
ERR="$WORK_DIR/err.txt"

# 실패: FAIL 줄을 먼저 쓰고, 「오늘은 건너뜀」 카드를 올린 뒤 결과를 둘째 줄에 남긴다. 항상 exit 1.
APP_TOKEN_LIVE=0
fail() { # reason [cost]
  local cost="${2:-0}"
  # 단계 도중 실패면 앱 토큰이 아직 살아 있다 — 건너뜀 카드 게시 프로세스에는 넘기지 않는다.
  if [ "$APP_TOKEN_LIVE" -eq 1 ]; then unset GH_TOKEN; APP_TOKEN_LIVE=0; fi
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

# 앱 토큰은 회차 직전에 발급한다(수명 1시간). gh 와 git(전역 자격 도우미 = gh auth git-credential)이 GH_TOKEN 을 쓴다.
if [ "$APP_OFF" -eq 0 ]; then
  [ "$TIMEOUT_S" -le "$APP_TOKEN_TTL_S" ] || fail "시간 상한 ${TIMEOUT_S}s 가 앱 토큰 수명 ${APP_TOKEN_TTL_S}s 보다 길다"
  [ -s "$APP_KEY" ] || fail "앱 키 없음"
  APP_TOKEN="$(node "$APP_TOKEN_SCRIPT" "$APP_ID" "$APP_INSTALLATION_ID" "$APP_KEY" 2> "$WORK_DIR/app.err")" \
    || fail "앱 토큰 발급 실패 $(head -n 1 "$WORK_DIR/app.err" 2>/dev/null)"
  [ -n "$APP_TOKEN" ] || fail "앱 토큰 발급 실패 (빈 토큰)"
  unset GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
  export GH_TOKEN="$APP_TOKEN"
  APP_TOKEN_LIVE=1
  unset APP_TOKEN
fi

# 단계 결과 합산(관찰용 — OK/FAIL 판정에는 쓰지 않는다). 인자: 지금까지 돈 단계의 결과 JSON, A 가 맨 앞.
# 갈래(B·C·D)의 total_cost_usd·modelUsage 는 부모(A) 비용을 포함한 누적값이다(2026-11-21 실측) — 갈래 몫은 (갈래 − A),
# 0 아래는 0 으로 자른다. 한 단계라도 비용을 모르면 합계도 unknown. num_turns 는 보고된 값을 그대로 더한다
# (갈래의 num_turns 도 누적일 수 있다 — 미검증). 모델별 비용도 같은 방식(A 에 없던 모델은 A=0), 끝에서 소수 2자리.
# 출력(탭 구분): cost|unknown · cost(A)|unknown · turns JSON · 모델별 JSON · 모델별 글
aggregate_phases() {
  local agg
  agg="$(node -e '
const fs=require("fs");
const rd=f=>{try{const j=JSON.parse(fs.readFileSync(f,"utf8"));return j&&typeof j==="object"?j:null;}catch(e){return null;}};
const num=v=>typeof v==="number"&&Number.isFinite(v)?v:null;
const r6=x=>Math.round(x*1e6)/1e6;
const js=process.argv.slice(1).map(rd);
const costs=js.map(j=>j?num(j.total_cost_usd):null);
const a=costs[0];
let cost="unknown";
if(costs.every(c=>c!==null)){let t=a;for(const c of costs.slice(1))t+=Math.max(0,c-a);cost=String(r6(t));}
let turns=0;for(const j of js){if(!j||!Number.isInteger(j.num_turns)){turns=null;break;}turns+=j.num_turns;}
const usage=j=>{const mu=j&&j.modelUsage&&typeof j.modelUsage==="object"?j.modelUsage:null;if(!mu)return null;
const m=new Map();for(const[k,v]of Object.entries(mu))m.set(String(k).replace(/[^a-z0-9.-]/gi,"").slice(0,40),v&&num(v.costUSD));return m;};
const us=js.map(usage);
let m=null,txt="unknown";
if(us.every(u=>u!==null)){const base=us[0],tot=new Map(base);
for(const u of us.slice(1))for(const[k,fv]of u){const av=base.has(k)?base.get(k):0;const cur=tot.has(k)?tot.get(k):0;
tot.set(k,cur===null||fv===null||av===null?null:cur+Math.max(0,fv-av));}
m={};const parts=[];for(const[k,c]of tot){const v=c===null?null:Math.round(c*100)/100;m[k]=v;parts.push(k.replace(/^claude-/,"")+"="+(v===null?"?":v));}
if(parts.length)txt=parts.join(",");else m=null;}
console.log([cost,a===null?"unknown":String(a),JSON.stringify(turns),JSON.stringify(m),txt].join("\t"));' "$@" 2>/dev/null)" || agg=""
  if [ -n "$agg" ]; then
    COST="$(printf '%s' "$agg" | cut -f1)"
    A_COST="$(printf '%s' "$agg" | cut -f2)"
    TURNS_JSON="$(printf '%s' "$agg" | cut -f3)"
    MODELS_JSON="$(printf '%s' "$agg" | cut -f4)"
    MODELS_TXT="$(printf '%s' "$agg" | cut -f5)"
  else
    COST=unknown; A_COST=unknown; TURNS_JSON=null; MODELS_JSON=null; MODELS_TXT=unknown
  fi
  [ -n "$COST" ] || COST=unknown
}

# 단계 하나를 돌리고 판정한다. 실패면 fail(종료) — 반드시 주 셸에서 부를 것($(…) 안에서 부르면 exit 가 회차를 못 끝낸다).
# 시간: 회차 전체 마감(A 시작 + TIMEOUT_S)까지 남은 초. 예산: A 는 MAX, 갈래는 cost(A) + (MAX − 지금까지 쓴 돈).
# 갈래의 --max-budget-usd 가 누적 비용에 걸리는지는 미검증이다 — cost(A) 를 더하는 쪽이 안전하다(최악이면 상한이 cost(A) 만큼 느슨).
# cost(A) 나 지금까지 쓴 돈을 모르면 상한을 계산할 수 없다 — 느슨한 상한으로 돌리지 않고 「비용 불명」 FAIL 로 멈춘다.
COST=unknown
A_COST=unknown
PHASE_OUTS=()
DEADLINE_S=0
run_phase() { # letter stdin_file [resume_session_id]
  local letter="$1" inp="$2" sid="${3:-}" pfx="" out err left budget brc
  [ "$PHASES" = "single" ] || pfx="단계 $letter: "
  out="$WORK_DIR/out-$letter.json"
  err="$WORK_DIR/err-$letter.txt"
  if [ -z "$sid" ]; then
    DEADLINE_S=$(( $(date +%s) + TIMEOUT_S ))
    left="$TIMEOUT_S"
    budget="$MAX_BUDGET_USD"
  else
    left=$(( DEADLINE_S - $(date +%s) ))
    if [ "$left" -le 0 ]; then fail "${pfx}시간 초과" "$COST"; fi
    if [ "$COST" = "unknown" ] || [ "$A_COST" = "unknown" ]; then fail "${pfx}비용 불명" "$COST"; fi
    brc=0
    budget="$(node -e '
const [max,spent,a]=process.argv.slice(1);const m=Number(max),s=Number(spent),c=Number(a);
if(!Number.isFinite(m)||!Number.isFinite(s)||!Number.isFinite(c))process.exit(4);
const rem=m-s;if(!(rem>0))process.exit(3);
console.log(String(Math.round((c+rem)*1e6)/1e6));' "$MAX_BUDGET_USD" "$COST" "$A_COST" 2>/dev/null)" || brc=$?
    if [ "$brc" -eq 3 ]; then fail "${pfx}예산 소진" "$COST"; fi
    if [ "$brc" -ne 0 ] || [ -z "$budget" ]; then fail "${pfx}예산 계산 실패" "$COST"; fi
  fi
  if [ -z "$sid" ]; then
    run_grouped "$left" "$inp" "$out" "$err" \
      "$CLAUDE_BIN" -p --permission-mode auto --output-format json --model opus --max-budget-usd "$budget" --add-dir "$REPO"
  else
    run_grouped "$left" "$inp" "$out" "$err" \
      "$CLAUDE_BIN" -p --resume "$sid" --fork-session --permission-mode auto --output-format json --model opus --max-budget-usd "$budget" --add-dir "$REPO"
  fi
  OUT="$out"
  ERR="$err"
  PHASE_OUTS+=("$out")
  # 비용은 종료코드·타임아웃 판정보다 먼저 읽는다(best-effort) — 실패한 실행도 지출은 남겨야 한다.
  aggregate_phases "${PHASE_OUTS[@]}"

  # 실패 사유: claude 는 --output-format json 에서 오류 문구(예: 로그인 만료)를 stderr 가 아니라 결과 JSON 의
  # result 에 쓴다 — 그 앞부분을 사유에 붙인다(없으면 빈 값; 판정에는 쓰지 않는다).
  RES_SNIP="$(node -e '
const fs=require("fs");
try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
if(j&&typeof j.result==="string")console.log(j.result.replace(/\s+/g," ").slice(0,160));}catch(e){}' "$OUT" 2>/dev/null)" || RES_SNIP=""

  # 이 단계에 준 초를 적는다(single·단계 A 는 TIMEOUT_S, 갈래는 마감까지 남은 초).
  if [ "$RG_TIMEOUT" -ne 0 ]; then fail "${pfx}타임아웃 ${left}s" "$COST"; fi
  if [ "$RG_RC" -ne 0 ]; then fail "${pfx}claude exit=$RG_RC ${RES_SNIP:+$RES_SNIP | }$(tail -c 200 "$ERR" 2>/dev/null)" "$COST"; fi

  # node 의 stderr 는 버리지 않는다 — node 가 없거나 깨진 것을 「결과 JSON 파손」으로 오인하지 않게 첫 줄을 사유에 붙인다.
  PARSE_ERR="$WORK_DIR/parse.err"
  IS_ERR="$(node -e '
const fs=require("fs");
let j;
try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));}catch(e){process.exit(3);}
if(!j||typeof j!=="object"||typeof j.is_error!=="boolean")process.exit(3);
console.log(j.is_error?"1":"0");' "$OUT" 2> "$PARSE_ERR")" \
    || fail "${pfx}결과 JSON 파손 $(head -n 1 "$PARSE_ERR" 2>/dev/null)" "$COST"

  if [ "$IS_ERR" != "0" ]; then fail "${pfx}결과 is_error=true $RES_SNIP" "$COST"; fi
}

rm -f "$CARDS_FILE"
if [ "$PHASES" = "single" ]; then
  run_phase S "$PROMPT_PATH"
else
  { cat "$PROMPT_PATH" && printf '\n\n%s\n' "$PHASE_LINE_A"; } > "$WORK_DIR/in-A.md" || fail "단계 A: 입력 만들기 실패"
  printf '%s\n' "$PHASE_LINE_B" > "$WORK_DIR/in-B.md"
  printf '%s\n' "$PHASE_LINE_C" > "$WORK_DIR/in-C.md"
  printf '%s\n' "$PHASE_LINE_D" > "$WORK_DIR/in-D.md"
  run_phase A "$WORK_DIR/in-A.md"
  A_SID="$(node -e '
const fs=require("fs");
try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const s=j&&j.session_id;if(typeof s!=="string"||!/^[0-9a-f-]{36}$/.test(s))process.exit(3);console.log(s);}catch(e){process.exit(3);}' "$OUT" 2>/dev/null)" \
    || fail "단계 A 세션 없음" "$COST"
  # 갈래는 모두 A 의 세션에서 가른다(직전 갈래가 아니다) — B·C·D 는 서로의 차례를 다시 읽지 않는다.
  run_phase B "$WORK_DIR/in-B.md" "$A_SID"
  run_phase C "$WORK_DIR/in-C.md" "$A_SID"
  run_phase D "$WORK_DIR/in-D.md" "$A_SID"
fi
# 앱 토큰은 회차에만 준다 — 뒤의 카드 확인·게시 프로세스에는 넘기지 않는다.
if [ "$APP_TOKEN_LIVE" -eq 1 ]; then unset GH_TOKEN; APP_TOKEN_LIVE=0; fi

# 운영자가 쓴 카드 파일: 유효 JSON 이고 cards 배열이 비어 있지 않아야 한다.
node -e '
const fs=require("fs");
try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
process.exit(j&&Array.isArray(j.cards)&&j.cards.length>0?0:3);}catch(e){process.exit(3);}' "$CARDS_FILE" 2>/dev/null \
  || fail "no-cards" "$COST"

post_card "$CARDS_FILE"
if [ "$POST_RESULT" != "ok" ]; then
  write_run FAIL "$COST" true
  log_line FAIL "cost=$COST post=$POST_RESULT turns=$TURNS_JSON models=$MODELS_TXT"
  exit 1
fi

write_run OK "$COST" false
log_line OK "cost=$COST post=ok turns=$TURNS_JSON models=$MODELS_TXT phases=$PHASES"
exit 0
