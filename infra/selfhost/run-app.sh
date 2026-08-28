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
# ── 서빙 트리는 빌드 트리와 분리한다 (실사고 2026-08-29) ──
# 종전에는 `.next/standalone/server.js` 를 직접 실행했다. 그런데 deploy.sh 는 앱을
# **내리지 않은 채** `npm run build` 를 돌리고, Next 는 `cleanDistDir: true` 라 빌드
# 시작 시 `.next` 를 통째로 비운다. 그동안 살아 있는 구 프로세스가 지연 로딩하려던
# 청크·클라이언트 참조 매니페스트가 사라져 그 사이 들어온 요청이 전부 죽는다.
# 실측(2026-08-29): 빌드 00:00:03 시작 ~ 00:01:06 완료 = **63초** 구간, 그 안에서
# InvariantError 6건·ChunkLoadError 2건이 났다. 에러가 "없다"고 말한 청크는 18초 뒤
# 실재했다 — 빌드 누락이 아니라 그 순간의 부재였다.
# 재현: 서빙 중 산출물의 `.next/server/chunks` 를 지우고 첫 요청을 보내면 프로덕션과
# **동일한** 에러(같은 청크명·같은 모듈 id)가 그대로 나온다.
# 그래서 deploy.sh 는 완성된 산출물을 `.live/releases/<sha>` 로 옮기고 `.live/current`
# 심링크만 바꿔 끼운다 — 구 프로세스가 보던 릴리스는 교체 후에도 그대로 남는다.
LIVE_ENTRY="$PWD/.live/current/server.js"
if [ -e "$LIVE_ENTRY" ]; then
  exec "$NODE_BIN" "$LIVE_ENTRY"
fi

# 폴백: 아직 릴리스가 없다.
# ⛔ 여기서 exit 하지 말 것 — plist 가 KeepAlive 라 ThrottleInterval(기본 10초)마다
# 재시도하는 **크래시루프**가 되어 서비스가 통째로 멈춘다. 가용성을 지키고 대신
# **시끄럽게** 남긴다.
#
# ⚠️ **이 경로로 뜨면 위 경합이 그대로 살아 있다.** 다만 무증상으로 **오래** 굳지는
# 않는다 — 그 이유가 폴백 설계의 핵심이라 적어 둔다:
#   · deploy.sh 는 산출물을 **`mv`** 로 옮긴다(복사가 아니라). 그래서 릴리스 방식으로
#     한 번이라도 배포되면 `.next/standalone` 자체가 **사라진다** → 이 폴백은 조건이
#     성립하지 않고, 만약 `.live/current` 까지 없어지면 아래 exec 가 실패해 크래시루프,
#     즉 **시끄러운 고장**이 된다(조용히 옛 빌드를 계속 서빙하는 상태가 아니다).
#   · 따라서 「폴백으로 조용히 서빙」이 가능한 구간은 **이 변경이 착지한 직후 한 번**
#     뿐이다: 그 배포는 구 deploy.sh 가 돌던 중에 새 run-app.sh 를 받으므로 릴리스가
#     아직 없다. 다음 배포가 자동으로 해소한다.
#   · 그 한 번을 포함해, deploy.sh 안전장치 ⑧ 이 kickstart 직후 "릴리스 경로로 떴는가"를
#     확인하고 아니면 배포를 실패시킨다(마커 미갱신 → 다음 실행이 재시도).
# ⛔ 이 폴백을 "안전망이니 그대로 두자"로 읽고 위 `mv` 를 `cp` 로 바꾸지 말 것 —
#    그러면 `.next/standalone` 이 늘 남아 폴백이 **영구히 성립 가능**해지고, 위 세 줄의
#    보장이 통째로 사라진다(무증상 열화로 바뀐다).
echo "[run-app] ⚠️ 경고: $LIVE_ENTRY 가 없어 빌드 트리(.next/standalone)에서 직접 서빙합니다 — 배포 중 산출물 교체 경합에 노출된 상태입니다. deploy.sh 를 한 번 돌리면 해소됩니다." >&2
exec "$NODE_BIN" .next/standalone/server.js
