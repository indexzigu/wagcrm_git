#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# 실값은 미추적 파일에서만 읽는다 (레포는 PUBLIC — P0)
set -a; . infra/selfhost/.env; set +a
# APP_PORT 를 주면 그 포트로 뜬다(프리뷰 레인). 안 주면 프로덕션 기본값 3000.
PORT="${APP_PORT:-3000}"
export NODE_ENV=production PORT HOSTNAME=127.0.0.1
# 방어적 mkdir: launchd 는 StandardOutPath/StandardErrorPath 의 상위
# 디렉터리를 만들어주지 않는다. 이 줄은 이후 재시작(kickstart)에서
# 디렉터리가 지워진 경우를 방어할 뿐이다 — launchd 는 이 스크립트를
# exec 하기 "전에" 이미 로그 파일을 열려고 시도하므로, 최초 부팅 실패는
# 이 줄로 못 막는다(README 최초 기동 순서의 별도 mkdir 단계가 그걸 막는다.
# 그 단계를 "중복"이라 여겨 지우지 말 것).
mkdir -p "$HOME/selfhost/logs"

# launchd GUI 에이전트의 기본 PATH 는 /usr/bin:/bin:/usr/sbin:/sbin 뿐이다
# (실측: env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin bash -c 'command -v node'
# → not found). Homebrew(/usr/local/bin, Apple Silicon 은
# /opt/homebrew/bin)로 설치한 node 는 이 PATH 에 없어 `exec node ...` 가
# "command not found" 로 즉시 죽고, KeepAlive 가 ThrottleInterval(기본
# 10초)마다 조용히 재시도만 반복하는 크래시루프가 된다. 인터랙티브 셸의
# PATH 에 기대지 않도록 후보 경로를 직접 추가한 뒤 실제 존재를 확인한다 —
# node 설치 위치가 바뀌면(nvm 전환 등) 아래 후보 목록을 갱신할 것.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "치명적 오류: node 실행파일을 찾을 수 없습니다 (PATH=$PATH). node 설치 경로를 확인하고 이 스크립트의 PATH 후보 목록을 갱신하세요." >&2
  exit 1
fi
exec "$NODE_BIN" .next/standalone/server.js
