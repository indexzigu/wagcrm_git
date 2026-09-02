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
ENV_FILE="infra/selfhost/agent-worker.env"
APP_ENV_FILE="infra/selfhost/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "치명적 오류: $ENV_FILE 이 없습니다. 워커 전용 DATABASE_URL(wag_agent_worker role 접속 문자열)만 담아 새로 만드세요 — 앱 .env 를 복사하지 마세요." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

if [ -z "${DATABASE_URL:-}" ]; then
  echo "치명적 오류: $ENV_FILE 에 DATABASE_URL 이 비어 있습니다. wag_agent_worker role 접속 문자열을 채우세요." >&2
  exit 1
fi

# 앱 .env 와 같은 접속 문자열이면 워커가 전체 권한으로 기동된다 — 값 자체는
# 어디에도 출력하지 않고 셸 변수 비교로만 판정한다.
if [ -f "$APP_ENV_FILE" ]; then
  APP_DATABASE_URL="$(
    set -a
    # shellcheck disable=SC1090
    . "$APP_ENV_FILE"
    set +a
    printf '%s' "${DATABASE_URL:-}"
  )"
  if [ -n "$APP_DATABASE_URL" ] && [ "$APP_DATABASE_URL" = "$DATABASE_URL" ]; then
    echo "치명적 오류: $ENV_FILE 의 DATABASE_URL 이 $APP_ENV_FILE 과 동일합니다 — 워커는 반드시 별도의 최소권한 role(wag_agent_worker) 접속 문자열을 써야 합니다. 값은 출력하지 않습니다." >&2
    exit 1
  fi
  unset APP_DATABASE_URL
fi

ADDON="src/lib/agent-worker/native/peer-cred/build/Release/peer_cred.node"
if [ ! -f "$ADDON" ]; then
  echo "치명적 오류: 네이티브 addon($ADDON)이 빌드되어 있지 않습니다. 다음 명령으로 먼저 빌드하세요: npm run agent-worker:build-native" >&2
  exit 1
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
  echo "치명적 오류: node 실행파일을 찾을 수 없습니다 (PATH=$PATH). node 설치 경로를 확인하고 이 스크립트의 PATH 후보 목록을 갱신하세요." >&2
  exit 1
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
  echo "치명적 오류: $TSX_BIN 이 없습니다. 먼저 npm ci 를 실행하세요." >&2
  exit 1
fi

exec "$NODE_BIN" --import tsx scripts/agent-worker.ts
