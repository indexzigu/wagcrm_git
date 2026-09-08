#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# ── WAG Agent Worker 전용 런처 ──────────────────────────────────────────
# 이 워커는 `infra/selfhost/.env`(앱 크리덴셜, DATABASE_URL 이 전체 권한)를
# 절대 읽지 않는다. 반드시 별도 역할(`wag_agent_worker`, 최소권한)의
# 접속 문자열을 담은 `infra/selfhost/agent-worker.env` 만 읽는다 — 두 파일을
# 섞으면 워커가 domain write 권한을 가진 채로 조용히 기동된다(설치 패킷
# `task-8-install-packet.md` §A-2-1 MEDIUM-2, 이 스크립트가 그 위험의
# 1차 방어선이다). 이 파일은 git 미추적이며 레포는 PUBLIC 이므로 값은 절대
# echo/print/log 하지 않는다(P0).
#
# ⚠️ 이 래퍼의 문자열 비교는 **신원 확인이 아니다.** 같은 전체권한 계정이라도
# 접속 옵션 하나만 다르면 "앱과 다르다"로 통과한다. 실제 신원은 워커 본체가
# 기동 직후 DB 에 직접 묻는다(`src/lib/agent-worker/db-identity.ts` —
# `current_user`/`session_user` 가 `wag_agent_worker` 가 아니면 기동 중단).
# 두 방어선은 보는 것이 다르므로 어느 한쪽으로 합치지 말 것.
ENV_FILE="infra/selfhost/agent-worker.env"
APP_ENV_FILE="infra/selfhost/.env"

# 기동 거부는 전부 stderr 로 나가고 launchd 가 그것을 `agent-worker.err.log` 에
# 모은다 — 런북의 상태 확인이 `out.log` 만 가리키고 있어 "로그는 조용한데 워커가
# 없다"로 보이던 함정을 이 안내가 막는다. plist 는 KeepAlive 라 원인을 고치기
# 전까지 ThrottleInterval(10초)마다 같은 실패가 되풀이된다.
die() {
  echo "치명적 오류: $1" >&2
  echo "이 오류는 ${HOME:-~}/selfhost/logs/agent-worker.err.log 에 기록됩니다(상태 확인 시 out.log 가 아니라 이 파일을 볼 것). launchd 는 10초마다 재시도하므로 원인을 고치기 전까지 같은 줄만 쌓입니다." >&2
  exit 1
}

if [ ! -f "$ENV_FILE" ]; then
  die "$ENV_FILE 이 없습니다. 워커 전용 DATABASE_URL(wag_agent_worker role 접속 문자열)만 담아 새로 만드세요 — 앱 .env 를 복사하지 마세요."
fi

# ── xtrace 봉인 구간 시작 ───────────────────────────────────────────────
# `bash -x infra/selfhost/run-agent-worker.sh` 로 들여다보면 셸이 확장 결과를
# 전부 stderr 에 찍는다 — 그 순간 위 「값은 절대 출력하지 않는다」 약속이 깨져
# 접속 문자열이 그대로 로그에 남는다(디버깅하려던 사람이 스스로 값을 흘린다).
# 값을 다루는 구간에서만 추적을 끄고, 원래 켜져 있었으면 구간 끝에서 되살린다.
xtrace_was_on=0
case "$-" in
  *x*) xtrace_was_on=1; set +x ;;
esac

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

if [ -z "${DATABASE_URL:-}" ]; then
  die "$ENV_FILE 에 DATABASE_URL 이 비어 있습니다. wag_agent_worker role 접속 문자열을 채우세요."
fi

# 앱 .env 와 같은 접속 문자열이면 워커가 전체 권한으로 기동된다 — 값 자체는
# 어디에도 출력하지 않고 셸 변수 비교로만 판정한다.
if [ -f "$APP_ENV_FILE" ]; then
  APP_DATABASE_URL="$(
    # ⚠️ `unset` 이 이 서브셸의 본질이다. 위 source 가 DATABASE_URL 을 export
    # 했으므로, 앱 .env 에 그 키가 **없으면** 아래 `${DATABASE_URL:-}` 는 앱 값이
    # 아니라 **워커 자기 값**을 되돌려준다 — 그러면 "앱과 동일합니다"라는 사실과
    # 다른 이유로 기동이 거부되고, KeepAlive 가 10초마다 그 거짓 사유를 반복
    # 기록한다. 실제 원인(앱 .env 에 키가 없음)은 어디에도 안 남는다.
    unset DATABASE_URL
    set -a
    # shellcheck disable=SC1090
    . "$APP_ENV_FILE"
    set +a
    printf '%s' "${DATABASE_URL:-}"
  )"
  if [ -n "$APP_DATABASE_URL" ] && [ "$APP_DATABASE_URL" = "$DATABASE_URL" ]; then
    unset APP_DATABASE_URL
    die "$ENV_FILE 의 DATABASE_URL 이 $APP_ENV_FILE 과 동일합니다 — 워커는 반드시 별도의 최소권한 role(wag_agent_worker) 접속 문자열을 써야 합니다. 값은 출력하지 않습니다."
  fi
  unset APP_DATABASE_URL
fi

if [ "$xtrace_was_on" = 1 ]; then set -x; fi
# ── xtrace 봉인 구간 끝 ─────────────────────────────────────────────────

# addon 경로는 워커 본체와 **같은 규칙**으로 정한다(`scripts/agent-worker.ts` 가
# `WAG_AGENT_WORKER_PEER_CRED_ADDON` 을 `loadNativePeerCredentialProvider` 에
# 그대로 넘긴다). 래퍼만 기본 경로를 고집하면 런북(`infra/selfhost/README.md`
# 「소켓 경로 메모」)이 권하는 그 오버라이드를 켠 순간, 워커는 기동할 수 있는데
# 래퍼가 먼저 "addon 이 없다"로 막는다.
ADDON="${WAG_AGENT_WORKER_PEER_CRED_ADDON:-src/lib/agent-worker/native/peer-cred/build/Release/peer_cred.node}"
if [ ! -f "$ADDON" ]; then
  die "네이티브 addon($ADDON)이 빌드되어 있지 않습니다. 다음 명령으로 먼저 빌드하세요: npm run agent-worker:build-native"
fi

export NODE_ENV=production

# launchd GUI 에이전트의 기본 PATH 는 /usr/bin:/bin:/usr/sbin:/sbin 뿐이다
# (run-app.sh 와 동일한 근거 — infra/selfhost/README.md 「launchd/cron 이
# 실행하는 스크립트는 PATH 를 직접 해결해야 한다」). Homebrew 로 설치한
# node 는 이 PATH 에 없어 exec 가 즉시 "command not found" 로 죽고
# KeepAlive 가 ThrottleInterval(기본 10초)마다 조용히 재시도만 반복하는
# 크래시루프가 된다.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  die "node 실행파일을 찾을 수 없습니다 (PATH=$PATH). node 설치 경로를 확인하고 이 스크립트의 PATH 후보 목록을 갱신하세요."
fi

# 방어적 mkdir: launchd 는 StandardOutPath/StandardErrorPath 의 상위
# 디렉터리를 만들어주지 않는다 — run-app.sh 와 동일한 근거.
mkdir -p "$HOME/selfhost/logs"

# 레포 로컬 tsx 만 쓴다(전역 도구 금지, package.json 의 다른 스크립트들과
# 동일하게 `node --import tsx` 로 로드한다 — bare specifier `tsx` 는 이 cwd 의
# node_modules 에서 해석된다). node_modules/.bin/tsx 가 없으면 npm ci 가 안 된
# 것이므로 exec 전에 명확한 오류로 중단한다. 실행형은 Task 5 의 실측 런타임
# 증거(task-5-report.md "Runtime evidence")와 동일하다.
TSX_BIN="node_modules/.bin/tsx"
if [ ! -x "$TSX_BIN" ]; then
  die "$TSX_BIN 이 없습니다. 먼저 npm ci 를 실행하세요."
fi

exec "$NODE_BIN" --import tsx scripts/agent-worker.ts
