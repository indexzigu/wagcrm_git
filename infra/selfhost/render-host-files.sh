#!/usr/bin/env bash
set -euo pipefail

# 호스트 파일 렌더러 — launchd plist 6개와 crontab 을 「이 맥」의 홈·도구 경로로 다시 쓴다.
#
# 왜 필요한가: launchd 는 `$HOME`/`~` 를 전개하지 않고, crontab 도 절대경로로 쓴다.
# 그래서 레포의 plist·crontab 은 아이맥(홈 /Users/z9) 경로가 박힌 **아이맥 렌더 결과**다.
# 홈이 다른 맥(2026-11 이관 대상 맥북 — 홈 /Users/z9ro, 도구는 ~/opt)에서는 그 파일을
# 그대로 설치하면 경로가 전부 틀린다.
#
# 설계(되돌리지 말 것):
#   · 레포의 plist·crontab 은 **바꾸지 않는다** — 그대로 아이맥 정본이다. 그 파일을
#     직접 읽는 소비처가 많다(cutover.sh·rollback.sh 의 crontab 재설치, preview.sh 의
#     plist 설치, status.sh 의 잡 목록, 계약 테스트들). 자리표시자 템플릿으로 바꾸면
#     그 소비처 전부가 바뀌고 아이맥 동작이 흔들린다.
#   · 이 스크립트는 **두 가지만** 바꾼다: ① 접두 `/Users/z9/` → `<대상 홈>/`
#     ② tunnel plist 의 `/usr/local/bin/cloudflared` → 대상 맥의 cloudflared.
#     그래서 `RENDER_HOME=/Users/z9` + 아이맥 cloudflared 로 렌더하면 원본과 **바이트
#     동일**하다(계약: scripts/__tests__/selfhost-host-portability.test.ts).
#   · 접두에 **끝 슬래시를 포함**해 바꾼다 — `/Users/z9ro/…` 는 `/Users/z9/` 와 매치되지
#     않으므로 이미 렌더된 파일을 다시 넣어도 두 번 바뀌지 않는다.
#   · 레포 체크아웃 안에는 **아무것도 쓰지 않는다**(운영 체크아웃이 dirty 가 되면
#     deploy.sh 의 `git reset --hard` 가 지운다). 출력은 stdout 이나 --out 폴더뿐이다.
#   · Big Sur 기본 bash 3.2 · BSD sed 와 Linux(CI) GNU sed 양쪽에서 돈다 — `sed -i`·
#     연관 배열·`mapfile` 을 쓰지 않는다.
#
# 쓰는 법:
#   render-host-files.sh --out <폴더>   # plist 6개(<폴더>/launchd/) + crontab(<폴더>/crontab)
#   render-host-files.sh --file <원본>  # 원본 1개를 렌더해 stdout 으로
#
# 입력 env:
#   RENDER_HOME     대상 홈(기본 $HOME). 절대경로·[A-Za-z0-9._/-] 만 허용.
#   CLOUDFLARED_BIN 대상 cloudflared 실행파일(기본: 아래 후보 중 처음 실행 가능한 것).
#                   후보 순서 = /usr/local/bin → /opt/homebrew/bin → $RENDER_HOME/opt/cloudflared
#                   (기존 후보 뒤에 새 맥 후보 — 아이맥 결과를 바꾸지 않는다).
#                   찾지 못하면 실패한다(틀린 경로의 plist 를 조용히 만들지 않는다).
#
# 설치는 이 스크립트가 하지 않는다 — 렌더 결과를 diff 로 확인한 뒤 사람이 설치한다
# (절차: infra/selfhost/README.md 「다른 맥으로 옮길 때 — 호스트 파일 렌더」).
# ⛔ deploy.sh 등 자동 경로에서 이 스크립트로 설치까지 하게 만들지 말 것 — 아이맥의
#    설치본 plist 4개는 레포 파일과 다르게(Login Items 표시용 래퍼 경유) 손으로 바꿔 둔
#    상태라, 자동 재설치는 그 변경을 조용히 덮어쓴다.

SELF_DIR="$(cd "$(dirname "$0")" && pwd -P)"
SOURCE_HOME_PREFIX="/Users/z9/"
SOURCE_CLOUDFLARED="/usr/local/bin/cloudflared"
PLISTS="kr.ygrd.wagcrm.app.plist kr.ygrd.wagcrm.agent-worker.plist kr.ygrd.wagcrm.backup.plist kr.ygrd.wagcrm.backup-weekly.plist kr.ygrd.wagcrm.tunnel.plist kr.ygrd.wagcrm.preview.plist"

die() { printf '[render-host-files] 중단: %s\n' "$*" >&2; exit 1; }

usage() {
  cat >&2 <<'EOF'
쓰는 법:
  render-host-files.sh --out <폴더>    plist 6개 + crontab 을 <폴더> 에 렌더
  render-host-files.sh --file <원본>   원본 1개를 렌더해 stdout 으로
env: RENDER_HOME(기본 $HOME) · CLOUDFLARED_BIN(기본 자동 탐색)
EOF
  exit 2
}

# sed 치환 우변에 그대로 들어가므로 구분자(#)·&·\ 등이 섞이면 결과가 조용히 틀린다.
safe_path() {
  case "$1" in
    /*) ;;
    *) return 1 ;;
  esac
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9._/-]+$'
}

RENDER_HOME="${RENDER_HOME:-${HOME:-}}"
[ -n "$RENDER_HOME" ] || die "RENDER_HOME·HOME 이 둘 다 비어 있습니다."
RENDER_HOME="${RENDER_HOME%/}"
safe_path "$RENDER_HOME" || die "RENDER_HOME 이 절대경로가 아니거나 허용 문자(A-Z a-z 0-9 . _ / -) 밖입니다: $RENDER_HOME"

resolve_cloudflared() {
  if [ -n "${CLOUDFLARED_BIN:-}" ]; then
    printf '%s' "$CLOUDFLARED_BIN"
    return 0
  fi
  local c
  for c in /usr/local/bin/cloudflared /opt/homebrew/bin/cloudflared "$RENDER_HOME/opt/cloudflared/cloudflared"; do
    if [ -x "$c" ]; then
      printf '%s' "$c"
      return 0
    fi
  done
  return 1
}

render_one() {
  local src="$1"
  [ -f "$src" ] || die "원본 파일이 없습니다: $src"
  case "$(basename "$src")" in
    kr.ygrd.wagcrm.tunnel.plist)
      local cf
      cf="$(resolve_cloudflared)" || die "cloudflared 를 찾지 못했습니다(/usr/local/bin · /opt/homebrew/bin · $RENDER_HOME/opt/cloudflared). CLOUDFLARED_BIN 으로 지정하세요."
      safe_path "$cf" || die "CLOUDFLARED_BIN 이 절대경로가 아니거나 허용 문자 밖입니다: $cf"
      grep -Fq "<string>$SOURCE_CLOUDFLARED</string>" "$src" \
        || die "tunnel plist 에 예상한 cloudflared 줄(<string>$SOURCE_CLOUDFLARED</string>)이 없습니다 — 원본 형식이 바뀌었으면 이 스크립트도 함께 고치세요."
      sed -e "s#<string>$SOURCE_CLOUDFLARED</string>#<string>$cf</string>#" \
          -e "s#$SOURCE_HOME_PREFIX#$RENDER_HOME/#g" "$src"
      ;;
    *)
      sed -e "s#$SOURCE_HOME_PREFIX#$RENDER_HOME/#g" "$src"
      ;;
  esac
}

# 렌더 결과 점검 — 남의 홈 경로가 남았거나 plist 가 깨졌으면 실패한다.
verify_rendered() {
  local f="$1"
  if [ "$RENDER_HOME/" != "$SOURCE_HOME_PREFIX" ] && grep -Fq "$SOURCE_HOME_PREFIX" "$f"; then
    die "렌더 결과에 원본 홈($SOURCE_HOME_PREFIX)이 남았습니다: $f"
  fi
  case "$f" in
    *.plist)
      if command -v plutil >/dev/null 2>&1; then
        plutil -lint -s "$f" || die "plist 문법 오류: $f"
      fi
      ;;
  esac
}

active_cron_count() { grep -cE '^[0-9*]' "$1" || true; }

MODE=""
ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || usage; MODE="out"; ARG="$2"; shift 2 ;;
    --file) [ $# -ge 2 ] || usage; MODE="file"; ARG="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done
[ -n "$MODE" ] || usage

if [ "$MODE" = file ]; then
  # 점검(verify_rendered)을 통과한 결과만 내보낸다 — 호출자(preview.sh·cutover.sh·
  # rollback.sh)는 이 출력을 곧바로 설치하므로 반쯤 틀린 내용이 나가면 안 된다.
  tmp_one="$(mktemp "${TMPDIR:-/tmp}/render-host-files.XXXXXX")"
  trap 'rm -f "$tmp_one"' EXIT
  case "$ARG" in *.plist) mv "$tmp_one" "$tmp_one.plist"; tmp_one="$tmp_one.plist" ;; esac
  render_one "$ARG" > "$tmp_one"
  verify_rendered "$tmp_one"
  cat "$tmp_one"
  exit 0
fi

# 출력 폴더가 레포 체크아웃 안이면 만들기 **전에** 거부한다(운영 체크아웃을 dirty 로 만들지 않는다).
REPO_DIR="$(cd "$SELF_DIR/../.." && pwd -P)"
case "$ARG" in
  /*) out_abs="$ARG" ;;
  *) out_abs="$PWD/$ARG" ;;
esac
case "/$ARG/" in
  */../*) die "--out 에 '..' 를 쓰지 마세요($ARG) — 레포 안을 우회해 가리킬 수 있습니다." ;;
esac
case "$out_abs/" in
  "$REPO_DIR/"*) die "--out 이 레포 체크아웃 안을 가리킵니다($out_abs) — 레포 밖 폴더를 쓰세요." ;;
esac
# 이미 있는 가장 가까운 조상을 심볼릭 링크까지 풀어 한 번 더 본다(링크로 레포 안을 가리키는 경우).
out_probe="$out_abs"
while [ ! -d "$out_probe" ]; do out_probe="$(dirname "$out_probe")"; done
case "$(cd "$out_probe" && pwd -P)/" in
  "$REPO_DIR/"*) die "--out 이 (심볼릭 링크를 풀면) 레포 체크아웃 안입니다($out_abs) — 레포 밖 폴더를 쓰세요." ;;
esac
mkdir -p "$ARG/launchd"
OUT_DIR="$(cd "$ARG" && pwd -P)"
case "$OUT_DIR/" in
  "$REPO_DIR/"*) die "--out 이 (심볼릭 링크를 풀면) 레포 체크아웃 안입니다($OUT_DIR) — 레포 밖 폴더를 쓰세요." ;;
esac

plist_count=0
for p in $PLISTS; do
  render_one "$SELF_DIR/launchd/$p" > "$OUT_DIR/launchd/$p"
  verify_rendered "$OUT_DIR/launchd/$p"
  plist_count=$((plist_count + 1))
done
render_one "$SELF_DIR/crontab" > "$OUT_DIR/crontab"
verify_rendered "$OUT_DIR/crontab"

src_count="$(active_cron_count "$SELF_DIR/crontab")"
out_count="$(active_cron_count "$OUT_DIR/crontab")"
[ "$src_count" = "$out_count" ] || die "crontab 활성 줄 수가 달라졌습니다(원본 $src_count · 렌더 $out_count)."

printf '[render-host-files] 완료: %s (홈 %s · crontab 활성 %s줄 · plist %s개)\n' \
  "$OUT_DIR" "$RENDER_HOME" "$out_count" "$plist_count" >&2
