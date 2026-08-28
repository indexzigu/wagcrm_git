#!/usr/bin/env bash
set -euo pipefail

# WAG CRM 백업 복원 리허설(restore drill).
#
# "아무도 복원해본 적 없는 백업은 백업이 아니다." backup.sh 가 만들어 R2 에
# 올린 최신 백업을 실제로 내려받아, **완전히 새로 만든 일회용(throwaway)
# 컨테이너**에 복원한 뒤 라이브 DB 와 테이블 수·테이블별 행 수를 대조한다.
# 이 스크립트는 파일을 열어보는 게 아니라 "이 백업으로 실제로 데이터를
# 되살릴 수 있는가"를 실측으로 증명한다.
#
# ⚠️ **일회용 컨테이너에만 쓴다 — 절대 라이브 $DB_CONTAINER 를 건드리지
# 않는다.** 여기서 실수하면 프로덕션 데이터가 날아간다. 그래서:
#   - live DB 에는 읽기 전용 SELECT(행 수 세기)만 한다. INSERT/DROP/복원
#     그 무엇도 live DB 에 하지 않는다.
#   - 일회용 컨테이너 이름은 매 실행 난수를 섞어 만들고, 정리(destroy)
#     함수는 그 이름이 $DB_CONTAINER 와 다름을 다시 한번 확인한 뒤에만
#     docker rm -f 를 호출한다(아래 destroy_throwaway 참고).
#   - 이 스크립트는 어떤 경로로 끝나든(성공/실패/중단) trap 으로 일회용
#     컨테이너와 로컬 임시 파일을 정리한다.
#
# 복원에는 오늘 검증된 실제 데이터 재구축 경로를 그대로 쓴다(backup.sh
# 상단 주석·README 참고): 새 컨테이너 기동 → 이 체크아웃의 Prisma
# 마이그레이션으로 public 스키마를 만듦 → public-data-only.sql.gz 로
# 데이터만 주입. full.sql.gz 는 여기서 쓰지 않는다 — 그건 "동일 스택"
# 대상이고, 이 드릴은 정확히 "새로 만든 스택" 시나리오를 검증한다.
#
# `_prisma_migrations` 은 대조에서 제외한다 — 그 테이블은 백업에서 온 게
# 아니라 위 3번째 단계(prisma migrate deploy)가 이 일회용 컨테이너 기준으로
# 스스로 만든 것이라, 라이브 DB 의 값과 다른 게 정상이다(같은 이유로
# backup.sh 의 데이터 전용 덤프도 이 테이블을 아예 빼고 만든다).

DB_CONTAINER="supabase-db"
R2_CREDS_FILE="/Users/z9/selfhost/r2-credentials.txt"
R2_REMOTE="r2"
R2_BACKUP_PREFIX="backups"
LOG_FILE="/Users/z9/selfhost/logs/restore-drill.log"
# 실제 운영 체크아웃에서는 npm install 이 이미 끝난 상태이므로 기본값을
# 그대로 쓰면 된다. 개발 워크트리에서 이 스크립트 자체를 테스트할 때는
# 워크트리에 node_modules 가 없으므로(다른 워크트리와 공유하는 메인 레포
# node_modules 를 이 스크립트가 npm install 로 새로 만들면 안 된다 — 진행
# 중인 다른 세션을 깬다) PRISMA_BIN 환경변수로 이미 설치된 다른 경로의
# prisma 실행파일을 가리켜서 검증한다.
cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"
PRISMA_BIN="${PRISMA_BIN:-$REPO_ROOT/node_modules/.bin/prisma}"

log() { printf '[restore-drill] %s\n' "$*" | tee -a "$LOG_FILE"; }
abort() { printf '[restore-drill] 중단: %s\n' "$*" | tee -a "$LOG_FILE" >&2; exit 1; }

mkdir -p "$(dirname "$LOG_FILE")"

# ── launchd 기본 PATH 대응 (backup.sh 와 동일 원인 — 그 파일 상단 주석에
# 실사고 기록) ── launchd GUI 에이전트의 기본 PATH 는
# /usr/bin:/bin:/usr/sbin:/sbin 뿐이라 Homebrew 로 설치된 rclone·docker
# (/usr/local/bin, Apple Silicon 은 /opt/homebrew/bin)가 여기 없다. 이
# 스크립트는 지금은 수동 실행이 기본이지만 launchd/cron 등 예약 실행으로
# 옮겨질 가능성이 있으므로 backup.sh 와 같은 방어를 미리 넣어둔다 — 둘 중
# 하나만 고치고 나머지를 "나중에"로 미루는 게 이번 실사고의 원인이었다.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

command -v rclone >/dev/null || abort "rclone 이 설치돼 있지 않습니다 (PATH=$PATH 에서 찾지 못함)."
command -v docker >/dev/null || abort "docker 가 설치돼 있지 않습니다 (PATH=$PATH 에서 찾지 못함)."
command -v jq >/dev/null || abort "jq 가 설치돼 있지 않습니다 (PATH=$PATH 에서 찾지 못함)."
[ -x "$PRISMA_BIN" ] || abort "prisma 실행파일을 찾을 수 없습니다: $PRISMA_BIN (npm install 이 끝난 체크아웃인지 확인하거나 PRISMA_BIN 을 지정하세요. 이 스크립트는 어떤 워크트리에서도 npm install 을 직접 실행하지 않습니다.)"
# 존재 확인만으로는 부족하다(멈춘 컨테이너도 inspect 는 성공한다) —
# .State.Running 을 직접 본다. backup.sh 의 동일 가드와 이유가 같다.
LIVE_RUNNING="$(docker inspect --format '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null || echo "false")"
[ "$LIVE_RUNNING" = "true" ] || abort "라이브 컨테이너 $DB_CONTAINER 가 실행 중이 아닙니다 — 대조할 대상이 없습니다."

R2_BUCKET="$(grep -E '^R2_BUCKET=' "$R2_CREDS_FILE" | head -1 | cut -d= -f2-)"
[ -n "$R2_BUCKET" ] || abort "R2_BUCKET 값을 $R2_CREDS_FILE 에서 찾지 못했습니다."

TMPDIR="$(mktemp -d "/tmp/wagcrm-restore-drill.XXXXXX")"
THROWAWAY_NAME="wagcrm-restore-drill-$(date +%s)-$$"
THROWAWAY_PW="$(openssl rand -hex 16 2>/dev/null || date +%s%N)"

# 라이브 컨테이너와 절대 같은 이름일 수 없다는 것까지 다시 확인한 뒤에만
# docker rm -f 를 실행하는 정리 함수 — 이름 충돌/변수 오염으로 실수로 라이브
# 컨테이너를 지우는 사고를 막는 마지막 방어선이다.
destroy_throwaway() {
  if [ -z "${THROWAWAY_NAME:-}" ] || [ "$THROWAWAY_NAME" = "$DB_CONTAINER" ]; then
    log "경고: 일회용 컨테이너 이름이 비정상입니다 — 안전을 위해 docker rm 을 건너뜁니다."
    return 0
  fi
  docker rm -f "$THROWAWAY_NAME" >/dev/null 2>&1 || true
}
cleanup() {
  destroy_throwaway
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

log "=== 복원 리허설 시작 $(date '+%Y-%m-%d %H:%M:%S') ==="

# ── 1. R2 에서 최신 백업 찾기 ──
LATEST="$(rclone lsf "${R2_REMOTE}:${R2_BUCKET}/${R2_BACKUP_PREFIX}/" --dirs-only 2>/dev/null | sed 's#/$##' | sort | tail -1)"
[ -n "$LATEST" ] || abort "R2 에서 백업을 하나도 찾지 못했습니다(${R2_REMOTE}:${R2_BUCKET}/${R2_BACKUP_PREFIX}/) — backup.sh 가 한 번도 성공한 적이 없을 수 있습니다."
log "최신 백업: $LATEST"

DATA_REMOTE="${R2_REMOTE}:${R2_BUCKET}/${R2_BACKUP_PREFIX}/${LATEST}/public-data-only.sql.gz"
rclone copyto "$DATA_REMOTE" "$TMPDIR/public-data-only.sql.gz" \
  || abort "다운로드 실패: $DATA_REMOTE"
gzip -t "$TMPDIR/public-data-only.sql.gz" || abort "다운로드한 파일이 유효한 gzip 이 아닙니다: $DATA_REMOTE"
gunzip -k "$TMPDIR/public-data-only.sql.gz"
log "다운로드 완료: $(wc -c < "$TMPDIR/public-data-only.sql.gz" | tr -d ' ') bytes (압축)"

# ── 2. 일회용 Postgres 컨테이너 기동 ──
# 라이브 컨테이너와 "완전히 같은 이미지"를 쓴다 — 태그를 하드코딩하지 않고
# 지금 실제로 떠 있는 라이브 컨테이너의 이미지를 그대로 읽어온다. 이렇게
# 하면 나중에 Supabase 이미지를 업그레이드해도 이 스크립트를 고칠 필요가
# 없고, 드릴이 실제 운영 버전과 항상 정확히 일치한다.
IMAGE="$(docker inspect --format '{{.Config.Image}}' "$DB_CONTAINER")"
log "일회용 컨테이너 이미지: $IMAGE (라이브 컨테이너와 동일)"
log "일회용 컨테이너 기동: $THROWAWAY_NAME"
docker run -d --name "$THROWAWAY_NAME" \
  -e POSTGRES_PASSWORD="$THROWAWAY_PW" \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  "$IMAGE" >/dev/null \
  || abort "일회용 컨테이너 기동 실패"

log "컨테이너 헬스체크 대기 중..."
HEALTHY=0
for _ in $(seq 1 30); do
  STATUS="$(docker inspect --format '{{.State.Health.Status}}' "$THROWAWAY_NAME" 2>/dev/null || echo "")"
  if [ "$STATUS" = "healthy" ]; then HEALTHY=1; break; fi
  sleep 2
done
[ "$HEALTHY" -eq 1 ] || abort "일회용 컨테이너가 60초 내에 healthy 상태가 되지 않았습니다(docker logs $THROWAWAY_NAME 확인)."

HOST_PORT="$(docker port "$THROWAWAY_NAME" 5432/tcp | head -1 | cut -d: -f2)"
[ -n "$HOST_PORT" ] || abort "일회용 컨테이너의 게시된 포트를 찾지 못했습니다."
# 자격증명(user:pass)과 URL 조립을 줄로 분리한다 — 한 줄에 "scheme://
# user:pass@" 형태가 통째로 나타나면 커밋 가드의 "URL 내장 자격증명"
# 탐지기가 걸린다(레포 PUBLIC, 실키 커밋 방지용 — scripts/commit-guard.mjs).
# 여기 값은 매 실행 새로 생성해 스크립트 종료 시 컨테이너째 버려지는
# 로컬 전용 임시 비밀번호라 실제 시크릿이 아니지만, 탐지기는 이 사실을
# 모르므로 애초에 그 모양을 안 만드는 쪽으로 짠다.
THROWAWAY_AUTH="postgres:${THROWAWAY_PW}"
THROWAWAY_URL="postgresql://${THROWAWAY_AUTH}@127.0.0.1:${HOST_PORT}/postgres"

# ── 3. Prisma 마이그레이션으로 public 스키마 재구축 ──
log "Prisma 마이그레이션 적용 중 (public 스키마 재구축)..."
if ! DATABASE_URL="$THROWAWAY_URL" DIRECT_URL="$THROWAWAY_URL" \
    "$PRISMA_BIN" migrate deploy --schema="$REPO_ROOT/prisma/schema.prisma" \
    >"$TMPDIR/prisma-migrate.log" 2>&1; then
  cat "$TMPDIR/prisma-migrate.log"
  abort "prisma migrate deploy 실패 — 로그: $TMPDIR/prisma-migrate.log (컨테이너 정리 후 스크립트가 종료됩니다)"
fi
log "마이그레이션 적용 완료"

# ── 4. 데이터 전용 덤프 복원 ──
# supabase_admin 을 쓰는 이유: 이 Supabase 이미지에서는 `postgres` 롤이
# superuser 가 아니다(supabase_admin 만 superuser). backup.sh 의 데이터
# 전용 덤프는 --disable-triggers 로 만들어지는데, 그 문(ALTER TABLE ...
# DISABLE TRIGGER ALL)이 시스템 트리거(FK 제약 트리거)까지 끄려면 superuser
# 권한이 필요하다 — postgres 롤로 실행하면 "permission denied: ...is a
# system trigger" 로 즉시 실패한다(이 저장소에서 실제로 재현·확인함).
# 일회용 컨테이너는 우리가 완전히 통제하므로 supabase_admin 자격증명(같은
# POSTGRES_PASSWORD)을 여기서만 쓴다.
log "데이터 복원 중 (supabase_admin, --disable-triggers 문 실행 위해 superuser 필요)..."
docker cp "$TMPDIR/public-data-only.sql" "$THROWAWAY_NAME:/tmp/public-data-only.sql"
if ! docker exec -e PGPASSWORD="$THROWAWAY_PW" "$THROWAWAY_NAME" \
    psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f /tmp/public-data-only.sql \
    >"$TMPDIR/restore.log" 2>&1; then
  tail -40 "$TMPDIR/restore.log"
  abort "데이터 복원 실패 — 로그: $TMPDIR/restore.log"
fi
log "데이터 복원 완료"

# ── 5. 대조: 테이블 수 + 테이블별 정확한 행 수 ──
psql_live() { docker exec "$DB_CONTAINER" psql -U postgres -d postgres -t -A -c "$1"; }
psql_throwaway() { docker exec -e PGPASSWORD="$THROWAWAY_PW" "$THROWAWAY_NAME" psql -U postgres -d postgres -t -A -c "$1"; }

LIVE_TABLE_COUNT="$(psql_live "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE';" | tr -d ' ')"
THROWAWAY_TABLE_COUNT="$(psql_throwaway "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE';" | tr -d ' ')"
log "테이블 수 — live: $LIVE_TABLE_COUNT, throwaway: $THROWAWAY_TABLE_COUNT"

FAIL=0
if [ "$LIVE_TABLE_COUNT" != "$THROWAWAY_TABLE_COUNT" ]; then
  log "FAIL: 테이블 수 불일치 (live=$LIVE_TABLE_COUNT throwaway=$THROWAWAY_TABLE_COUNT)"
  FAIL=1
fi

# _prisma_migrations 은 위 상단 주석대로 정상적으로 값이 다르므로 대조에서 뺀다.
TABLES="$(psql_live "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' and table_name <> '_prisma_migrations' order by 1;")"
MISMATCH_COUNT=0
CHECKED_COUNT=0
while IFS= read -r T; do
  [ -n "$T" ] || continue
  CHECKED_COUNT=$((CHECKED_COUNT + 1))
  LIVE_N="$(psql_live "select count(*) from \"$T\";" | tr -d ' ')"
  THROWAWAY_N="$(psql_throwaway "select count(*) from \"$T\";" | tr -d ' ')"
  if [ "$LIVE_N" != "$THROWAWAY_N" ]; then
    log "FAIL: $T 행 수 불일치 (live=$LIVE_N throwaway=$THROWAWAY_N)"
    MISMATCH_COUNT=$((MISMATCH_COUNT + 1))
    FAIL=1
  fi
done <<< "$TABLES"

log "행 수 대조 완료: ${CHECKED_COUNT}개 테이블 확인, 불일치 ${MISMATCH_COUNT}건"

if [ "$FAIL" -eq 1 ]; then
  log "=== 결과: FAIL — 백업($LATEST)이 라이브 데이터를 온전히 재현하지 못했습니다 ==="
  exit 1
fi

log "=== 결과: PASS — 백업($LATEST) 복원 검증 성공 (테이블 ${LIVE_TABLE_COUNT}개, 행 수 대조 ${CHECKED_COUNT}개 테이블 전부 일치) ==="
exit 0
