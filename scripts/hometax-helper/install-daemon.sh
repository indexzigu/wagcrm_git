#!/bin/bash
# 홈택스 헬퍼를 **상시 기동**으로 설치한다(macOS LaunchAgent).
#
# ⚠️ **기본 운용은 더 이상 이쪽이 아니다 — `install-url-scheme.sh`(온디맨드)를 쓴다.**
# 발행은 월 10회 미만인데 상시 기동은 한 달 내내 프로세스를 띄워 둔다. 이제 CRM 의
# 「홈택스 발행」 클릭이 `hometax-helper://` URL 스킴으로 헬퍼를 깨우고(실측 기동 약
# 4초), 헬퍼는 유휴 시 스스로 내려간다(`idle.ts`).
#
# 이 파일은 **되돌릴 여지로 남겨 둔다** — 스킴 경로가 어떤 이유로든 막히면(브라우저
# 정책 변경 등) 여기로 되돌아올 수 있어야 하기 때문이다. 상시 기동으로 되돌릴 때는
# 유휴 자동 종료도 함께 꺼야 한다: 아래 plist 의 EnvironmentVariables 에
# `HOMETAX_HELPER_IDLE_MINUTES=0` 을 넣거나, 그러지 않으면 데몬이 30분마다 스스로
# 내려가고 launchd 가 다시 띄우는 무의미한 왕복이 된다.
#
# ## 왜 만들었나(당시 근거)
#
# 오너가 원하는 흐름은 「CRM 에서 발행을 누르면 알아서 창이 뜨고 채워진다」다. 그런데
# **웹페이지는 로컬 프로세스를 시작시킬 수 없다** — 브라우저 보안 경계라 코드로 우회할
# 수 없고, 이미 떠 있는 서버에 요청만 보낼 수 있다. 그래서 「누르면 켜진다」 대신
# **「항상 켜져 있다」** 로 같은 체감을 만든다.
#
# 데몬 모드에서는 기동 시 창을 열지 않는다(`HOMETAX_HELPER_DAEMON=1`) — 로그인할 때마다
# 홈택스 창이 튀어나오면 안 된다. 창은 **첫 발행 요청 때** 열린다.
#
# ⛔ 자동 로그인은 하지 않는다. 인증서 비밀번호는 사람이 누른다 — 이 도구의 존재 이유다
# (`guards.ts`). 영속 프로필이 세션을 유지하므로 실제로 로그인할 일은 드물다.
#
# ## 쓰는 법
#
#   bash scripts/hometax-helper/install-daemon.sh          # 설치 + 즉시 기동
#   bash scripts/hometax-helper/install-daemon.sh --remove # 제거
#
set -euo pipefail

LABEL="kr.ygrd.hometax-helper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="$HOME/.wag-crm"

if [[ "${1:-}" == "--remove" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "제거했습니다: $PLIST"
  exit 0
fi

# LaunchAgent 는 로그인 셸이 아니라 PATH 가 얕다 — 절대 경로를 쓴다.
#
# 🪤 `npm run` 을 거치지 않고 **tsx 를 직접** 실행한다. npm 래퍼는 자기 몫으로 node
# 프로세스를 하나 더 띄우는데(실측 RSS 64MB), 상시 기동이라 그 비용이 계속 남는다.
# 실행 결과는 같다(`package.json` 의 hometax:helper 가 하는 일이 tsx 실행이다).
NODE_BIN="$(command -v node)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node 를 찾지 못했습니다 — PATH 를 확인하세요." >&2
  exit 1
fi

# 🪤 워크트리에는 자체 `node_modules` 가 없다 — 메인 레포 것을 공유한다. 그래서
# `$REPO/node_modules` 만 보면 워크트리에서 설치가 실패한다. 상위로 올라가며 찾는다.
#
# ⛔ `npm exec -- which tsx` 로 물어보는 방법을 썼다가 **설치 스크립트가 매달렸다**
# (2026-08-06 실측, 3분 타임아웃 — 그 사이 데몬이 내려간 채로 남았다). 경로 하나
# 찾는 데 패키지 매니저를 부를 이유가 없다.
TSX_BIN=""
_dir="$REPO"
while [[ "$_dir" != "/" ]]; do
  if [[ -x "$_dir/node_modules/.bin/tsx" ]]; then TSX_BIN="$_dir/node_modules/.bin/tsx"; break; fi
  _dir="$(dirname "$_dir")"
done
if [[ ! -x "${TSX_BIN:-}" ]]; then
  echo "tsx 를 찾지 못했습니다 — 메인 레포에서 npm install 을 했는지 확인하세요." >&2
  exit 1
fi

mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <!-- 🪤 node 를 **명시**한다. tsx 는 node_modules 안의 심볼릭 링크 + `#!/usr/bin/env
         node` 형태라, launchd 의 얕은 환경에서 직접 exec 하면 EIO 로 실패했다(실측). -->
    <string>$NODE_BIN</string>
    <string>$TSX_BIN</string>
    <string>scripts/hometax-helper/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- 기동 시 창을 열지 않게 한다(첫 발행 요청 때 연다). -->
    <key>HOMETAX_HELPER_DAEMON</key><string>1</string>
    <!-- 상시 기동에서는 유휴 자동 종료를 끈다. 안 끄면 30분마다 스스로 내려가고
         KeepAlive 가 다시 띄우는 무의미한 왕복이 된다(창까지 다시 뜬다). -->
    <key>HOMETAX_HELPER_IDLE_MINUTES</key><string>0</string>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- 죽으면 되살린다. 다만 즉시 재시도 폭주를 막기 위해 최소 간격을 둔다. -->
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/helper.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/helper.log</string>
</dict>
</plist>
PLIST_EOF

# ⛔ bootout 직후 곧바로 bootstrap 하면 실패한다(2026-08-06 실측: `Bootstrap failed:
# 5: Input/output error`). 헬퍼는 SIGTERM 을 받으면 **브라우저 컨텍스트를 닫고** 나가느라
# 몇 초가 걸리는데, 그 사이엔 서비스가 아직 등록돼 있어 등록이 거부된다. 증상이 고약한
# 이유는 **기존 데몬은 이미 내려간 뒤**라 재설치가 서비스를 죽인 채로 끝난다는 것이다.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
for _ in $(seq 1 30); do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 1
done

if ! launchctl bootstrap "gui/$(id -u)" "$PLIST"; then
  echo "등록에 실패했습니다 — 잠시 뒤 다시 실행해 보세요." >&2
  exit 1
fi

echo "설치했습니다: $PLIST"
echo "로그: $LOG_DIR/helper.log"
echo
echo "확인:"
echo "  curl -s http://127.0.0.1:9410/health"
