#!/bin/bash
# WagServerBar 메뉴바 앱을 macapp/Sources/*.swift 로부터 빌드해
# macapp/build/WagServerBar.app 번들을 만든다. 멱등(재실행 안전) — 매번 build/ 를
# 지우고 새로 만든다.
#
# 외부 의존성 0: swiftc + codesign 만 쓴다. Xcode 프로젝트·xcodebuild·SPM·
# Homebrew 는 쓰지 않는다.
set -euo pipefail

MACAPP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCES_DIR="$MACAPP_DIR/Sources"
BUILD_DIR="$MACAPP_DIR/build"
APP_NAME="WagServerBar"
APP_DIR="$BUILD_DIR/$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
BINARY_PATH="$MACOS_DIR/$APP_NAME"
INFO_PLIST="$CONTENTS_DIR/Info.plist"
TARGET_TRIPLE="x86_64-apple-macosx13.0"

echo "[build] Swift 소스 확인: $SOURCES_DIR"

SWIFT_SOURCES=()
while IFS= read -r -d '' f; do
  SWIFT_SOURCES+=("$f")
done < <(find "$SOURCES_DIR" -maxdepth 1 -type f -name '*.swift' -print0 2>/dev/null)

if [ "${#SWIFT_SOURCES[@]}" -eq 0 ]; then
  echo "[build] 오류: $SOURCES_DIR 에 Swift 소스가 없습니다 (*.swift 0개)." >&2
  echo "[build] 소스가 아직 작성되지 않은 것으로 보입니다 — 빌드를 중단합니다." >&2
  exit 1
fi

echo "[build] 소스 ${#SWIFT_SOURCES[@]}개 발견:"
printf '  - %s\n' "${SWIFT_SOURCES[@]}"

echo "[build] 기존 build/ 정리"
rm -rf "$BUILD_DIR"
mkdir -p "$MACOS_DIR"

SWIFTC_EXTRA_FLAGS=()
if grep -l '@main' "${SWIFT_SOURCES[@]}" >/dev/null 2>&1; then
  # @main 을 쓰는 소스가 하나라도 있으면, 여러 파일을 raw swiftc 로 컴파일할 때
  # "'main' attribute cannot be used in a module that contains top-level code"
  # 오류가 난다 (SwiftPM 은 이걸 자동으로 처리하지만 여긴 순수 swiftc). 그래서
  # -parse-as-library 를 붙인다 — 반대로 어떤 파일도 @main 을 안 쓰고 순수
  # 스크립트(top-level) 스타일이면 이 플래그를 붙이면 안 깨진다.
  SWIFTC_EXTRA_FLAGS+=(-parse-as-library)
  echo "[build] @main 발견 → -parse-as-library 추가"
fi

echo "[build] swiftc 컴파일 (target=$TARGET_TRIPLE, 언어 모드=기본값/Swift 5)"
if ! /usr/bin/swiftc \
  -target "$TARGET_TRIPLE" \
  -framework SwiftUI \
  -framework AppKit \
  "${SWIFTC_EXTRA_FLAGS[@]}" \
  -o "$BINARY_PATH" \
  "${SWIFT_SOURCES[@]}"; then
  echo "[build] 오류: swiftc 컴파일 실패 (위 출력 참고)" >&2
  exit 1
fi

if [ ! -x "$BINARY_PATH" ]; then
  echo "[build] 오류: 컴파일은 끝났지만 바이너리가 없습니다: $BINARY_PATH" >&2
  exit 1
fi

echo "[build] Info.plist 생성"
cat > "$INFO_PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>kr.ygrd.wagcrm.menubar</string>
  <key>CFBundleName</key><string>WagServerBar</string>
  <key>CFBundleDisplayName</key><string>WAG 서버</string>
  <key>CFBundleExecutable</key><string>WagServerBar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict>
</plist>
PLIST_EOF

echo "[build] 애드혹 코드서명"
if ! codesign --force --deep -s - "$APP_DIR"; then
  echo "[build] 오류: 코드서명 실패" >&2
  exit 1
fi

echo "[build] 완료: $APP_DIR"
