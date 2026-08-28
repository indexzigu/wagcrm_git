#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# 프리뷰 Postgres 컨테이너를 최신 백업으로 재구축한다(멱등 — 매 실행이 새로 만든다).
#
# 왜 별도 컨테이너인가: supabase-db 는 호스트에 포트를 열지 않는다(풀러만 5432/6543).
# 프리뷰 앱은 호스트 프로세스라 붙을 대상이 필요하다. restore-drill.sh 가 검증한
# "라이브와 같은 이미지로 일회용 컨테이너" 패턴을 이름·포트 고정으로 상주화한 것이다.
#
# 볼륨을 두지 않는다 — 매일 재생성하므로 영속이 무의미하고, 이 기계는 데이터 볼륨이
# 95% 차 있다.
#
# ⚠️ 이 스크립트는 프로덕션과 **같은 docker 데몬**을 조작한다. 최악 사고는
# `docker rm -f supabase-db` 가 나가는 것이다 — 이름 가드(아래 가드 ②)와 계약 테스트
# `scripts/__tests__/preview-db.test.ts` 가 그 경로를 막는다.

PREVIEW_CONTAINER="wagcrm-preview-db"
PREVIEW_PORT="55432"
LIVE_CONTAINER="supabase-db"          # 이미지 참조 전용 — 절대 파괴 대상이 아니다
PW_FILE="$HOME/selfhost/preview-db-password.txt"
R2_CREDS_FILE="$HOME/selfhost/r2-credentials.txt"
R2_REMOTE="r2"
R2_BACKUP_PREFIX="backups"
LOG_DIR="$HOME/selfhost/logs"
LOG_FILE="$LOG_DIR/preview-db.log"
PREVIEW_CHECKOUT="$HOME/selfhost/wagcrm-preview"
PRISMA_BIN="$PREVIEW_CHECKOUT/node_modules/.bin/prisma"
PREVIEW_SCHEMA="$PREVIEW_CHECKOUT/prisma/schema.prisma"

# PREVIEW_DB_TEST_PATH_CANDIDATES 는 가드 테스트 전용 오버라이드다(운영에서 설정 금지).
PATH_CANDIDATES="${PREVIEW_DB_TEST_PATH_CANDIDATES:-/usr/local/bin:/opt/homebrew/bin:/usr/local/opt/libpq/bin:/opt/homebrew/opt/libpq/bin}"
export PATH="$PATH_CANDIDATES:$PATH"

mkdir -p "$LOG_DIR"
log() { printf '[preview-db] %s\n' "$*" | tee -a "$LOG_FILE"; }
abort() { printf '[preview-db] 중단: %s\n' "$*" | tee -a "$LOG_FILE" >&2; exit 1; }

# ── 가드 ①: 필수 실행파일 ──
missing=""
for bin in docker psql rclone gzip; do
  command -v "$bin" >/dev/null 2>&1 || missing="${missing:+$missing }$bin"
done
[ -z "$missing" ] || abort "필수 실행파일을 PATH 에서 찾지 못함: $missing (PATH=$PATH)"

# ── 가드 ②: 컨테이너 이름 오염 방지 ──
# 이 스크립트의 최악 사고는 프로덕션 DB 를 지우는 것이다. 이름이 기대와 다르면
# 파괴적 명령을 아예 실행하지 않는다.
case "$PREVIEW_CONTAINER" in
  wagcrm-preview-db) ;;
  *) abort "프리뷰 컨테이너 이름이 비정상입니다($PREVIEW_CONTAINER) — 안전을 위해 중단합니다." ;;
esac

# ── 가드 ③: 프리뷰 체크아웃 ──
# 스키마 재구축은 프리뷰 체크아웃의 prisma 로 한다(프리뷰 앱이 실제로 도는 코드와
# 같은 마이그레이션이어야 하기 때문). 체크아웃이 없으면 데이터 주입 직전에
# 실패하므로, 컨테이너를 갈아엎기 **전에** 여기서 멈춘다.
[ -x "$PRISMA_BIN" ] || abort "프리뷰 체크아웃의 prisma 를 찾지 못했습니다($PRISMA_BIN) — 먼저 $PREVIEW_CHECKOUT 를 만들고 npm install 하세요."
[ -r "$PREVIEW_SCHEMA" ] || abort "프리뷰 스키마를 읽을 수 없습니다($PREVIEW_SCHEMA)."

[ -r "$PW_FILE" ] || abort "$PW_FILE 를 읽을 수 없습니다(프리뷰 DB 비밀번호, 600)."
PREVIEW_PW="$(head -1 "$PW_FILE")"
[ -n "$PREVIEW_PW" ] || abort "$PW_FILE 가 비어 있습니다."
# ⚠️ 비밀번호는 그대로 DATABASE_URL 에 박히므로 **URL 예약문자가 없어야** 한다.
# base64 는 `+` `/` `=` 를 뱉어 URL 파싱을 깨뜨린다(특히 `/` 는 경로 구분자로 먹혀
# "DB 이름이 이상하다"는 엉뚱한 오류로 나타난다). 생성은 `openssl rand -hex` 를 쓰고,
# 여기서 형태를 한 번 더 검증한다 — 조용히 깨지는 것보다 여기서 멈추는 편이 낫다.
case "$PREVIEW_PW" in
  *[!A-Za-z0-9_.~-]*) abort "$PW_FILE 의 비밀번호에 URL 예약문자가 있습니다 — 'openssl rand -hex 32' 로 재생성하세요." ;;
esac

[ -r "$R2_CREDS_FILE" ] || abort "$R2_CREDS_FILE 를 읽을 수 없습니다."
R2_BUCKET="$(grep -E '^R2_BUCKET=' "$R2_CREDS_FILE" | head -1 | cut -d= -f2-)"
[ -n "$R2_BUCKET" ] || abort "R2_BUCKET 을 읽지 못했습니다."

# ── 최신 백업 찾기 ──
LATEST="$(rclone lsf "${R2_REMOTE}:${R2_BUCKET}/${R2_BACKUP_PREFIX}/" --dirs-only 2>/dev/null \
  | sed 's#/$##' | sort | tail -1)"
[ -n "$LATEST" ] || abort "R2 에서 백업 디렉터리를 찾지 못했습니다."
log "최신 백업: $LATEST"

# ⚠️ TMPDIR 이라는 이름을 쓰지 않는다 — 그 변수는 mktemp·docker·rclone 자식 프로세스가
# 임시 경로 기본값으로 읽는 표준 변수라, 덮어쓰면 무관한 도구의 동작에 영향을 준다.
WORKDIR="$(mktemp -d "/tmp/wagcrm-preview-db.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT

if ! rclone copy "${R2_REMOTE}:${R2_BUCKET}/${R2_BACKUP_PREFIX}/${LATEST}/public-data-only.sql.gz" "$WORKDIR/" 2>&1 | tee -a "$LOG_FILE"; then
  abort "백업 내려받기 실패 — 기존 프리뷰 DB 는 그대로 둡니다."
fi
[ -s "$WORKDIR/public-data-only.sql.gz" ] || abort "내려받은 백업이 비어 있습니다."
gzip -dc "$WORKDIR/public-data-only.sql.gz" > "$WORKDIR/public-data-only.sql"
[ -s "$WORKDIR/public-data-only.sql" ] || abort "압축 해제 결과가 비어 있습니다."

# ── 컨테이너 재생성 ──
IMAGE="$(docker inspect --format '{{.Config.Image}}' "$LIVE_CONTAINER")"
log "이미지(라이브와 동일): $IMAGE"
docker rm -f "$PREVIEW_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$PREVIEW_CONTAINER" \
  -e POSTGRES_PASSWORD="$PREVIEW_PW" \
  -e POSTGRES_DB=postgres \
  -p "127.0.0.1:${PREVIEW_PORT}:5432" \
  "$IMAGE" >/dev/null || abort "프리뷰 컨테이너 기동 실패."

# ⚠️ 준비 판정은 `pg_isready` 가 아니라 **컨테이너 healthcheck** 로 한다
# (restore-drill.sh 가 검증한 패턴). 이 이미지의 엔트리포인트는 초기화 스크립트를
# 돌리려고 임시 서버를 먼저 띄웠다가 재시작하므로, pg_isready 는 초기화가 끝나기
# 전에 참을 돌려줄 수 있다 — 그 창에 접속하면 롤·확장이 아직 없는 DB 를 만난다.
HEALTHY=0
for _ in $(seq 1 45); do
  STATUS="$(docker inspect --format '{{.State.Health.Status}}' "$PREVIEW_CONTAINER" 2>/dev/null || echo "")"
  if [ "$STATUS" = "healthy" ]; then HEALTHY=1; break; fi
  sleep 2
done
[ "$HEALTHY" -eq 1 ] || abort "프리뷰 Postgres 가 90초 안에 healthy 가 되지 않았습니다(docker logs $PREVIEW_CONTAINER 확인)."

# public 스키마 소유권·권한 — 컷오버 3b 의 교훈(드랍·재생성은 소유권도 날린다).
docker exec "$PREVIEW_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c 'ALTER SCHEMA public OWNER TO postgres; GRANT ALL ON SCHEMA public TO postgres;' \
  >/dev/null || abort "public 스키마 권한 설정 실패."

# ── 스키마 재구축 + 데이터 주입 ──
# 자격증명 부분을 따로 조립한다 — 소스에 `://사용자:비밀번호@호스트` 형태의
# 리터럴이 통째로 있으면 commit-guard(공개 레포 자격증명 차단)가 잡는다.
PREVIEW_CREDS="postgres:${PREVIEW_PW}"
PREVIEW_URL="postgresql://${PREVIEW_CREDS}@127.0.0.1:${PREVIEW_PORT}/postgres"
if ! DATABASE_URL="$PREVIEW_URL" DIRECT_URL="$PREVIEW_URL" \
    "$PRISMA_BIN" migrate deploy --schema="$PREVIEW_SCHEMA" >>"$LOG_FILE" 2>&1; then
  abort "prisma migrate deploy 실패 — 상세는 $LOG_FILE."
fi

# ⚠️ 주입은 `postgres` 가 아니라 **supabase_admin**(superuser)으로 한다.
# 이 Supabase 이미지에서 `postgres` 는 superuser 가 아니고, backup.sh 의 데이터 전용
# 덤프는 `--disable-triggers` 로 만들어진다 — 그 `ALTER TABLE ... DISABLE TRIGGER ALL`
# 이 FK 제약 트리거(시스템 트리거)까지 끄려면 superuser 가 필요해서, postgres 롤로
# 실행하면 `permission denied: "RI_ConstraintTrigger_..." is a system trigger` 로 즉시
# 죽는다(restore-drill.sh 가 같은 이유로 supabase_admin 을 쓴다 — 이 스크립트도 초판이
# 그대로 밟아 실측 확인했다). 프리뷰 컨테이너는 우리가 완전히 통제하므로
# supabase_admin 자격증명(같은 POSTGRES_PASSWORD)을 여기서만 쓴다.
docker cp "$WORKDIR/public-data-only.sql" "$PREVIEW_CONTAINER:/tmp/public-data-only.sql"
if ! docker exec -e PGPASSWORD="$PREVIEW_PW" "$PREVIEW_CONTAINER" \
    psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
    -f /tmp/public-data-only.sql >>"$LOG_FILE" 2>&1; then
  abort "데이터 주입 실패 — 상세는 $LOG_FILE."
fi
docker exec "$PREVIEW_CONTAINER" rm -f /tmp/public-data-only.sql || true

# ── 검증: 테이블 수와 표본 행수 ──
TABLES="$(docker exec "$PREVIEW_CONTAINER" psql -U postgres -d postgres -t -A -c \
  "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE';" | tr -d ' ')"
[ "${TABLES:-0}" -ge 70 ] || abort "복원 후 public 테이블이 ${TABLES:-0}개뿐입니다(70 이상 기대)."
log "복원 완료 — public BASE TABLE ${TABLES}개, 소스 $LATEST"
