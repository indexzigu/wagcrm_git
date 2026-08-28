#!/bin/bash
# WAG 서버 메뉴바 앱을 빌드 → ~/Applications 설치 → launchd 자동 시작 등록까지
# 한 번에 한다. 멱등(재실행 안전). 뼈대는 ticket-board
# scripts/install-menubar-app.sh 의 이식이다.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LABEL="kr.ygrd.wagcrm.menubar"
APPS_DIR="$HOME/Applications"
APP_NAME="WagServerBar.app"
INSTALLED_APP="$APPS_DIR/$APP_NAME"
EXECUTABLE="$INSTALLED_APP/Contents/MacOS/WagServerBar"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_PATH="$HOME/Library/Logs/wagserverbar.log"

# 라벨 이름 가드 — 아래 bootout 이 엉뚱한 라벨(특히 프로덕션 앱)을 잡지 않게 한다.
# preview.sh 의 관례를 따른다.
case "$LABEL" in
  kr.ygrd.wagcrm.menubar) ;;
  *) echo "[install] 중단: 라벨이 비정상입니다($LABEL)" >&2; exit 1 ;;
esac

echo "[install] 1/4: 빌드 (infra/selfhost/menubar/build.sh)"
"$REPO_ROOT/infra/selfhost/menubar/build.sh"

BUILT_APP="$REPO_ROOT/infra/selfhost/menubar/build/$APP_NAME"
if [ ! -d "$BUILT_APP" ]; then
  echo "[install] 오류: 빌드 결과가 없습니다: $BUILT_APP" >&2
  exit 1
fi

echo "[install] 2/4: 설치 ($INSTALLED_APP)"
mkdir -p "$APPS_DIR"

if pgrep -x "WagServerBar" >/dev/null 2>&1; then
  echo "[install] 실행 중인 WagServerBar 종료"
  pkill -x WagServerBar 2>/dev/null || true
  sleep 1
fi

rm -rf "$INSTALLED_APP"
cp -R "$BUILT_APP" "$INSTALLED_APP"

echo "[install] 3/4: launchd 에이전트 등록 ($PLIST)"
mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$EXECUTABLE</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_PATH</string>
  <key>StandardErrorPath</key><string>$LOG_PATH</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# bootout 은 비동기다 — 빠져나가는 중인 서비스와 경합하면 bootstrap 이 실패한다
# (preview.sh 가 밟은 실사고와 같은 패턴). unload 완료를 최대 15초 폴링한다.
for _ in $(seq 1 30); do
  launchctl list "$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "[install] 4/4: 기동 확인 (2초 대기 후 pgrep)"
sleep 2

if pgrep -x "WagServerBar" >/dev/null 2>&1; then
  echo "[install] 확인됨: WagServerBar 프로세스가 실행 중입니다."
  echo "[install] 등록 완료. 로그: $LOG_PATH"
else
  echo "[install] 경고: 2초 대기 후에도 WagServerBar 프로세스가 보이지 않습니다." >&2
  echo "[install] launchd 는 등록됐지만 실제 기동은 확인되지 않았습니다. 로그를 확인하세요: $LOG_PATH" >&2
  exit 1
fi
