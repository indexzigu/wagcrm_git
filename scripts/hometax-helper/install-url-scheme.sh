#!/bin/bash
# 홈택스 헬퍼를 **온디맨드**로 바꾼다 — `hometax-helper://` URL 스킴을 등록한다.
#
# ## 왜 이 방식인가 (실측으로 고른 길)
#
# 웹페이지는 로컬 프로세스를 **직접** 시작시킬 수 없다(브라우저 보안 경계). 그래서 처음엔
# LaunchAgent 상시 기동으로 「누르면 켜진다」를 흉내 냈는데, 발행이 월 10회 미만이라
# 한 달 내내 떠 있는 대가가 과했다. 대안 5가지(launchd 소켓 활성화 · URL 스킴 · Chrome
# 확장 + Native Messaging · ProcessType 최적화 · 단일 바이너리) 중 **URL 스킴**이
# 오너 선택이고, 아래 4가지를 실제로 만들어 확인했다(2026-08-06):
#
#   1. 표준 위치(`~/Applications`)에 `.app` 을 두고 `lsregister -f` 로 등록하면 스킴이
#      동작한다. ⛔ **`/private/tmp` 같은 임시 경로는 등록돼도 실행이 거부된다**
#      (`kLSApplicationNotFoundErr`) — 그래서 이 스크립트는 표준 위치에만 설치한다.
#   2. Chrome 에서 처음 스킴을 열면 확인 다이얼로그가 뜨고 「항상 허용」 체크가 있다.
#   3. 저장 뒤에도 **콘솔에서 프로그램적으로** 다시 열면 막힌다
#      (`user gesture is required`) — 권한 문제가 아니라 Chrome 이 외부 프로토콜에
#      사용자 제스처를 요구하기 때문이다.
#   4. **실제 버튼 클릭**으로 트리거하면 확인창 없이 조용히 실행된다.
#
# 즉 CRM 의 「홈택스 발행」 클릭(진짜 사용자 제스처) 안에서 스킴을 열면 된다.
#
# ## 이 앱이 하는 일 — 깨우기뿐이다
#
# URL 의 쿼리 파라미터로 **데이터를 넘기지 않는다.** macOS 는 URL 을 Apple Event 로
# 전달해서 셸 스크립트가 argv 로 받지 못한다(실측). 발행 데이터는 종전대로 CRM 이
# `POST /issue` 로 보낸다 — 이 앱은 헬퍼가 떠 있는지 보고, 없으면 띄우고 끝난다.
#
# ## 쓰는 법
#
#   bash scripts/hometax-helper/install-url-scheme.sh              # 설치(+ 상시 기동 제거)
#   bash scripts/hometax-helper/install-url-scheme.sh --keep-daemon # 설치하되 상시 기동은 유지
#   bash scripts/hometax-helper/install-url-scheme.sh --remove     # 제거
#
# `--keep-daemon` 은 **되돌릴 여지를 남기는 전환용**이다 — 온디맨드가 실사용에서
# 충분히 빠른지 확인하는 동안 상시 기동을 함께 둘 수 있다(둘이 겹쳐도 나중 프로세스가
# `EADDRINUSE` 를 보고 조용히 물러난다).
#
set -euo pipefail

APP_NAME="HometaxHelper"
APP_DIR="$HOME/Applications/$APP_NAME.app"
DAEMON_LABEL="kr.ygrd.hometax-helper"
DAEMON_PLIST="$HOME/Library/LaunchAgents/$DAEMON_LABEL.plist"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="$HOME/.wag-crm"
PORT="${HOMETAX_HELPER_PORT:-9410}"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

if [[ "${1:-}" == "--remove" ]]; then
  [[ -x "$LSREGISTER" ]] && "$LSREGISTER" -u "$APP_DIR" >/dev/null 2>&1 || true
  rm -rf "$APP_DIR"
  echo "제거했습니다: $APP_DIR"
  exit 0
fi

# 절대 경로를 굽는다 — LaunchServices 가 띄우는 프로세스는 로그인 셸이 아니라 PATH 가
# 얕다(LaunchAgent 와 같은 함정).
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node 를 찾지 못했습니다 — PATH 를 확인하세요." >&2
  exit 1
fi

# 🪤 워크트리에는 자체 `node_modules` 가 없다(메인 레포 것을 공유한다) — 상위로 올라가며
# 찾는다. ⛔ `npm exec -- which tsx` 는 쓰지 말 것: 설치 스크립트가 3분 매달린 실측이 있다.
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

mkdir -p "$APP_DIR/Contents/MacOS" "$LOG_DIR"

cat > "$APP_DIR/Contents/Info.plist" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>kr.ygrd.hometax-helper-launcher</string>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <!-- Dock·앱 전환기에 뜨지 않는다 — 깨우기 전용 도우미다. -->
  <key>LSUIElement</key><true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>kr.ygrd.hometax-helper</string>
      <key>CFBundleURLSchemes</key>
      <array><string>hometax-helper</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST_EOF

# 헬퍼를 실제로 돌리는 스크립트 — **Terminal 창에서 보이게** 돈다(오너 제안 2026-08-09).
#
# 종전에는 nohup 백그라운드라 헬퍼가 도는지·죽었는지 오너가 볼 수 없었고, 임의로
# 종료할 방법도 없었다(pkill 을 알아야 했다). `.command` 를 `open` 으로 열면
# Terminal 이 새 창에서 실행한다 — 로그가 실시간으로 보이고, Ctrl+C 로 종료할 수
# 있다(SIGINT → 헬퍼가 쿠키를 지키며 정상 종료). `open` 은 LaunchServices 경유라
# 자동화 권한 팝업이 없다.
cat > "$APP_DIR/Contents/MacOS/run-helper.command" <<RUN_EOF
#!/bin/bash
# 자동 생성됨 — 고치지 말고 install-url-scheme.sh 를 다시 실행하세요.
cd "$REPO" || exit 1
export HOMETAX_HELPER_PORT="$PORT"
# ⛔ **깨우기는 프로세스만 띄우고 홈택스 창은 열지 않는다.** 스킴 실행에는 발신자를
# 가르는 장치가 없어서(CORS 화이트리스트는 HTTP 엔드포인트만 본다), 창을 곧바로 열면
# 스킴을 여는 것만으로 **로그인된 홈택스 창이 화면에 떠 버린다.** 창은 CRM 이 뒤이어
# 보내는 POST /issue 가 연다 — 그 경로는 오리진 검사를 지난다.
export HOMETAX_HELPER_DAEMON=1
clear
echo "── 홈택스 헬퍼 ─────────────────────────────────"
echo "이 창을 닫거나 Ctrl+C 를 누르면 헬퍼가 종료됩니다."
echo "(로그는 $LOG_DIR/helper.log 에도 이어서 기록됩니다)"
echo "────────────────────────────────────────────────"
# tee: 화면에 보이면서 기존 로그 파일에도 이어 쓴다. Ctrl+C(SIGINT)는 파이프 전체에
# 전달돼 헬퍼가 쿠키를 지키며 정상 종료한다.
"$NODE_BIN" "$TSX_BIN" scripts/hometax-helper/index.ts 2>&1 | tee -a "$LOG_DIR/helper.log"
RUN_EOF
chmod +x "$APP_DIR/Contents/MacOS/run-helper.command"

cat > "$APP_DIR/Contents/MacOS/launcher" <<LAUNCHER_EOF
#!/bin/bash
# 자동 생성됨 — 고치지 말고 install-url-scheme.sh 를 다시 실행하세요.
#
# 하는 일은 하나다: 헬퍼가 살아 있으면 아무것도 하지 않고, 없으면 **Terminal 창에서**
# 띄운다(오너 제안 2026-08-09 — 백그라운드는 실패해도 안 보이고 임의 종료도 안 됐다).
# ⛔ URL 인자는 받지 않는다(Apple Event 로 오므로 argv 에 없다) — 데이터는 CRM 이
#    HTTP 로 보낸다. 이 앱은 "깨우기 전용"이다.
if curl -s -m 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  exit 0
fi
# \`open\` 은 LaunchServices 경유라 자동화 권한 팝업이 없다(AppleScript 로 Terminal 을
# 제어하는 방식은 권한 팝업이 떠서 쓰지 않는다 — Finder 팝업과 같은 부류).
open "$APP_DIR/Contents/MacOS/run-helper.command"
exit 0
LAUNCHER_EOF
chmod +x "$APP_DIR/Contents/MacOS/launcher"

# 등록. `-f` 는 강제 재등록 — 경로·plist 를 바꿔 다시 설치할 때 옛 등록이 남아 스킴이
# 엉뚱한 번들로 가는 것을 막는다.
if [[ ! -x "$LSREGISTER" ]]; then
  echo "lsregister 를 찾지 못했습니다 — macOS 가 맞는지 확인하세요." >&2
  exit 1
fi
"$LSREGISTER" -f "$APP_DIR"

# 상시 기동(LaunchAgent)은 이제 필요 없다 — 스킴이 그 역할을 대신한다. 남겨 두면
# 온디맨드로 바꾼 의미가 없으므로(계속 떠 있다) 여기서 함께 내린다.
if [[ "${1:-}" == "--keep-daemon" ]]; then
  echo "상시 기동(LaunchAgent)은 그대로 두었습니다 — 나중에 --remove 없이 다시 실행하면 내려갑니다."
elif [[ -f "$DAEMON_PLIST" ]]; then
  launchctl bootout "gui/$(id -u)/$DAEMON_LABEL" 2>/dev/null || true
  rm -f "$DAEMON_PLIST"
  echo "상시 기동(LaunchAgent)을 제거했습니다: $DAEMON_PLIST"
fi

echo "설치했습니다: $APP_DIR"
echo "로그: $LOG_DIR/helper.log"
echo
echo "확인:"
echo "  open 'hometax-helper://start' && sleep 5 && curl -s http://127.0.0.1:$PORT/health"
echo
echo "⚠️ Chrome 에서 처음 한 번은 확인창이 뜹니다 — 「항상 허용」을 체크하고 열어 주세요."
