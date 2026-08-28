#!/usr/bin/env bash
set -euo pipefail
# `$0` 이 아니라 BASH_SOURCE 를 쓴다 — 계약 테스트가 이 파일을 source 해서
# 개별 검사기만 호출할 때(CUTOVER_TEST_LIB_ONLY, 파일 하단 참고) `$0` 은
# 호출한 쪽 스크립트를 가리켜 REPO_ROOT 가 엉뚱한 곳이 된다. 직접 실행할
# 때는 둘이 같은 값이라 동작은 그대로다.
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
REPO_ROOT="$(pwd)"

# WAG CRM 셀프호스트 컷오버(cutover) — 실행체.
#
# 이 프로젝트에서 "되돌리기 어렵다고 느껴지는" 유일한 순간이다. 그래서 이
# 스크립트는 기억에 의존한 명령 나열이 아니라, 단계(Stage)마다 ①무엇을
# 할지 먼저 출력하고 ②실행하고 ③결과를 검증한 뒤에만 다음 단계로 넘어가는
# 구조로 짰다. 실패하면 항상 nonzero exit + 한국어로 "어느 Stage 가
# 실패했는지·지금 시스템이 어떤 상태인지·어떻게 재개하는지"를 남긴다.
#
# 사용법:
#   ./infra/selfhost/cutover.sh --dry-run          # 계획만 출력, 아무 것도 건드리지 않음
#   ./infra/selfhost/cutover.sh                     # Stage 1 부터 실행
#   ./infra/selfhost/cutover.sh --stage 5           # Stage 1(사전 점검)은 항상 재확인하고, Stage 5 부터 재개
#   ./infra/selfhost/cutover.sh --confirm-old-cron-off   # Stage 8(보류 크론 활성화) 진입에 필요
#
# 전제 문서(먼저 읽을 것 — 이 스크립트는 그 안의 결정을 코드로 옮긴 것뿐이다):
#   infra/selfhost/README.md (백업·크론·배포 절차 전체, 이 파일 하단 "컷오버" 절)
#   docs/private/plans/2026-08-12-imac-selfhost-migration.md (Phase 3·7)
#
# 3분할 원칙(반드시 지킬 것 — README "auth 를 통째로 복원하면 안 되는 이유" 참고):
#   public  스키마 — 이 앱 소유. 드랍 후 재구축(prisma migrate deploy) + 데이터 전체 교체.
#   auth    스키마 — GoTrue 소유. 스키마는 절대 건드리지 않고 행(users/identities)만 ID 보존 upsert.
#   storage 스키마 — Storage API 소유. 스키마는 건드리지 않고, 객체는 기존
#           scripts/migrate-storage-objects.ts(API 경유, 멱등)로 증분 이관.

# ── 설정(머신마다 다를 수 있는 값 — docker ps/실제 경로로 재확인할 것) ──
DB_CONTAINER="supabase-db"
# GoTrue 컨테이너명은 이 스택의 compose 서비스명 관례(supabase-<service>,
# backup.sh/backup-weekly.sh 의 DB_CONTAINER="supabase-db" 와 동일 관례)를
# 따른 가정이다 — 실제 실행 전 `docker ps` 로 재확인할 것.
AUTH_CONTAINER="supabase-auth"
SUPABASE_DOCKER_DIR="$HOME/selfhost/supabase-docker"
SUPABASE_DOCKER_ENV="$SUPABASE_DOCKER_DIR/.env"
CLOUDFLARED_CONFIG="$HOME/.cloudflared/config.yml"
CRONTAB_FILE="$REPO_ROOT/infra/selfhost/crontab"
ENV_FILE="$REPO_ROOT/infra/selfhost/.env"
# 컷오버 전용 크리덴셜(클라우드 원본 접속 정보) — git 미추적(.env* 패턴).
# 필수 변수: PROD_URL(클라우드 Postgres 직결 문자열, pg_dump/psql 용),
#           SRC_URL/SRC_SERVICE_KEY(클라우드 Supabase Storage API).
# CUTOVER_TEST_ENV_FILE 은 사전 점검 가드 자체를 테스트할 때만 쓰는 테스트
# 전용 오버라이드다(CUTOVER_TEST_NOW_HM 과 동일 취급 — 운영에서는 절대
# 설정하지 않는다). 실제 크리덴셜은 항상 아래 기본 경로에서 읽는다.
CUTOVER_ENV_FILE="${CUTOVER_TEST_ENV_FILE:-$REPO_ROOT/infra/selfhost/.env.cutover}"
R2_CREDS_FILE="/Users/z9/selfhost/r2-credentials.txt"
R2_REMOTE="r2"
R2_BACKUP_PREFIX="backups"
LOG_DIR="$HOME/selfhost/logs"
LOG_FILE="$LOG_DIR/cutover.log"
PROD_HOSTNAME="crm.ygrd.kr"
TUNNEL_NAME="wagcrm"
PRISMA_BIN="$REPO_ROOT/node_modules/.bin/prisma"
# 아래 5개가 Phase 5 에서 의도적으로 주석 처리된 채 보류된 부수효과 잡이다
# (infra/selfhost/crontab 상단 주석과 동일 목록).
HELD_CRON_JOBS="refresh-instagram-token rehost-seller-media naver-settlement-sync naver-order-sync tax-invoice-issue-confirm"

# ── PATH 해석(backup.sh/run-app.sh/restore-drill.sh 와 동일 관용구) ──
# 이 스크립트만 호스트의 psql/pg_dump 를 직접 부른다(Stage 3a 덤프·3d·3e
# 재주입·Stage 4 대조). backup.sh 는 로컬 DB 만 다루므로 `docker exec` 로
# pg_dump 를 부를 수 있었지만, Stage 3a 는 "클라우드 원본"을 떠야 하므로
# 호스트 클라이언트가 필요하다. 그런데 macOS 의 libpq 는 brew keg-only 라
# /usr/local/bin 에 심볼릭 링크가 생기지 않는다 — 대화형 셸에도 psql 이
# 없다(실측). 그래서 표준 경로 뒤에 libpq keg 경로를 함께 얹는다.
# CUTOVER_TEST_PATH_CANDIDATES 는 가드 자체를 테스트할 때만 쓰는 테스트 전용
# 오버라이드다(운영에서는 절대 설정하지 않는다) — libpq 가 깔린 기계에서도
# "실행파일 없음" 경로를 재현할 수 있어야 하기 때문이다.
PATH_CANDIDATES="${CUTOVER_TEST_PATH_CANDIDATES:-/usr/local/bin:/opt/homebrew/bin:/usr/local/opt/libpq/bin:/opt/homebrew/opt/libpq/bin}"
export PATH="$PATH_CANDIDATES:$PATH"

mkdir -p "$LOG_DIR"

# ── 인자 파싱 ──
DRY_RUN=0
START_STAGE=1
CONFIRM_OLD_CRON_OFF=0

print_usage() {
  cat <<'EOF'
사용법: cutover.sh [--dry-run] [--stage N] [--confirm-old-cron-off]
  --dry-run                계획만 출력하고 종료(아무 것도 건드리지 않음)
  --stage N                Stage N 부터 재개(Stage 1 사전 점검은 항상 먼저 재확인)
  --confirm-old-cron-off   Stage 8(보류 크론 5개 활성화) 진입에 필요한 명시적 확인
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --stage)
      START_STAGE="${2:?--stage 뒤에 1~9 사이 숫자가 필요합니다}"
      shift 2
      ;;
    --confirm-old-cron-off) CONFIRM_OLD_CRON_OFF=1; shift ;;
    -h|--help) print_usage; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; print_usage; exit 1 ;;
  esac
done

case "$START_STAGE" in
  1|2|3|4|5|6|7|8|9) ;;
  *) echo "--stage 값이 잘못됐습니다(1~9 사이여야 함): $START_STAGE" >&2; exit 1 ;;
esac

# ── 로깅/중단 헬퍼 ──
log() { printf '[cutover] %s\n' "$*" | tee -a "$LOG_FILE"; }
warn() { printf '[cutover] 경고: %s\n' "$*" | tee -a "$LOG_FILE" >&2; }

CURRENT_STAGE_NUM=0
CURRENT_STAGE_NAME="(시작 전)"
CURRENT_TMPDIR=""

cleanup_tmpdir() {
  # ⚠️ `[ cond ] && cmd` 형태를 그대로 쓰면 cond 가 거짓일 때(=정상적으로
  # 지울 게 없을 때) 이 함수 자체의 종료 상태가 1이 되고, EXIT 트랩이 이
  # 함수를 무가드로 호출하므로 ERR 트랩이 "예기치 못한 오류"로 오탐한다
  # (실측: --dry-run 종료 시 이 이유로 exit 0 인데도 오탐 발생). if/fi 로
  # 감싸 함수가 항상 0을 반환하게 한다.
  if [ -n "$CURRENT_TMPDIR" ]; then
    rm -rf "$CURRENT_TMPDIR"
  fi
}
trap cleanup_tmpdir EXIT

# set -e 가 (abort() 를 거치지 않고) 명령 치환 실패 등으로 스크립트를
# 갑자기 끝낼 때를 위한 안전망 — 어떤 경로로 죽든 "어느 Stage 인지 +
# 어떻게 재개하는지"는 반드시 남긴다. abort() 는 exit 1 을 직접 호출하므로
# 이 트랩과 중복 출력되지 않는다(exit 자체는 ERR 트랩을 재발화하지 않음).
on_error() {
  local exit_code=$?
  {
    printf '[cutover] 중단(예기치 못한 오류, exit %s): Stage %s(%s) 도중\n' "$exit_code" "$CURRENT_STAGE_NUM" "$CURRENT_STAGE_NAME"
    printf '[cutover]   문제를 해결한 뒤 다음으로 재개하십시오: %s --stage %s\n' "$0" "$CURRENT_STAGE_NUM"
  } | tee -a "$LOG_FILE" >&2
}
trap on_error ERR

abort() {
  local stage="$1" name="$2" msg="$3"
  {
    printf '[cutover] 중단: Stage %s(%s) 실패\n' "$stage" "$name"
    printf '[cutover]   원인: %s\n' "$msg"
    printf '[cutover]   문제를 해결한 뒤 다음으로 재개하십시오: %s --stage %s\n' "$0" "$stage"
  } | tee -a "$LOG_FILE" >&2
  exit 1
}

enter_stage() { CURRENT_STAGE_NUM="$1"; CURRENT_STAGE_NAME="$2"; log "=== Stage $1: $2 ==="; }

# ── 공용 헬퍼 ──

# KEY=VALUE 형식 파일에서 특정 키 값을 정밀 치환(퍼지 매칭 금지, P4). 있으면
# 그 줄만 바꾸고, 없으면 파일 끝에 추가한다.
set_env_var() {
  local file="$1" key="$2" value="$3"
  if grep -q "^${key}=" "$file"; then
    local tmp; tmp="$(mktemp)"
    awk -v k="$key" -v v="$value" -F= 'BEGIN{OFS="="} $1==k{print k"="v; next} {print}' "$file" > "$tmp"
    mv "$tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

# 활성 앱 크론 개수 — **기대값을 여기 숫자로 박지 않는다.** 종전에는 15 를 두 곳에
# 하드코딩해 뒀는데, 크론이 하나 늘면(2026-08-13 이후 실제로 늘었다) 이 스크립트가
# 정상 상태를 FAIL 로 판정한다. 기대값의 정본은 레포의 crontab 파일이므로 거기서 센다.
# 판정식은 설치본·파일 양쪽에 **같은 정규식**을 쓴다 — 다르면 비교 자체가 무의미하다.
CRON_JOB_LINE_RE='^[0-9*].*run-cron\.sh'

expected_cron_count() {
  grep -cE "$CRON_JOB_LINE_RE" "$CRONTAB_FILE" || true
}

installed_cron_count() {
  crontab -l 2>/dev/null | grep -cE "$CRON_JOB_LINE_RE" || true
}

# DATABASE_URL 로 실제 DB 에 SELECT 1 이 가는지 확인(deploy.sh 의 P0
# 안전장치 ④ 와 동일 프로브 — 별도 프로세스/커넥션이므로 "이 연결 문자열로
# 지금 DB 에 붙을 수 있다"만 증명한다).
db_probe() {
  local url="$1"
  DATABASE_URL="$url" node -e '
(async () => {
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    process.exitCode = 0;
  } catch (e) {
    console.error(String((e && e.message) || e));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
'
}

# 콤마 구분 컬럼 목록 두 개의 교집합(첫 인자의 순서 유지).
intersect_csv() {
  local a="$1" b="$2" out="" c
  IFS=',' read -ra arr_a <<< "$a"
  for c in "${arr_a[@]}"; do
    case ",$b," in *",$c,"*) out="${out:+$out,}$c" ;; esac
  done
  printf '%s' "$out"
}

# ON CONFLICT ... DO UPDATE SET 절 생성(conflict 컬럼 제외 전부).
build_set_clause() {
  local cols="$1" conflict_col="$2" out="" c
  IFS=',' read -ra arr <<< "$cols"
  for c in "${arr[@]}"; do
    # `[ cond ] && continue` 형태를 쓰면 cond 가 거짓인(=제외 대상이 아닌,
    # 즉 대부분의) 반복에서 이 문장의 종료 상태가 1이 되어 위 cleanup_tmpdir
    # 과 같은 오탐 위험이 있다 — if/fi 로 감싼다.
    if [ "$c" = "$conflict_col" ]; then
      continue
    fi
    out="${out:+$out, }$c = EXCLUDED.$c"
  done
  printf '%s' "$out"
}

# URL 에서 host 만 정확히 뽑는다(scheme·자격증명·port·path 제거). deploy.sh 의
# db_host_of 와 같은 이유로 부분일치를 쓰지 않는다 — 자격증명이나 경로에 우연히
# 섞인 글자로 판정이 뒤집히면 안 된다.
origin_host_of() {
  local url="$1" authority
  # .env 를 손으로 쓴 경우 값이 따옴표로 감싸여 있을 수 있다.
  url="${url%\"}"; url="${url#\"}"
  url="${url%\'}"; url="${url#\'}"
  authority="${url#*://}"
  authority="${authority##*@}"
  authority="${authority%%/*}"
  printf '%s' "${authority%%:*}"
}

# Stage 5 의 "재빌드가 실제로 반영됐는가" 판정. 0=반영 확인 · 1=미반영.
# 근거는 BUILD_ORIGIN_DETAIL 에 남긴다(호출자가 로그·중단 메시지에 싣는다).
#
# 🪤 **검사 대상은 client static 이 아니라 server 산출물이다**(2026-08-13 실측:
# static 에는 0건, server 아래에만 존재). 이 앱에서 NEXT_PUBLIC_APP_URL/
# NEXT_PUBLIC_SITE_URL 을 읽는 표면은 전부 서버 컴포넌트·라우트 핸들러
# (components/auth/landing-login.tsx · app/api/integrations/*/callback/route.ts ·
# lib/google-calendar.ts 등)라 클라이언트 번들에는 애초에 들어가지 않는다.
# static 만 grep 하던 종전 검사는 **정상 재빌드에서도 항상 실패**했고, 실제
# 컷오버에서는 사람이 수동 확인으로 우회해야 했다.
#
# 양성(신규 origin 존재)과 음성(구 origin 부재)을 함께 본다 — 양성만 보면
# "이번 빌드가 반영됐다"와 "원래부터 그 문자열이 있었다"를 구분하지 못하고,
# 음성만 보면 grep 이 통째로 고장나도(경로 오타 등) 조용히 통과한다.
BUILD_ORIGIN_DETAIL=""
verify_origin_in_build() {
  local build_root="$1" new_host="$2" prev_host="$3"
  local server_dir="$build_root/server"
  BUILD_ORIGIN_DETAIL=""

  if [ ! -d "$server_dir" ]; then
    BUILD_ORIGIN_DETAIL="빌드 산출물 디렉터리가 없습니다: $server_dir"
    return 1
  fi

  local hits
  hits="$(grep -rl -- "$new_host" "$server_dir" 2>/dev/null | wc -l | tr -d ' ' || true)"
  if [ "${hits:-0}" -eq 0 ]; then
    BUILD_ORIGIN_DETAIL="신규 origin($new_host) 문자열이 $server_dir 어디에도 없습니다"
    return 1
  fi

  # 음성 프로브의 예외: 루프백은 대조하지 않는다. 소스에 `?? "http://localhost:3000"`
  # 폴백 리터럴이 여러 곳에 있어 정상 빌드에도 항상 남는다 — 그걸 잔재로 읽으면
  # 지금 고치는 것과 똑같은 부류의 오탐이 된다.
  case "$prev_host" in
    ""|"$new_host"|localhost|127.0.0.1|::1|0.0.0.0)
      BUILD_ORIGIN_DETAIL="신규 origin 반영 확인(${hits}개 파일) · 구 origin 대조 스킵(대조 대상 없음 또는 루프백)"
      return 0
      ;;
  esac

  local stale
  stale="$(grep -rl -- "$prev_host" "$server_dir" 2>/dev/null | wc -l | tr -d ' ' || true)"
  if [ "${stale:-0}" -ne 0 ]; then
    BUILD_ORIGIN_DETAIL="신규 origin 은 있지만(${hits}개 파일) 구 origin($prev_host)이 아직 ${stale}개 파일에 남아 있습니다 — 이전 빌드 산출물이 그대로일 수 있습니다"
    return 1
  fi
  BUILD_ORIGIN_DETAIL="신규 origin 반영 확인(${hits}개 파일) · 구 origin($prev_host) 잔재 0건"
  return 0
}

# 재기동된 GoTrue 컨테이너에 **실제로 적용된** SITE_URL 을 읽는다.
# 결과는 AUTH_SITE_URL_VALUE(값)·AUTH_SITE_URL_KEY(어느 변수에서 읽었는지)에 남긴다
# (명령 치환으로 값을 받으면 서브셸이라 키 이름이 호출자에게 돌아오지 않는다).
#
# 🪤 **컨테이너 안의 변수 이름은 SITE_URL 이 아니라 GOTRUE_SITE_URL 이다** —
# supabase 의 docker compose 가 .env 의 SITE_URL 을 GoTrue 의 접두사 규약에 맞춰
# 주입하기 때문이다. 종전 검사(`printenv SITE_URL`)는 항상 exit 1·빈 값이라
# **정상 전환에서도 Stage 6 이 중단됐다**(2026-08-13 실행이 정확히 여기서 멈췄다).
# 스택마다 이름이 다를 수 있으므로 GOTRUE_SITE_URL → SITE_URL 순으로 본다.
AUTH_SITE_URL_KEY=""
AUTH_SITE_URL_VALUE=""
read_auth_site_url() {
  local container="$1" key value
  AUTH_SITE_URL_KEY=""
  AUTH_SITE_URL_VALUE=""
  for key in GOTRUE_SITE_URL SITE_URL; do
    value="$(docker exec "$container" printenv "$key" 2>/dev/null || true)"
    if [ -n "$value" ]; then
      AUTH_SITE_URL_KEY="$key"
      AUTH_SITE_URL_VALUE="$value"
      return 0
    fi
  done
  return 1
}

# "지금 이 호스트네임을 **자체호스팅 스택이** 서빙하는가" 판정 — Stage 7·9 공용.
# 0=자체호스팅 확인 · 1=아님/판정 불가. 근거는 SERVE_CHECK_DETAIL 에 남긴다.
#
# 🪤 `/` 의 200 으로는 판정할 수 없다. 두 이유가 겹친다(2026-08-13 실측):
#   ① 미인증 `/` 는 인증 게이트(src/lib/supabase/middleware.ts)가 307 로 /login
#      에 보낸다 — **정상인데도 200 이 아니다**.
#   ② 구 배포도 같은 앱이라 똑같이 307 을 준다 — 상태코드는 신·구를 가르지
#      못한다(판별력 0).
# 그래서 ⓐ `/login` 이 200(앱이 실제로 렌더한다)이고 ⓑ 응답에 이전 플랫폼의
# 엣지 서명 헤더(x-vercel-id)가 없다를 함께 본다 — ⓑ 가 실제 판별자다.
SERVE_CHECK_DETAIL=""
selfhost_serving_check() {
  local raw code
  SERVE_CHECK_DETAIL=""
  raw="$(curl -s -m 10 -o /dev/null -D - -w 'HTTPCODE:%{http_code}' "https://$PROD_HOSTNAME/login" 2>/dev/null || true)"
  code="${raw##*HTTPCODE:}"
  if [ "$code" != "200" ]; then
    SERVE_CHECK_DETAIL="https://$PROD_HOSTNAME/login 응답 코드 ${code:-없음}(200 기대)"
    return 1
  fi
  if printf '%s' "$raw" | grep -qi '^x-vercel-id:'; then
    SERVE_CHECK_DETAIL="/login 은 200 이지만 응답에 이전 플랫폼의 엣지 헤더(x-vercel-id)가 있습니다 — 아직 이전 배포가 응답 중입니다(DNS 전파 대기 또는 ingress 미반영)"
    return 1
  fi
  SERVE_CHECK_DETAIL="/login 200 · 이전 플랫폼 엣지 헤더 없음"
  return 0
}

# 미인증 `/` 가 로그인으로 리다이렉트되는가 — 인증 게이트가 살아있는지 본다.
# 위 판별자가 "누가 서빙하는가"라면 이쪽은 "게이트가 열려 있지 않은가"다
# (미인증 `/` 가 200 이면 그것이야말로 사고다).
AUTH_GATE_DETAIL=""
auth_gate_check() {
  local raw code location
  AUTH_GATE_DETAIL=""
  raw="$(curl -s -m 10 -o /dev/null -D - -w 'HTTPCODE:%{http_code}' "https://$PROD_HOSTNAME/" 2>/dev/null || true)"
  code="${raw##*HTTPCODE:}"
  location="$(printf '%s' "$raw" | grep -i '^location:' | head -1 | tr -d '\r' || true)"
  case "$code" in
    30[0-9]) ;;
    *)
      AUTH_GATE_DETAIL="미인증 / 응답 코드 ${code:-없음}(로그인 리다이렉트 3xx 기대)"
      return 1
      ;;
  esac
  case "$location" in
    *"/login"*)
      AUTH_GATE_DETAIL="미인증 / → $code, Location 이 /login"
      return 0
      ;;
    *)
      AUTH_GATE_DETAIL="미인증 / 는 $code 지만 Location 이 /login 이 아닙니다(${location:-Location 헤더 없음})"
      return 1
      ;;
  esac
}

print_plan() {
  cat <<EOF
=== cutover.sh 실행 계획(--dry-run — 아무 것도 건드리지 않습니다) ===

Stage 1. 사전 점검(preflight guard) — 아래 전부 PASS 해야 진행:
         자체호스팅 앱 HTTP 서빙 + DB 연결, 오늘자(KST) R2 백업 존재,
         현재 시각이 크론 공백 시간대(KST 14:00~21:59) 안, 운영 체크아웃
         경로(개발 워크트리 아님), 필수 실행파일(psql·pg_dump 포함)이
         PATH 에서 잡히는지, $CUTOVER_ENV_FILE 3개 키가 비어있지 않은지.
Stage 2. infra/selfhost/backup.sh 재사용 — 파괴적 작업 전 최신 백업 확보.
         실패 시 절대 다음 단계로 진행하지 않음.
Stage 3. 최종 데이터 재동기화:
           3a) 클라우드 public 데이터 덤프 → 완전/비어있지 않음 검증
               (로컬은 이 시점까지 전혀 건드리지 않음)
           3b) 로컬 public 스키마 드랍
           3c) 이 체크아웃의 Prisma 마이그레이션으로 재구축
           3d) 클라우드 데이터 전체 재주입(부분 머지 아님 — 전체 교체)
           3e) auth.users/auth.identities 행 재동기화(ID 보존, upsert —
               스키마는 GoTrue 소유라 절대 드랍하지 않음)
           3f) storage 객체 증분 재이관(scripts/migrate-storage-objects.ts, 멱등)
Stage 4. 정합성 검증(하나라도 FAIL 이면 중단):
         테이블별 행수 대조, auth 사용자 ID 집합 완전 일치(개수 아님),
         소유권 참조(createdBy/userId) 고아 0건, 버킷별 객체 수 대조.
Stage 5. 앱 공개 origin 전환 — NEXT_PUBLIC_APP_URL/NEXT_PUBLIC_SITE_URL 은
         빌드 타임에 인라이닝되므로 재시작이 아니라 재빌드가 필요하다.
         $ENV_FILE 갱신 → deploy.sh(FORCE=1) 로 재빌드+재기동 → server
         산출물(.next/standalone/.next/server)에서 신규 origin 존재(양성)와
         구 origin 부재(음성)를 함께 확인.
Stage 6. 인증 서비스(GoTrue) origin 전환 — Supabase 스택 .env 의 SITE_URL
         만 정밀 치환하고 auth 서비스만 재기동. ⚠️ 그 .env 를 이 셸에
         source 하지 않는다(JSON 값 변수가 있어 source 하면 따옴표가
         벗겨지고, docker compose 는 그 뒤 파일보다 셸 환경변수를
         우선하므로 크래시루프가 난다 — docker compose 는 항상
         --env-file 로 호출).
Stage 7. 프로덕션 호스트네임($PROD_HOSTNAME) 라우팅 — cloudflared ingress
         추가 → DNS 라우팅 → 터널 서비스만 재기동 → 외부 서빙 확인
         (/login 200 + 이전 플랫폼 엣지 헤더 부재로 신·구 배포를 판별한다 —
         미인증 / 는 정상 상태에서도 307 이라 상태코드로는 못 가른다).
Stage 8. 보류된 크론 5개(${HELD_CRON_JOBS// /, }) 활성화.
         ⚠️ --confirm-old-cron-off 플래그 + (대화형이면) 정확한 확인 문구
         입력 없이는 진행하지 않음 — 이전 배포 크론이 살아있는 채로
         양쪽이 동시 발화하면 외부 시스템(네이버·세금계산서·인스타그램
         토큰)에 실제 사고가 난다.
Stage 9. 컷오버 후 검증 — 프로덕션 호스트네임을 자체호스팅 스택이 서빙
         (Stage 7 과 동일 판별자, 로그인 화면 렌더 포함), 미인증 접근의
         로그인 리다이렉트, DB 연결, 앱 크론 전량 활성(개수는 crontab
         파일에서 센다), 백업 스케줄(일간+주간)
         2개 등록.
EOF
  if [ "$START_STAGE" -gt 1 ]; then
    echo
    echo "요청된 --stage $START_STAGE : 실행 시 Stage 1(사전 점검)은 항상 재확인하고, Stage $START_STAGE 부터 진행합니다."
  fi
}

# ══════════════════════════ Stage 1 ══════════════════════════
stage1_preflight() {
  enter_stage 1 "사전 점검"
  local ok=1

  # 가드 A: 운영 체크아웃 경로(개발 워크트리 아님) — deploy.sh 와 동일 가드.
  case "$REPO_ROOT" in
    *"/.claude/worktrees/"*)
      log "[가드] 운영 체크아웃 경로 ... FAIL (현재: $REPO_ROOT 는 개발 워크트리입니다)"
      ok=0
      ;;
    *)
      log "[가드] 운영 체크아웃 경로 ... PASS ($REPO_ROOT)"
      ;;
  esac

  # 가드 B: 크론 공백 시간대(KST 14:00~21:59). CUTOVER_TEST_NOW_HM 은
  # 이 가드 자체를 검증할 때만 쓰는 테스트 전용 오버라이드다 — 설정하지
  # 않으면 항상 실제 KST 현재 시각을 쓴다(운영에서는 절대 설정하지 않음).
  local now_hm now_int
  now_hm="${CUTOVER_TEST_NOW_HM:-$(TZ=Asia/Seoul date +%H%M)}"
  now_int="$((10#$now_hm))"
  if [ "$now_int" -ge 1400 ] && [ "$now_int" -le 2159 ]; then
    log "[가드] 크론 공백 시간대(KST 14:00~21:59) ... PASS (현재 KST $now_hm)"
  else
    log "[가드] 크론 공백 시간대(KST 14:00~21:59) ... FAIL (현재 KST $now_hm 는 창 밖)"
    ok=0
  fi

  # 가드 C: 자체호스팅 앱이 서빙 중이고 DB 에 닿는지.
  if curl -fsS -m 5 -o /dev/null http://127.0.0.1:3000/; then
    log "[가드] 앱 HTTP 서빙(127.0.0.1:3000) ... PASS"
  else
    log "[가드] 앱 HTTP 서빙(127.0.0.1:3000) ... FAIL"
    ok=0
  fi

  if [ -r "$ENV_FILE" ]; then
    set -a; . "$ENV_FILE"; set +a
    if [ -n "${DATABASE_URL:-}" ] && db_probe "$DATABASE_URL"; then
      log "[가드] DB 연결(DATABASE_URL) ... PASS"
    else
      log "[가드] DB 연결(DATABASE_URL) ... FAIL"
      ok=0
    fi
  else
    log "[가드] DB 연결(DATABASE_URL) ... FAIL ($ENV_FILE 을 읽을 수 없음)"
    ok=0
  fi

  # 가드 D: 오늘자(KST) R2 백업 존재 — Stage 2 에서 새 백업을 뜨기 전에도
  # 예약된 일간 백업 파이프라인 자체가 살아있는지 별도로 확인한다.
  local today_prefix r2_bucket latest_today
  today_prefix="$(TZ=Asia/Seoul date +%Y%m%d)"
  if [ -r "$R2_CREDS_FILE" ]; then
    r2_bucket="$(grep -E '^R2_BUCKET=' "$R2_CREDS_FILE" | head -1 | cut -d= -f2-)"
  else
    r2_bucket=""
  fi
  if [ -z "$r2_bucket" ]; then
    log "[가드] 오늘자(KST $today_prefix) R2 백업 존재 ... FAIL (R2_BUCKET 을 $R2_CREDS_FILE 에서 읽지 못함)"
    ok=0
  else
    latest_today="$(rclone lsf "${R2_REMOTE}:${r2_bucket}/${R2_BACKUP_PREFIX}/" --dirs-only 2>/dev/null \
      | sed 's#/$##' | grep "^${today_prefix}-" | sort | tail -1 || true)"
    if [ -n "$latest_today" ]; then
      local cnt
      cnt="$(rclone lsjson "${R2_REMOTE}:${r2_bucket}/${R2_BACKUP_PREFIX}/${latest_today}" 2>/dev/null \
        | jq '[.[] | select(.Size > 0)] | length' 2>/dev/null || echo 0)"
      if [ "${cnt:-0}" -eq 2 ]; then
        log "[가드] 오늘자(KST $today_prefix) R2 백업 존재 ... PASS ($latest_today, 객체 2개)"
      else
        log "[가드] 오늘자(KST $today_prefix) R2 백업 존재 ... FAIL ($latest_today 객체 ${cnt:-0}개, 2개 기대)"
        ok=0
      fi
    else
      log "[가드] 오늘자(KST $today_prefix) R2 백업 존재 ... FAIL (오늘 날짜 접두사 백업 없음)"
      ok=0
    fi
  fi

  # 가드 E: 뒤 단계가 부르는 호스트 실행파일이 전부 PATH 에서 잡히는지.
  # 사전 점검의 존재 이유가 "파괴적 작업 전에 막는다"인데, 이것이 없으면
  # Stage 2(백업)까지 다 돌고 Stage 3a 에서 `pg_dump: command not found`
  # 로 죽는다 — 이 레포에서 PATH 미해석은 이미 세 번 재발한 부류다.
  local bin missing_bins=""
  for bin in psql pg_dump docker rclone jq curl node npx cloudflared; do
    if ! command -v "$bin" >/dev/null 2>&1; then
      missing_bins="${missing_bins:+$missing_bins }$bin"
    fi
  done
  if [ -z "$missing_bins" ]; then
    log "[가드] 필수 실행파일(psql·pg_dump·docker·rclone·jq·curl·node·npx·cloudflared) ... PASS"
  else
    log "[가드] 필수 실행파일 ... FAIL (PATH 에서 찾지 못함: $missing_bins)"
    log "        psql/pg_dump 가 없으면 'brew install libpq' 후 이 스크립트 상단의"
    log "        PATH 후보 목록에 그 keg 경로가 포함되는지 확인하십시오."
    ok=0
  fi

  # 가드 F: Stage 3~4 가 요구하는 컷오버 전용 크리덴셜이 미리 준비됐는지.
  # 값은 절대 출력하지 않고 "비어있지 않은가"만 본다(공개 레포·로그 안전).
  if [ -r "$CUTOVER_ENV_FILE" ]; then
    local missing_keys="" key
    for key in PROD_URL SRC_URL SRC_SERVICE_KEY; do
      if ! (set -a; . "$CUTOVER_ENV_FILE"; set +a; eval "[ -n \"\${$key:-}\" ]"); then
        missing_keys="${missing_keys:+$missing_keys }$key"
      fi
    done
    if [ -z "$missing_keys" ]; then
      log "[가드] 컷오버 크리덴셜($CUTOVER_ENV_FILE, 3개 키) ... PASS"
    else
      log "[가드] 컷오버 크리덴셜 ... FAIL (값이 비었음: $missing_keys)"
      log "        ⚠️ 값에 \$ 가 있으면 셸 소싱에서 조용히 잘린다 — 단일 인용부호로 감쌀 것."
      ok=0
    fi
  else
    log "[가드] 컷오버 크리덴셜 ... FAIL ($CUTOVER_ENV_FILE 를 읽을 수 없음 — README 「.env.cutover」 절 참고)"
    ok=0
  fi

  [ "$ok" -eq 1 ] || abort 1 "사전 점검" "위 가드 중 하나 이상 FAIL — 프로덕션은 여전히 이전 배포가 서빙 중이고 아무 것도 변경되지 않았습니다. 모든 가드가 PASS 할 때까지 재시도하십시오."
  log "Stage 1 통과 — 모든 가드 PASS"
}

# ══════════════════════════ Stage 2 ══════════════════════════
stage2_backup() {
  enter_stage 2 "파괴적 작업 전 백업 선행"
  if ! "$REPO_ROOT/infra/selfhost/backup.sh"; then
    abort 2 "백업 선행" "backup.sh 가 실패했습니다 — 최신 백업 없이는 절대 Stage 3(데이터 재동기화, 파괴적)로 진행하지 않습니다. 로컬 데이터는 아직 전혀 변경되지 않았습니다."
  fi
  log "Stage 2 통과 — 최신 백업 확보 완료"
}

# ══════════════════════════ Stage 3 ══════════════════════════
apply_auth_table_upsert() {
  # $1=스키마.테이블 $2=콤마 컬럼목록 $3=conflict 대상 컬럼(콤마 가능) $4=tmpdir
  local table="$1" cols="$2" conflict_cols="$3" tmpdir="$4"
  local safe_name="${table//./_}"
  local data_file="$tmpdir/${safe_name}.tsv"
  local script_file="$tmpdir/${safe_name}.sql"

  if ! psql "$PROD_URL" -v ON_ERROR_STOP=1 -c "COPY (SELECT $cols FROM $table) TO stdout" > "$data_file"; then
    log "$table 클라우드 COPY 실패"
    return 1
  fi

  local set_clause
  set_clause="$(build_set_clause "$cols" "${conflict_cols%%,*}")"

  {
    echo "BEGIN;"
    echo "CREATE TEMP TABLE _cutover_staging AS SELECT $cols FROM $table WHERE false;"
    echo "COPY _cutover_staging ($cols) FROM stdin;"
    cat "$data_file"
    echo '\.'
    echo "INSERT INTO $table ($cols) SELECT $cols FROM _cutover_staging"
    echo "ON CONFLICT ($conflict_cols) DO UPDATE SET $set_clause;"
    echo "COMMIT;"
  } > "$script_file"

  docker cp "$script_file" "$DB_CONTAINER:/tmp/_cutover_auth_apply.sql"
  if ! docker exec "$DB_CONTAINER" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
      -f /tmp/_cutover_auth_apply.sql > "$tmpdir/${safe_name}-apply.log" 2>&1; then
    tee -a "$LOG_FILE" < "$tmpdir/${safe_name}-apply.log"
    docker exec "$DB_CONTAINER" rm -f /tmp/_cutover_auth_apply.sql || true
    return 1
  fi
  docker exec "$DB_CONTAINER" rm -f /tmp/_cutover_auth_apply.sql || true
  return 0
}

sync_auth_rows() {
  local tmpdir="$1"
  log "[3e] auth.users/auth.identities 행 재동기화(ID 보존, upsert)..."

  # is_generated <> 'ALWAYS' 로 GENERATED ALWAYS AS (...) STORED 컬럼(예:
  # GoTrue 의 auth.users.confirmed_at)을 교집합에서 미리 제외한다 — 그런
  # 컬럼은 두 쪽 information_schema.columns 에 똑같이 존재해 교집합에
  # 들어가버리지만, INSERT/UPDATE 로 값을 넣으려 하면 Postgres 가
  # "cannot insert into column ... generated column" 으로 거부한다.
  local users_cols identities_cols cloud_users_cols cloud_identities_cols
  users_cols="$(docker exec "$DB_CONTAINER" psql -U postgres -d postgres -t -A -c \
    "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema='auth' and table_name='users' and is_generated <> 'ALWAYS';")"
  identities_cols="$(docker exec "$DB_CONTAINER" psql -U postgres -d postgres -t -A -c \
    "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema='auth' and table_name='identities' and is_generated <> 'ALWAYS';")"
  cloud_users_cols="$(psql "$PROD_URL" -t -A -c \
    "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema='auth' and table_name='users' and is_generated <> 'ALWAYS';")"
  cloud_identities_cols="$(psql "$PROD_URL" -t -A -c \
    "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema='auth' and table_name='identities' and is_generated <> 'ALWAYS';")"

  if [ -z "$users_cols" ] || [ -z "$cloud_users_cols" ]; then
    log "auth.users 컬럼 목록을 읽지 못했습니다(로컬 또는 클라우드)."
    return 1
  fi
  if [ -z "$identities_cols" ] || [ -z "$cloud_identities_cols" ]; then
    log "auth.identities 컬럼 목록을 읽지 못했습니다(로컬 또는 클라우드)."
    return 1
  fi

  local common_users_cols common_identities_cols
  common_users_cols="$(intersect_csv "$users_cols" "$cloud_users_cols")"
  common_identities_cols="$(intersect_csv "$identities_cols" "$cloud_identities_cols")"

  # 반드시 보존할 컬럼(README/계획 Task 8 Step 3) — 교집합에서 빠지면
  # 소유권/역할 판정이 조용히 깨지므로 그 전에 중단한다.
  local must
  for must in id email raw_app_meta_data raw_user_meta_data; do
    case ",$common_users_cols," in
      *",$must,"*) ;;
      *) log "필수 컬럼 누락: auth.users.$must — 중단합니다."; return 1 ;;
    esac
  done
  for must in user_id provider provider_id; do
    case ",$common_identities_cols," in
      *",$must,"*) ;;
      *) log "필수 컬럼 누락: auth.identities.$must — 중단합니다."; return 1 ;;
    esac
  done

  log "[3e] auth.users 교집합 컬럼: $common_users_cols"
  log "[3e] auth.identities 교집합 컬럼: $common_identities_cols"

  # identities 의 conflict 대상: GoTrue 신버전은 id(uuid) PK, 구버전은
  # (provider, provider_id) 복합 unique — 교집합에 id 가 있으면 그것을,
  # 없으면 복합키를 쓴다.
  local identities_conflict="provider, provider_id"
  case ",$common_identities_cols," in *",id,"*) identities_conflict="id" ;; esac

  apply_auth_table_upsert "auth.users" "$common_users_cols" "id" "$tmpdir" \
    || { log "auth.users 재동기화 실패"; return 1; }
  apply_auth_table_upsert "auth.identities" "$common_identities_cols" "$identities_conflict" "$tmpdir" \
    || { log "auth.identities 재동기화 실패"; return 1; }

  log "[3e] auth 행 재동기화 완료"
  return 0
}

stage3_resync_data() {
  enter_stage 3 "최종 데이터 재동기화"

  [ -r "$CUTOVER_ENV_FILE" ] || abort 3 "최종 데이터 재동기화" "$CUTOVER_ENV_FILE 를 읽을 수 없습니다(PROD_URL/SRC_URL/SRC_SERVICE_KEY 필요) — 로컬 데이터는 아직 전혀 변경되지 않았습니다."
  set -a; . "$CUTOVER_ENV_FILE"; set +a
  : "${PROD_URL:?PROD_URL 미설정 — $CUTOVER_ENV_FILE 확인. 로컬 데이터는 아직 전혀 변경되지 않았습니다.}"
  : "${SRC_URL:?SRC_URL 미설정 — $CUTOVER_ENV_FILE 확인. 로컬 데이터는 아직 전혀 변경되지 않았습니다.}"
  : "${SRC_SERVICE_KEY:?SRC_SERVICE_KEY 미설정 — $CUTOVER_ENV_FILE 확인. 로컬 데이터는 아직 전혀 변경되지 않았습니다.}"

  [ -r "$ENV_FILE" ] || abort 3 "최종 데이터 재동기화" "$ENV_FILE 을 읽을 수 없습니다. 로컬 데이터는 아직 전혀 변경되지 않았습니다."
  set -a; . "$ENV_FILE"; set +a
  : "${DIRECT_URL:?DIRECT_URL 미설정 — $ENV_FILE 확인. 로컬 데이터는 아직 전혀 변경되지 않았습니다.}"
  : "${NEXT_PUBLIC_SUPABASE_URL:?NEXT_PUBLIC_SUPABASE_URL 미설정 — $ENV_FILE 확인. 로컬 데이터는 아직 전혀 변경되지 않았습니다.}"
  : "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY 미설정 — $ENV_FILE 확인. 로컬 데이터는 아직 전혀 변경되지 않았습니다.}"

  local tmpdir
  tmpdir="$(mktemp -d "/tmp/wagcrm-cutover.XXXXXX")"
  CURRENT_TMPDIR="$tmpdir"

  # 3a. 클라우드 public 데이터 덤프 — 로컬을 건드리기 "전"에 먼저 뜨고
  # 검증한다. 여기서 실패하면 로컬은 원본 상태 그대로다.
  log "[3a] 클라우드 public 스키마 데이터 덤프 중..."
  if ! pg_dump --dbname="$PROD_URL" --schema=public --data-only --disable-triggers \
      --exclude-table=_prisma_migrations \
      | gzip > "$tmpdir/cloud-public-data.sql.gz"; then
    abort 3 "최종 데이터 재동기화" "클라우드 public 덤프 실패 — 로컬 데이터는 전혀 변경되지 않았습니다."
  fi
  gzip -t "$tmpdir/cloud-public-data.sql.gz" \
    || abort 3 "최종 데이터 재동기화" "클라우드 덤프가 유효한 gzip 이 아닙니다 — 로컬 데이터는 전혀 변경되지 않았습니다."
  local dump_size
  dump_size="$(wc -c < "$tmpdir/cloud-public-data.sql.gz" | tr -d ' ')"
  [ "$dump_size" -gt 1024 ] \
    || abort 3 "최종 데이터 재동기화" "클라우드 덤프 크기가 비정상적으로 작습니다(${dump_size} bytes) — 빈 덤프로 의심되어 중단합니다. 로컬 데이터는 전혀 변경되지 않았습니다."
  log "[3a] 클라우드 덤프 검증 완료: ${dump_size} bytes"
  gunzip -k "$tmpdir/cloud-public-data.sql.gz"

  # 3b. 로컬 public 스키마 드랍 — 여기서부터 로컬 데이터가 실제로 바뀐다.
  # ⚠️ DROP/CREATE SCHEMA 는 **스키마 안의 객체뿐 아니라 스키마 자체의 소유권과
  # GRANT 도 함께 날린다.** 이 명령을 supabase_admin 으로 돌리므로 새 public 은
  # `supabase_admin 소유 · ACL 없음`이 되고, 앱 롤(postgres)로 붙는 Prisma 가
  # 3c 에서 `permission denied for schema public` 으로 죽는다 — 드랍은 이미 끝난
  # 뒤라 **public 이 빈 채로 남는다**(2026-08-13 실사고, 실제 컷오버가 여기서
  # 멈췄다).
  #
  # 그래서 재생성 직후 원본(클라우드)의 상태를 그대로 복원한다(실측 대조):
  #   소유자 postgres · postgres=UC/postgres
  #   anon·authenticated·service_role = U/postgres · COMMENT 'standard public schema'
  # GRANT 를 postgres 로 실행하는 것이 중요하다 — supabase_admin 으로 주면
  # grantor 가 달라져(`anon=U/supabase_admin`) 원본과 어긋난다.
  log "[3b] 로컬 public 스키마 드랍 + 재생성(소유권·GRANT 복원 포함)..."
  if ! docker exec "$DB_CONTAINER" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
      -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO postgres;' \
      > "$tmpdir/drop.log" 2>&1; then
    tee -a "$LOG_FILE" < "$tmpdir/drop.log"
    abort 3 "최종 데이터 재동기화" "public 스키마 드랍 실패 — 로컬 public 스키마가 불완전한 상태일 수 있습니다. --stage 3 재실행은 안전합니다(이 Stage 는 드랍부터 다시 하므로 멱등)."
  fi

  if ! docker exec "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
      -c "GRANT ALL ON SCHEMA public TO postgres; GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role; COMMENT ON SCHEMA public IS 'standard public schema';" \
      > "$tmpdir/grant.log" 2>&1; then
    tee -a "$LOG_FILE" < "$tmpdir/grant.log"
    abort 3 "최종 데이터 재동기화" "public 스키마 권한 복원 실패 — 스키마는 비어있고 권한도 원본과 다릅니다. --stage 3 재실행은 안전합니다."
  fi

  # 복원 결과를 즉시 확인한다 — 여기서 어긋난 채 넘어가면 3c 가 권한 오류로
  # 죽거나(운 나쁘면) 앱이 런타임에 조용히 실패한다.
  local pub_acl
  pub_acl="$(docker exec "$DB_CONTAINER" psql -U postgres -d postgres -t -A -c \
    "select pg_get_userbyid(nspowner) || '|' || coalesce(array_to_string(nspacl, ' '), '') from pg_namespace where nspname = 'public';" | tr -d ' ')"
  case "$pub_acl" in
    postgres\|*postgres=UC*anon=U*authenticated=U*service_role=U*)
      log "[3b] public 스키마 소유권·GRANT 복원 확인: $pub_acl"
      ;;
    *)
      abort 3 "최종 데이터 재동기화" "public 스키마 소유권/GRANT 가 원본과 다릅니다(현재: ${pub_acl:-읽기 실패}). 기대: 소유자 postgres + postgres=UC + anon/authenticated/service_role=U. 스키마는 비어있는 상태입니다."
      ;;
  esac

  # 3c. 이 체크아웃의 Prisma 마이그레이션으로 재구축 — restore-drill.sh 로
  # 이미 검증된 것과 동일한 경로.
  log "[3c] Prisma 마이그레이션 재적용..."
  if ! DATABASE_URL="$DIRECT_URL" DIRECT_URL="$DIRECT_URL" \
      "$PRISMA_BIN" migrate deploy --schema="$REPO_ROOT/prisma/schema.prisma" \
      > "$tmpdir/migrate.log" 2>&1; then
    tee -a "$LOG_FILE" < "$tmpdir/migrate.log"
    abort 3 "최종 데이터 재동기화" "prisma migrate deploy 실패 — public 스키마가 비어있는 상태입니다. --stage 3 재실행은 안전합니다."
  fi

  # 3d. 클라우드 데이터 재주입 — 전체 교체(부분 머지 아님).
  log "[3d] 클라우드 데이터 재주입..."
  docker cp "$tmpdir/cloud-public-data.sql" "$DB_CONTAINER:/tmp/cloud-public-data.sql"
  if ! docker exec "$DB_CONTAINER" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
      -f /tmp/cloud-public-data.sql > "$tmpdir/restore.log" 2>&1; then
    tail -60 "$tmpdir/restore.log" | tee -a "$LOG_FILE"
    docker exec "$DB_CONTAINER" rm -f /tmp/cloud-public-data.sql || true
    abort 3 "최종 데이터 재동기화" "데이터 재주입 실패 — public 스키마는 재생성됐으나 데이터가 부분적으로만 들어갔을 수 있습니다. --stage 3 재실행은 안전합니다(드랍부터 다시 하므로 부분 상태가 누적되지 않습니다)."
  fi
  docker exec "$DB_CONTAINER" rm -f /tmp/cloud-public-data.sql || true

  # 3e. auth 행 재동기화 — 스키마는 건드리지 않고 행만, ID 보존, upsert.
  sync_auth_rows "$tmpdir" \
    || abort 3 "최종 데이터 재동기화" "auth 행 재동기화 실패 — public 데이터는 이미 새로 들어갔지만 auth.users/identities 가 최신이 아닐 수 있습니다(소유권이 최신 auth.users 와 어긋날 위험). --stage 3 재실행 가능(이 단계도 upsert 라 멱등)."

  # 3f. storage 객체 증분 재이관(기존 스크립트, upsert:true 라 멱등).
  log "[3f] storage 객체 증분 재이관..."
  if ! SRC_URL="$SRC_URL" SRC_SERVICE_KEY="$SRC_SERVICE_KEY" \
      DST_URL="$NEXT_PUBLIC_SUPABASE_URL" DST_SERVICE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
      npx tsx "$REPO_ROOT/scripts/migrate-storage-objects.ts" > "$tmpdir/storage-migrate.log" 2>&1; then
    tee -a "$LOG_FILE" < "$tmpdir/storage-migrate.log"
    abort 3 "최종 데이터 재동기화" "storage 객체 재이관 실패 — public/auth 데이터는 이미 갱신됐습니다. --stage 3 재실행 가능(업로드가 upsert:true 라 멱등)."
  fi

  rm -rf "$tmpdir"
  CURRENT_TMPDIR=""
  log "Stage 3 통과 — public 데이터 교체 + auth 행 재동기화 + storage 증분 이관 완료"
}

# ══════════════════════════ Stage 4 ══════════════════════════
stage4_verify_parity() {
  enter_stage 4 "정합성 검증"

  # --stage 4 로 곧장 재개하는 경우 이 프로세스에는 아직 PROD_URL 이 없을
  # 수 있으므로 다시 소싱한다(bare `A && B` 형태는 A 가 거짓일 때 이 문장
  # 자체가 nonzero 로 끝나 위 cleanup_tmpdir 과 같은 ERR 오탐을 낼 수
  # 있어 명시적 가드로 쓴다).
  [ -r "$CUTOVER_ENV_FILE" ] || abort 4 "정합성 검증" "$CUTOVER_ENV_FILE 를 읽을 수 없습니다(PROD_URL 필요)."
  set -a; . "$CUTOVER_ENV_FILE"; set +a
  : "${PROD_URL:?PROD_URL 미설정 — $CUTOVER_ENV_FILE 확인}"

  local tmpdir
  tmpdir="$(mktemp -d "/tmp/wagcrm-cutover-verify.XXXXXX")"
  CURRENT_TMPDIR="$tmpdir"
  local ok=1

  # 4a. public 스키마 테이블별 행수 대조.
  local tables mismatch=0 checked=0
  tables="$(psql "$PROD_URL" -t -A -c \
    "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' and table_name <> '_prisma_migrations' order by 1;")"
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    checked=$((checked + 1))
    local cn ln
    cn="$(psql "$PROD_URL" -t -A -c "select count(*) from \"$t\";" | tr -d ' ')"
    ln="$(docker exec "$DB_CONTAINER" psql -U postgres -d postgres -t -A -c "select count(*) from \"$t\";" | tr -d ' ')"
    if [ "$cn" != "$ln" ]; then
      log "[4a] FAIL 테이블 $t 행수 불일치 (클라우드=$cn 로컬=$ln)"
      mismatch=$((mismatch + 1))
      ok=0
    fi
  done <<< "$tables"
  log "[4a] 테이블별 행수 대조: ${checked}개 확인, 불일치 ${mismatch}건"
  # 대조 대상 테이블이 0개면 "불일치 0건"이 곧 "전부 통과"로 잘못 읽힐 수
  # 있다 — 실제로는 information_schema 조회 자체가 잘못됐다는(권한·
  # search_path 오류 등) 신호이므로 그 자체를 FAIL 로 취급한다.
  if [ "$checked" -eq 0 ]; then
    log "[4a] FAIL 대조한 테이블이 0개입니다 — public 스키마 조회 자체가 실패했을 수 있습니다(권한/연결 확인)."
    ok=0
  fi

  # 4b. auth.users ID 집합 완전 일치(개수가 아니라 집합).
  psql "$PROD_URL" -t -A -c "select id from auth.users order by 1;" | sort > "$tmpdir/cloud-ids.txt"
  docker exec "$DB_CONTAINER" psql -U postgres -d postgres -t -A -c "select id from auth.users order by 1;" | sort > "$tmpdir/local-ids.txt"
  local cloud_user_count
  cloud_user_count="$(wc -l < "$tmpdir/cloud-ids.txt" | tr -d ' ')"
  if [ "${cloud_user_count:-0}" -eq 0 ]; then
    # 빈 결과 두 개를 diff 하면 자동으로 "일치"가 나온다 — 클라우드 쪽
    # 조회 자체가 비어있다면(연결 실패 등) 그건 "일치"가 아니라 검증
    # 자체가 안 된 것이다.
    log "[4b] FAIL 클라우드 auth.users 조회 결과가 0건입니다 — 조회 자체가 실패했을 가능성이 있어 집합 비교를 신뢰할 수 없습니다."
    ok=0
  elif diff -q "$tmpdir/cloud-ids.txt" "$tmpdir/local-ids.txt" > /dev/null; then
    log "[4b] PASS auth.users ID 집합 완전 일치 (${cloud_user_count}명)"
  else
    local only_cloud only_local
    only_cloud="$(comm -23 "$tmpdir/cloud-ids.txt" "$tmpdir/local-ids.txt" | wc -l | tr -d ' ')"
    only_local="$(comm -13 "$tmpdir/cloud-ids.txt" "$tmpdir/local-ids.txt" | wc -l | tr -d ' ')"
    log "[4b] FAIL auth.users ID 집합 불일치 (클라우드에만 ${only_cloud}건, 로컬에만 ${only_local}건)"
    ok=0
  fi

  # 4c. 소유권 참조(createdBy/userId) 고아 — 계획 문서 Task 8 이 지목한
  # 컬럼(prisma/schema.prisma: Notification.userId, ActionProposal/
  # PriceSheet/AssistantConversation/ReferenceInboxItem.createdBy). 'AGENT'
  # 는 시스템 생성 sentinel 값이라 실사용자 ID 가 아니므로 제외한다.
  #
  # ⚠️ 판정 기준은 **절대 0 이 아니라 원본 대비 동수**다. 프로덕션 원본에 이미
  # 고아가 있다(실측 2026-08-13: 176건 = Notification 161 · ActionProposal 7 ·
  # PriceSheet 8 — 삭제된 계정을 가리키는 기존 데이터 부채). 절대 0 을 요구하면
  # **원본을 한 행도 틀리지 않게 옮겼는데 검증이 실패**하는 모순이 되고, 실제로
  # 컷오버가 여기서 멈췄다. Stage 4 의 나머지 항목(4a 행수 · 4b ID 집합 ·
  # 4d 버킷)은 전부 parity 계약이다 — 4c 만 절대 불변식이었던 것이 결함이다.
  # 로컬이 원본보다 **많으면** 이관 과정에서 생긴 것이므로 FAIL 이다.
  local orphan_sql orphan_local orphan_cloud
  orphan_sql="
    select
      (select count(*) from \"Notification\" where \"userId\" is not null and \"userId\" not in (select id::text from auth.users)) +
      (select count(*) from \"ActionProposal\" where \"createdBy\" is not null and \"createdBy\" <> 'AGENT' and \"createdBy\" not in (select id::text from auth.users)) +
      (select count(*) from \"AssistantConversation\" where \"createdBy\" is not null and \"createdBy\" not in (select id::text from auth.users)) +
      (select count(*) from \"PriceSheet\" where \"createdBy\" is not null and \"createdBy\" <> 'AGENT' and \"createdBy\" not in (select id::text from auth.users)) +
      (select count(*) from \"ReferenceInboxItem\" where \"createdBy\" is not null and \"createdBy\" not in (select id::text from auth.users));
  "
  orphan_cloud="$(psql "$PROD_URL" -t -A -c "$orphan_sql" | tr -d ' ')"
  orphan_local="$(docker exec "$DB_CONTAINER" psql -U postgres -d postgres -t -A -c "$orphan_sql" | tr -d ' ')"
  if [ -z "$orphan_cloud" ] || [ -z "$orphan_local" ]; then
    # 4b·4d 와 같은 이유 — 조회 자체가 실패하면 두 값이 모두 비어 "일치"로
    # 새어나간다. 빈 결과를 먼저 FAIL 로 잡는다.
    log "[4c] FAIL 고아 참조 조회 실패(클라우드='${orphan_cloud:-없음}' 로컬='${orphan_local:-없음}')"
    ok=0
  elif [ "$orphan_local" -eq "$orphan_cloud" ]; then
    if [ "$orphan_local" -eq 0 ]; then
      log "[4c] PASS 소유권 참조 고아 0건(원본도 0건)"
    else
      log "[4c] PASS 소유권 참조 고아 ${orphan_local}건 — 원본과 동수(원본의 기존 상태를 그대로 옮긴 것이지 이관 결함이 아님)"
    fi
  else
    log "[4c] FAIL 소유권 참조 고아 로컬 ${orphan_local}건 vs 원본 ${orphan_cloud}건 — 이관 과정에서 늘었습니다."
    ok=0
  fi

  # 4d. 버킷별 storage 객체 수 대조.
  psql "$PROD_URL" -t -A -c "select bucket_id, count(*) from storage.objects group by bucket_id order by 1;" | sort > "$tmpdir/cloud-buckets.txt"
  docker exec "$DB_CONTAINER" psql -U postgres -d postgres -t -A -c "select bucket_id, count(*) from storage.objects group by bucket_id order by 1;" | sort > "$tmpdir/local-buckets.txt"
  if [ ! -s "$tmpdir/cloud-buckets.txt" ]; then
    # 4b 와 같은 이유 — 빈 결과 두 개는 자동으로 "일치"가 나오므로,
    # 클라우드 쪽 조회가 빈 것 자체를 먼저 FAIL 로 잡는다.
    log "[4d] FAIL 클라우드 storage.objects 조회 결과가 0건입니다 — 조회 자체가 실패했을 가능성이 있습니다."
    ok=0
  elif diff -q "$tmpdir/cloud-buckets.txt" "$tmpdir/local-buckets.txt" > /dev/null; then
    log "[4d] PASS 버킷별 객체 수 전부 일치"
  else
    log "[4d] FAIL 버킷별 객체 수 불일치:"
    diff "$tmpdir/cloud-buckets.txt" "$tmpdir/local-buckets.txt" | while IFS= read -r l; do log "    $l"; done
    ok=0
  fi

  rm -rf "$tmpdir"
  CURRENT_TMPDIR=""

  [ "$ok" -eq 1 ] || abort 4 "정합성 검증" "위 항목 중 하나 이상 FAIL — 데이터는 이미 Stage 3 에서 교체됐지만 프로덕션 트래픽은 아직 이전 배포로 향하고 있습니다(origin 전환 전). 원인 조사 후 --stage 3 부터 다시 수행하십시오."
  log "Stage 4 통과 — 정합성 검증 전부 PASS"
}

# ══════════════════════════ Stage 5 ══════════════════════════
stage5_switch_app_origin() {
  enter_stage 5 "앱 공개 origin 전환(재빌드)"
  local new_origin="https://$PROD_HOSTNAME"

  [ -r "$ENV_FILE" ] || abort 5 "앱 공개 origin 전환" "$ENV_FILE 을 읽을 수 없습니다."

  # 전환 **전** 값을 먼저 읽어 둔다 — 아래 산출물 검증의 음성 프로브(구 origin
  # 이 사라졌는가)가 이 값을 대조 기준으로 쓴다. set_env_var 로 덮어쓴 뒤에는
  # 알 수 없다.
  local prev_origin prev_host
  prev_origin="$(grep -E '^NEXT_PUBLIC_APP_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
  prev_host="$(origin_host_of "$prev_origin")"

  set_env_var "$ENV_FILE" "NEXT_PUBLIC_APP_URL" "$new_origin"
  set_env_var "$ENV_FILE" "NEXT_PUBLIC_SITE_URL" "$new_origin"
  log "[5] $ENV_FILE 의 NEXT_PUBLIC_APP_URL/NEXT_PUBLIC_SITE_URL 을 $new_origin 으로 갱신"

  if ! FORCE=1 "$REPO_ROOT/infra/selfhost/deploy.sh"; then
    abort 5 "앱 공개 origin 전환" "deploy.sh 재빌드/재기동 실패 — .env 는 이미 새 origin 으로 바뀌었지만 서비스는 아직 이전 빌드를 서빙 중일 수 있습니다. ~/selfhost/logs/app.err.log 확인 후 --stage 5 재실행하십시오."
  fi

  # NEXT_PUBLIC_* 은 빌드 타임에 번들로 인라이닝된다 — 재시작이 아니라 재빌드가
  # 필요했던 이유. 산출물 안에 신규 호스트네임이 실제로 들어갔는지 확인해야
  # "재빌드했다"가 아니라 "반영됐다"를 증명한다. 검사 대상이 server 산출물인
  # 이유와 양성·음성 프로브의 근거는 verify_origin_in_build 주석 참고.
  # ⚠️ 검사 대상은 **서빙 중인 릴리스**다(2026-08-29 deploy.sh 안전장치 ⑧).
  # 종전 경로 `.next/standalone/.next` 는 deploy.sh 가 산출물을 `mv` 로 옮긴 뒤라
  # **존재하지 않는다** — 그대로 두면 origin 이 정상 반영됐는데도 "빌드 산출물
  # 디렉터리가 없습니다"로 무조건 중단된다(재컷오버 때까지 잠복하는 회귀).
  if verify_origin_in_build "$REPO_ROOT/.live/current/.next" "$PROD_HOSTNAME" "$prev_host"; then
    log "[5] 빌드 산출물 반영 확인 — $BUILD_ORIGIN_DETAIL"
  else
    abort 5 "앱 공개 origin 전환" "재빌드는 성공했지만 산출물 검증에 실패했습니다($BUILD_ORIGIN_DETAIL). NEXT_PUBLIC_* 인라이닝이 안 됐거나 이전 빌드 산출물이 그대로 남아 있을 수 있습니다. 서비스는 이미 재시작됐으나 여전히 이전 origin 으로 링크를 생성할 위험이 있습니다."
  fi
  log "Stage 5 통과"
}

# ══════════════════════════ Stage 6 ══════════════════════════
stage6_switch_auth_origin() {
  enter_stage 6 "인증 서비스(GoTrue) origin 전환"
  local new_origin="https://$PROD_HOSTNAME"

  [ -f "$SUPABASE_DOCKER_ENV" ] || abort 6 "인증 서비스 origin 전환" "$SUPABASE_DOCKER_ENV 를 찾을 수 없습니다."

  # ⚠️ 절대 이 파일을 이 셸에 source 하지 않는다. 이 파일에는 JSON 값을
  # 담은 변수가 있고, `set -a; . 파일; set +a` 로 source 하면 셸이 그 값의
  # 따옴표를 벗겨버린다 — 이후 docker compose 는 --env-file 로 준 파일
  # 값보다 이미 이 셸에 export 된 값을 우선하므로, 벗겨진(깨진) 값이
  # 컨테이너에 그대로 주입돼 크래시루프가 난다. 그래서 이 함수는 파일을
  # sed/awk(set_env_var)로만 고치고, docker compose 호출은 항상
  # --env-file 로 "경로"만 넘긴다 — 이 셸의 환경변수를 통해서가 아니라.
  set_env_var "$SUPABASE_DOCKER_ENV" "SITE_URL" "$new_origin"
  log "[6] $SUPABASE_DOCKER_ENV 의 SITE_URL 을 $new_origin 으로 갱신(이 셸에 source 하지 않음)"

  if ! ( cd "$SUPABASE_DOCKER_DIR" && docker compose --env-file "$SUPABASE_DOCKER_ENV" restart auth ); then
    abort 6 "인증 서비스 origin 전환" "auth(GoTrue) 컨테이너 재시작 실패 — SITE_URL 은 파일에 반영됐지만 서비스에는 아직 적용되지 않았을 수 있습니다. 'docker ps'/'docker logs $AUTH_CONTAINER' 확인 후 --stage 6 재실행하십시오."
  fi

  sleep 2
  # 컨테이너 안의 변수 이름은 GOTRUE_SITE_URL 이다(read_auth_site_url 주석 —
  # 종전의 `printenv SITE_URL` 은 정상 전환에서도 항상 빈 값이라 여기서 멈췄다).
  read_auth_site_url "$AUTH_CONTAINER" || true
  if [ "$AUTH_SITE_URL_VALUE" != "$new_origin" ]; then
    abort 6 "인증 서비스 origin 전환" "재시작된 $AUTH_CONTAINER 의 SITE_URL 이 신규 origin 과 다릅니다(읽은 변수: ${AUTH_SITE_URL_KEY:-GOTRUE_SITE_URL/SITE_URL 둘 다 비어 있음}, 현재: '${AUTH_SITE_URL_VALUE:-없음}', 기대: '$new_origin'). 먼저 'docker ps' 로 크래시루프 여부를 확인하십시오(위 JSON 소싱 함정 참고 — 이 셸에 그 .env 를 source 하지 않았는지 재확인)."
  fi
  log "Stage 6 통과 — $AUTH_CONTAINER 가 ${AUTH_SITE_URL_KEY}=$new_origin 로 재기동 확인"
}

# ══════════════════════════ Stage 7 ══════════════════════════
stage7_route_dns() {
  enter_stage 7 "프로덕션 호스트네임 라우팅"

  [ -f "$CLOUDFLARED_CONFIG" ] || abort 7 "프로덕션 호스트네임 라우팅" "$CLOUDFLARED_CONFIG 를 찾을 수 없습니다."

  if grep -q "hostname: $PROD_HOSTNAME" "$CLOUDFLARED_CONFIG"; then
    log "[7] ingress 규칙이 이미 있습니다 — 추가하지 않음"
  else
    # catch-all(`- service: http_status:404`, cloudflared-config.example.yml
    # 관례상 반드시 마지막 규칙) 바로 앞에 새 규칙을 끼워넣는다.
    local tmp
    tmp="$(mktemp)"
    awk -v host="$PROD_HOSTNAME" '
      /- service: http_status:404/ && !done {
        print "  - hostname: " host
        print "    service: http://127.0.0.1:3000"
        done=1
      }
      { print }
    ' "$CLOUDFLARED_CONFIG" > "$tmp"
    if ! grep -q "hostname: $PROD_HOSTNAME" "$tmp"; then
      rm -f "$tmp"
      abort 7 "프로덕션 호스트네임 라우팅" "catch-all 규칙을 찾지 못해 ingress 를 추가하지 못했습니다 — $CLOUDFLARED_CONFIG 형식을 확인하십시오. 파일은 아직 변경되지 않았습니다."
    fi
    mv "$tmp" "$CLOUDFLARED_CONFIG"
    log "[7] $CLOUDFLARED_CONFIG 에 ingress 규칙 추가: $PROD_HOSTNAME → 127.0.0.1:3000"
  fi

  # 이 호스트네임에는 **이미 이전 배포를 가리키는 레코드가 있다**(실측:
  # crm.ygrd.kr 은 외부 플랫폼으로 향하는 CNAME). cloudflared 는 기존
  # 레코드가 있으면 기본적으로 거부하므로(code 1003) --overwrite-dns 가
  # 없으면 Stage 3~6(파괴적 재동기화 + origin 전환)을 모두 끝낸 뒤 바로
  # 여기서 멈춘다 — 앱은 새 주소로 빌드됐는데 DNS 는 옛 배포를 가리키는
  # 최악의 중간 상태다. 덮어쓰기가 이 Stage 의 목적 자체이므로 플래그를
  # 명시한다.
  #
  # 되돌릴 때 무엇으로 원복해야 하는지 알 수 있도록, 덮어쓰기 전 기존
  # 레코드를 로그에 남긴다(rollback.sh 의 수동 DNS 복구 안내용).
  local prev_dns
  prev_dns="$(dig +short CNAME "$PROD_HOSTNAME" 2>/dev/null | head -1 || true)"
  log "[7] 덮어쓰기 전 기존 DNS 레코드: ${prev_dns:-(CNAME 없음)} — 롤백 시 이 값으로 원복"

  if ! cloudflared tunnel route dns --overwrite-dns "$TUNNEL_NAME" "$PROD_HOSTNAME"; then
    abort 7 "프로덕션 호스트네임 라우팅" "cloudflared tunnel route dns 실패 — DNS 가 아직 이전 배포를 가리키고 있을 수 있습니다."
  fi

  if ! launchctl kickstart -k "gui/$(id -u)/kr.ygrd.wagcrm.tunnel"; then
    abort 7 "프로덕션 호스트네임 라우팅" "터널 서비스 재기동 실패 — ingress/DNS 는 이미 바뀌었지만 실행 중인 cloudflared 는 옛 설정을 물고 있을 수 있습니다."
  fi

  # 판별자는 selfhost_serving_check 다 — `/` 의 200 은 신·구 배포를 구분하지
  # 못할 뿐 아니라 정상 상태에서도 나오지 않는다(그 함수 주석 참고).
  log "[7] 외부 서빙 확인 중(자체호스팅 스택 판별)..."
  local i serve_ok=0
  for i in $(seq 1 30); do
    if selfhost_serving_check; then serve_ok=1; break; fi
    sleep 5
  done
  [ "$serve_ok" -eq 1 ] || abort 7 "프로덕션 호스트네임 라우팅" "https://$PROD_HOSTNAME 이 30회(약 2분30초) 동안 자체호스팅 스택으로 판정되지 않았습니다(마지막 근거: ${SERVE_CHECK_DETAIL:-없음}). DNS 전파 지연이거나 터널 설정 오류일 수 있습니다."
  log "Stage 7 통과 — https://$PROD_HOSTNAME 이 자체호스팅 스택에서 서빙됨을 확인($SERVE_CHECK_DETAIL)"
}

# ══════════════════════════ Stage 8 ══════════════════════════
stage8_activate_held_cron() {
  enter_stage 8 "보류 크론 5개 활성화"

  if [ "$CONFIRM_OLD_CRON_OFF" -ne 1 ]; then
    abort 8 "보류 크론 활성화" "--confirm-old-cron-off 플래그가 없습니다. 이전(클라우드) 배포의 크론이 완전히 꺼졌다는 확인 없이는 진행하지 않습니다 — 양쪽이 동시에 발화하면 네이버 주문/정산 동기화·세금계산서 확인·미디어 재호스팅·인스타그램 토큰 갱신이 이중 실행돼 외부 시스템에 실제 사고가 납니다. 지금까지의 다른 단계는 이미 완료돼 트래픽은 이 스택이 받고 있습니다 — 크론만 아직 보류 상태입니다."
  fi

  if [ -t 0 ]; then
    printf '[cutover] 이전(클라우드) 배포의 크론이 완전히 꺼졌음을 직접 확인했습니까? 정확히 다음 문구를 입력하십시오: OLD CRON DISABLED\n> '
    local confirm_text=""
    read -r confirm_text
    if [ "$confirm_text" != "OLD CRON DISABLED" ]; then
      abort 8 "보류 크론 활성화" "확인 문구가 일치하지 않아 중단합니다(입력값: '${confirm_text}')."
    fi
  else
    warn "비대화형 실행이라 대화형 재확인을 생략합니다 — --confirm-old-cron-off 플래그만 근거로 진행합니다. 이 사실이 $LOG_FILE 에 남습니다(사후 감사용)."
  fi

  [ -w "$CRONTAB_FILE" ] || abort 8 "보류 크론 활성화" "$CRONTAB_FILE 에 쓸 수 없습니다."

  local job
  for job in $HELD_CRON_JOBS; do
    if grep -q "^# .*run-cron\.sh ${job} " "$CRONTAB_FILE"; then
      sed -i.bak "s|^# \(.*run-cron\.sh ${job} .*\)|\1|" "$CRONTAB_FILE"
      rm -f "${CRONTAB_FILE}.bak"
      log "[8] 언주석 처리: $job"
    else
      log "[8] 이미 활성 상태이거나 예상한 형식이 아님(스킵): $job"
    fi
  done

  if ! crontab "$CRONTAB_FILE"; then
    abort 8 "보류 크론 활성화" "crontab 재설치 실패 — $CRONTAB_FILE 은 이미 언주석 상태로 수정됐을 수 있습니다. 'crontab -l' 로 현재 설치 상태를 확인하십시오."
  fi

  local after expected
  after="$(installed_cron_count)"
  expected="$(expected_cron_count)"
  if [ "${after:-0}" -ne "${expected:-0}" ]; then
    abort 8 "보류 크론 활성화" "crontab 설치 후 활성 잡이 ${expected:-0}개가 아니라 ${after:-0}개입니다 — 'crontab -l' 로 확인하십시오."
  fi
  log "Stage 8 통과 — 크론 ${expected}개 전부 활성('crontab -l' 확인)"
}

# ══════════════════════════ Stage 9 ══════════════════════════
stage9_post_verify() {
  enter_stage 9 "컷오버 후 검증"
  local ok=1

  # Stage 7 과 **같은 판별자**를 쓴다. 종전에는 `/` 의 200 을 요구해 정상
  # 상태에서도 이 항목만 FAIL 이 났고(2026-08-13 실행이 code=307 로 미완처럼
  # 종료), 로그인 화면 렌더는 그 판별자가 이미 포함한다.
  if selfhost_serving_check; then
    log "[9] 프로덕션 호스트네임을 자체호스팅 스택이 서빙(로그인 화면 렌더 포함) ... PASS ($SERVE_CHECK_DETAIL)"
  else
    log "[9] 프로덕션 호스트네임을 자체호스팅 스택이 서빙 ... FAIL ($SERVE_CHECK_DETAIL)"
    ok=0
  fi

  # 위 항목이 "누가 서빙하는가"라면 이쪽은 "인증 게이트가 살아있는가"다 —
  # 미인증 `/` 가 200 이면 그것이 사고이므로, 같은 요청을 상태코드만 바꿔
  # 다시 확인하는 것이 아니라 리다이렉트 대상까지 본다.
  if auth_gate_check; then
    log "[9] 미인증 접근의 로그인 리다이렉트 ... PASS ($AUTH_GATE_DETAIL)"
  else
    log "[9] 미인증 접근의 로그인 리다이렉트 ... FAIL ($AUTH_GATE_DETAIL)"
    ok=0
  fi

  if [ -r "$ENV_FILE" ]; then
    set -a; . "$ENV_FILE"; set +a
    if [ -n "${DATABASE_URL:-}" ] && db_probe "$DATABASE_URL"; then
      log "[9] DB 연결 ... PASS"
    else
      log "[9] DB 연결 ... FAIL"; ok=0
    fi
  else
    log "[9] DB 연결 ... FAIL ($ENV_FILE 없음)"; ok=0
  fi

  local cron_count cron_expected
  cron_count="$(installed_cron_count)"
  cron_expected="$(expected_cron_count)"
  if [ "${cron_count:-0}" -eq "${cron_expected:-0}" ]; then log "[9] 크론 ${cron_expected}개 활성 ... PASS"; else log "[9] 크론 ${cron_expected}개 활성 ... FAIL (${cron_count:-0}개)"; ok=0; fi

  local backup_svc_count
  backup_svc_count="$(launchctl list 2>/dev/null | grep -c 'kr\.ygrd\.wagcrm\.backup' || true)"
  if [ "${backup_svc_count:-0}" -eq 2 ]; then log "[9] 백업 스케줄 2개(일간+주간) 등록 ... PASS"; else log "[9] 백업 스케줄 2개 등록 ... FAIL (${backup_svc_count:-0}개)"; ok=0; fi

  [ "$ok" -eq 1 ] || abort 9 "컷오버 후 검증" "위 항목 중 하나 이상 FAIL — 트래픽 전환·크론 활성화는 이미 실행된 상태입니다. 각 항목을 개별 조사하십시오. rollback.sh 는 origin/DNS/크론만 되돌리고 이 시점 이후 self-host 에 쓰인 데이터는 되돌리지 않습니다."
  log "=== Stage 9 통과 — 컷오버 완료 ==="
}

# ══════════════════════════ 메인 디스패처 ══════════════════════════

# 테스트 전용: 함수만 정의하고 여기서 멈춘다(CUTOVER_TEST_* 오버라이드와 같은
# 계열 — 운영에서는 절대 설정하지 않는다). 계약 테스트가 개별 검사기를 직접
# 호출할 수 있는 유일한 통로다. 이 통로가 없으면 검사기 하나를 확인하려고
# 스크립트 전체(=파괴적 단계)를 돌려야 하고, 그래서 지금까지 이 부류의
# 오탐이 **실제 컷오버 실행 중에야** 드러났다(2026-08-13, 4건).
if [ -n "${CUTOVER_TEST_LIB_ONLY:-}" ]; then
  return 0 2>/dev/null || exit 0
fi

log "cutover.sh 시작 (DRY_RUN=$DRY_RUN, START_STAGE=$START_STAGE, CONFIRM_OLD_CRON_OFF=$CONFIRM_OLD_CRON_OFF)"

if [ "$DRY_RUN" -eq 1 ]; then
  print_plan
  log "--dry-run: 아무 것도 실행하지 않고 종료"
  exit 0
fi

stage1_preflight

if [ "$START_STAGE" -le 2 ]; then stage2_backup; else log "Stage 2 스킵(--stage $START_STAGE 로 재개)"; fi
if [ "$START_STAGE" -le 3 ]; then stage3_resync_data; else log "Stage 3 스킵(--stage $START_STAGE 로 재개)"; fi
if [ "$START_STAGE" -le 4 ]; then stage4_verify_parity; else log "Stage 4 스킵(--stage $START_STAGE 로 재개)"; fi
if [ "$START_STAGE" -le 5 ]; then stage5_switch_app_origin; else log "Stage 5 스킵(--stage $START_STAGE 로 재개)"; fi
if [ "$START_STAGE" -le 6 ]; then stage6_switch_auth_origin; else log "Stage 6 스킵(--stage $START_STAGE 로 재개)"; fi
if [ "$START_STAGE" -le 7 ]; then stage7_route_dns; else log "Stage 7 스킵(--stage $START_STAGE 로 재개)"; fi
if [ "$START_STAGE" -le 8 ]; then stage8_activate_held_cron; else log "Stage 8 스킵(--stage $START_STAGE 로 재개)"; fi
stage9_post_verify

log "=== 컷오버 완료 ==="
exit 0
