#!/usr/bin/env bash
set -euo pipefail

# WAG CRM 셀프호스트 DB 백업 — 실행체.
#
# ⚠️ 이 백업은 더 이상 "여러 안전장치 중 하나"가 아니다. 이전 클라우드
# 제공자의 point-in-time-recovery 는 이관과 함께 사라졌고, 예전 GitHub
# Actions 백업은 이 DB(이 iMac 의 Docker Supabase)에 더 이상 접근할 수
# 없다. 지금 이 스크립트가 **유일한 롤백 수단**이다 — 조용히 실패해서는
# 안 된다(아래 각 단계가 실패하면 즉시 nonzero exit 한다).
#
# ── 왜 덤프가 2개인가 (다음 사람이 "왜 파일이 둘이지, 하나 지워도 되나"
#    싶을 때 반드시 먼저 읽을 것) ──
#
# 1) full.sql.gz — `pg_dump` 전체 덤프(전 스키마: public·auth·storage·
#    realtime·... 전부). "동일한 스택"(지금과 완전히 같은 버전의 Supabase
#    컨테이너 세트가 이미 떠 있는 상태) 위에 그대로 얹어 복원하거나,
#    포렌식(무엇이 언제 어떻게 바뀌었는지 사후 조사)용이다.
#
# 2) public-data-only.sql.gz — `public` 스키마의 **데이터만**(테이블 정의
#    없음), `_prisma_migrations` 는 제외. "완전히 새로 만든" 스택(아직 아무
#    컨테이너도 뜬 적 없는 새 머신) 위에 복원할 때는 이 파일을 써야 한다.
#
# 왜 새 스택에는 full.sql.gz 를 못 쓰는가: `auth`·`storage` 스키마는 이
# 앱이 아니라 GoTrue(Auth)·Storage API 가 자체적으로 소유하고 버전
# 관리한다 — 그 서비스들이 최초 기동 시 자기 마이그레이션을 돌려 스키마를
# 만드는데, 그 마이그레이션 이력(몇 번을 실행했는지, 어떤 버전인지)은
# 설치마다 다르다. **실측**: 이 iMac 스택과 비교 대상 스택 사이에서 두
# 스키마 모두 마이그레이션 적용 개수 자체가 어긋나 있었다(정확한 수치는
# 실측치라 커밋에 남기지 않는다 — P0, 대화 보고 참고). full.sql.gz 를 새
# 스택에 그대로 부으면 이 두 스키마의 CREATE/ALTER 문이 "이미 다른
# 버전으로 존재하는 객체"와 충돌해 무더기 에러를 내고(이 저장소에서 실제로
# 재현·확인함), `public` 스키마 복원 자체는 우연히 끝까지 가더라도 그 뒤에
# GoTrue/Storage 를 기동하면 자기 마이그레이션 이력과 실제 스키마 상태가
# 어긋나 예측 불가능한 상태가 된다.
#
# 검증된 재구축 경로(비상 복구 시 그대로 따를 것 — README 백업 절 참고):
#   새 스택 기동(컨테이너만, 데이터 없음)
#     → 각 서비스(GoTrue·Storage 등)가 자기 스키마를 스스로 만들게 둔다
#     → 이 앱의 Prisma 마이그레이션을 적용한다(`prisma migrate deploy`)
#     → public-data-only.sql.gz 로 `public` 스키마 데이터만 주입한다.
#
# `_prisma_migrations` 를 데이터에서 뺀 이유: 위 경로에서 3번째 단계가
# 이미 대상 DB에 **그 DB 기준으로 올바른** `_prisma_migrations` 레코드를
# 만든다. 여기서 만든(원본 DB 기준) 레코드를 그 위에 얹으면 "이 마이그레
# 이션은 적용됐다고 기록돼 있지만 실제로는 다른 순서/버전으로 적용된"
# 상태가 돼 마이그레이션 상태 자체가 오염된다.

# ── 설정 ──
DB_CONTAINER="supabase-db"
PG_USER="postgres"
PG_DB="postgres"
R2_CREDS_FILE="/Users/z9/selfhost/r2-credentials.txt"
R2_REMOTE="r2"                     # rclone remote 이름(테스트 완료: list/upload/delete 전부 동작)
R2_BACKUP_PREFIX="backups"
LOG_DIR="/Users/z9/selfhost/logs"
RETENTION_DAYS="30"
# 무료 티어(10GB)의 80% = 8GiB. 여기서 멈추는 이유: 오너의 명시적 우려는
# "무료 티어를 조용히 넘겨서 과금되는 것" — 이 가드가 그 시나리오를 막는
# 유일한 장치다. 테스트 시 이 값을 아주 작게 덮어써서 가드 발동을
# 재현할 수 있도록 환경변수로 override 가능하게 둔다(운영 시에는 비워둘 것).
CAPACITY_LIMIT_BYTES="${BACKUP_CAPACITY_LIMIT_BYTES:-8589934592}"

log() { printf '[backup] %s\n' "$*"; }
abort() { printf '[backup] 중단: %s\n' "$*" >&2; exit 1; }

mkdir -p "$LOG_DIR"

# ── launchd 기본 PATH 대응 (실사고: 최초 launchd 예약 실행이 "rclone 이
# 설치돼 있지 않습니다"로 즉시 exit 1 했다 — 이론이 아니라 실측) ──
# launchd GUI 에이전트의 기본 PATH 는 /usr/bin:/bin:/usr/sbin:/sbin 뿐이다.
# 이 스크립트가 쓰는 rclone·docker 는 Homebrew 로 설치돼 /usr/local/bin
# (Apple Silicon 은 /opt/homebrew/bin)에 있어 이 PATH 에 없다 — gzip/date/
# mkdir 은 시스템 기본 경로에 있어 문제없이 지나가므로 이 둘만 조용히
# 빠지고 나머지는 정상 동작하는 것처럼 보이는 게 이 버그를 더 늦게
# 들키게 만든 원인이었다. run-app.sh 가 node 에 대해 이미 겪은 것과 같은
# 원인이다(그 파일 상단 주석 참고) — 인터랙티브 셸 PATH 에 기대지 않도록
# 후보 경로를 스크립트 시작부에 직접 추가한다. 이 export 는 아래
# command -v 체크뿐 아니라 스크립트 전체에서 반복되는 rclone/docker 호출
# 전부에 적용된다(run-app.sh 는 node 를 한 번만 exec 하므로 이 방식이
# 불필요했지만, 이 스크립트는 그렇지 않다). 후보 목록을 "단순화"해서
# 지우지 말 것 — 다음에도 같은 방식으로 조용히 죽는다.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

# ── R2_BUCKET 읽기 — 이 파일에서 R2_BUCKET **한 줄만** 읽는다. 다른 값
# (R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_ENDPOINT)은 rclone 설정
# (`rclone config`, remote "r2")이 이미 갖고 있으므로 이 스크립트가 다시
# 읽거나 로그에 남길 필요가 없다 — 절대 이 파일 전체를 source 하거나
# echo 하지 않는다(레포는 PUBLIC, 로그도 사람이 볼 수 있다 — P0).
[ -r "$R2_CREDS_FILE" ] || abort "R2 자격증명 파일을 읽을 수 없습니다: $R2_CREDS_FILE"
R2_BUCKET="$(grep -E '^R2_BUCKET=' "$R2_CREDS_FILE" | head -1 | cut -d= -f2-)"
[ -n "$R2_BUCKET" ] || abort "R2_BUCKET 값을 $R2_CREDS_FILE 에서 찾지 못했습니다."

command -v rclone >/dev/null || abort "rclone 이 설치돼 있지 않습니다 (PATH=$PATH 에서 찾지 못함)."
command -v docker >/dev/null || abort "docker 가 설치돼 있지 않습니다 (PATH=$PATH 에서 찾지 못함)."
# `docker inspect` 만으로는 컨테이너 "존재"만 증명하고 "실행 중"은
# 증명하지 못한다(멈춘 컨테이너도 inspect 는 성공한다) — 그래서
# .State.Running 을 직접 본다. 여기서 걸러야 아래 docker exec pg_dump 가
# Docker 데몬의 날 에러로 실패하는 대신, 이 메시지로 원인이 바로 보인다.
RUNNING="$(docker inspect --format '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null || echo "false")"
[ "$RUNNING" = "true" ] || abort "컨테이너 $DB_CONTAINER 가 실행 중이 아닙니다."

TS="$(date '+%Y%m%d-%H%M%S')"
TMPDIR="$(mktemp -d "/tmp/wagcrm-backup.${TS}.XXXXXX")"
# 실패 경로 포함 전부에서 로컬 임시 파일을 정리한다.
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

# ── 용량 가드: 업로드 전에 버킷 "전체" 현재 사용량을 본다(백업 접두사만이
# 아니라 버킷 전체 — 토큰이 이 버킷 하나에만 스코프돼 있으므로 다른 걸 담을
# 일은 없지만, "버킷의 현재 총 용량"을 보라는 요구를 정확히 지킨다).
# 이 값은 성공/실패와 무관하게 매 실행 로그에 남긴다 — 그래야 증가 추세가
# 보인다.
USAGE_JSON="$(rclone size "${R2_REMOTE}:${R2_BUCKET}" --json 2>/dev/null)" \
  || abort "rclone size 실패 — R2 연결을 확인하세요(rclone ls ${R2_REMOTE}:${R2_BUCKET} 로 재현)."
USAGE_BYTES="$(printf '%s' "$USAGE_JSON" | jq -r '.bytes')"
case "$USAGE_BYTES" in ''|*[!0-9]*) abort "rclone size 출력에서 bytes 를 못 읽었습니다: $USAGE_JSON";; esac
USAGE_GIB="$(awk -v b="$USAGE_BYTES" 'BEGIN { printf "%.2f", b/1024/1024/1024 }')"
LIMIT_GIB="$(awk -v b="$CAPACITY_LIMIT_BYTES" 'BEGIN { printf "%.2f", b/1024/1024/1024 }')"
log "현재 R2 버킷 사용량: ${USAGE_BYTES} bytes (~${USAGE_GIB} GiB), 한도: ${LIMIT_GIB} GiB"

if [ "$USAGE_BYTES" -ge "$CAPACITY_LIMIT_BYTES" ]; then
  abort "R2 사용량(${USAGE_GIB} GiB)이 한도(${LIMIT_GIB} GiB, 무료 티어 10GB 의 80%)에 도달했습니다 — 업로드를 하지 않고 중단합니다. 조치: (1) infra/selfhost/README.md 의 보관정책(30일 삭제)이 정상 동작 중인지 이 스크립트의 최근 로그(${LOG_DIR}/backup.err.log)에서 '보관정책 삭제 실패' 경고가 없었는지 확인 (2) R2 대시보드에서 오래된 백업이 실제로 지워지고 있는지 확인 (3) 필요하면 무료 티어를 넘겨 과금되기 전에 수동으로 오래된 백업을 지우거나 유료 플랜 전환을 검토."
fi

# ── 덤프 ──
log "전체 덤프(pg_dump, 전 스키마) 생성 중..."
docker exec "$DB_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" \
  | gzip > "$TMPDIR/full.sql.gz"

log "public 스키마 데이터 전용 덤프 생성 중(_prisma_migrations 제외)..."
# --disable-triggers: 대상 DB에 이미 FK 제약이 걸린 스키마(Prisma
# 마이그레이션으로 만든 스키마)가 있는 상태에서 데이터만 COPY 로 부으면,
# Partner/Seller/Deal 등 상호 참조(순환 FK)가 있는 테이블에서 로드 순서를
#지킬 수 없어 FK 위반이 난다(pg_dump 자체가 이 경고를 낸다). 복원 시
# `ALTER TABLE ... DISABLE/ENABLE TRIGGER ALL` 로 감싸 순서 문제를
# 우회한다 — 단, 이 문을 실행하려면 대상 세션이 superuser 여야 한다(이
# Supabase 이미지에서는 `postgres` 롤이 superuser 가 아니다 — 복원 시
# `supabase_admin` 사용. restore-drill.sh 참고).
docker exec "$DB_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" \
  --schema=public --data-only --disable-triggers \
  --exclude-table=_prisma_migrations \
  | gzip > "$TMPDIR/public-data-only.sql.gz"

# 최소한의 무결성 확인 — gzip 자체가 깨졌거나 pg_dump 가 사실상 빈 출력을
# 낸 채로 "성공"한 척하는 상황을 잡는다. 애플리케이션 테이블 개수를 세지는
# 않는다(그건 restore-drill.sh 의 역할) — 여기서는 "파일이 유효한 gzip 이고
# 자릿수가 있다"만 본다.
for f in full.sql.gz public-data-only.sql.gz; do
  gzip -t "$TMPDIR/$f" || abort "$f 가 유효한 gzip 파일이 아닙니다 — pg_dump 또는 gzip 이 중간에 실패했을 수 있습니다."
  SIZE="$(wc -c < "$TMPDIR/$f" | tr -d ' ')"
  [ "$SIZE" -gt 1024 ] || abort "$f 크기가 비정상적으로 작습니다(${SIZE} bytes) — pg_dump 가 빈 덤프를 낸 것으로 의심됩니다."
  log "$f 검증 완료: ${SIZE} bytes"
done

# ── 업로드 ──
DEST="${R2_REMOTE}:${R2_BUCKET}/${R2_BACKUP_PREFIX}/${TS}"
log "업로드 중: $DEST"
rclone copy "$TMPDIR/full.sql.gz" "$DEST/" || abort "full.sql.gz 업로드 실패"
rclone copy "$TMPDIR/public-data-only.sql.gz" "$DEST/" || abort "public-data-only.sql.gz 업로드 실패"

# 업로드 후 실제로 원격에 존재하고 크기가 0이 아닌지 재확인한다 — rclone
# copy 가 exit 0 을 반환했다고 해서 원격 객체가 반드시 온전하다고 가정하지
# 않는다(P0: 상태 지레짐작 금지).
UPLOADED_JSON="$(rclone lsjson "$DEST" 2>/dev/null)" || abort "업로드 검증(rclone lsjson) 실패"
UPLOADED_COUNT="$(printf '%s' "$UPLOADED_JSON" | jq '[.[] | select(.Size > 0)] | length')"
[ "$UPLOADED_COUNT" -eq 2 ] || abort "업로드 검증 실패 — 원격에서 크기>0 객체 2개를 기대했으나 ${UPLOADED_COUNT}개 확인됨: $DEST"
log "업로드 검증 완료: $DEST 에 객체 2개(비어있지 않음) 확인"

# ── 보관정책(30일) ──
# ⚠️ 이 토큰의 delete 권한은 배포 전 별도로 실측 검증했다(list/upload/delete
# 전부 동작 확인). 이 권한이 훗날 어떤 이유로든(토큰 스코프 변경, R2 정책
# 변경 등) 조용히 막히면, 오래된 백업이 무한히 쌓여 결국 무료 티어(10GB)를
# 넘기고 만다 — 그래서 이 삭제 단계의 실패를 조용히 넘기지 않는다: 실패하면
# 이 스크립트 전체가 nonzero exit 로 끝난다(오늘 백업 자체는 이미 위에서
# 성공적으로 업로드됐으므로 데이터 유실은 아니지만, 방치하면 위 용량 가드가
# 결국 백업 자체를 막는다 — 그 전에 사람이 알아야 한다).
log "보관정책 적용 중: ${R2_BACKUP_PREFIX}/ 아래 ${RETENTION_DAYS}일 이상 지난 백업 삭제"
# --files-only: lsjson --recursive 는 "디렉터리"(S3 에는 실체가 없는
# 접두사 표시용 가짜 엔트리)도 같이 센다 — 뺴지 않으면 파일 2개짜리
# 백업 1세트가 "객체 3개"로 잘못 보고된다(디렉터리 자체는 용량·과금과
# 무관하므로 성장 추이 로그에는 실제 파일 수만 의미가 있다).
BEFORE_COUNT="$(rclone lsjson "${R2_REMOTE}:${R2_BUCKET}/${R2_BACKUP_PREFIX}" --recursive --files-only 2>/dev/null | jq 'length' || echo 0)"
if ! rclone delete "${R2_REMOTE}:${R2_BUCKET}/${R2_BACKUP_PREFIX}" --min-age "${RETENTION_DAYS}d"; then
  log "경고: 보관정책 삭제 실패 — delete 권한이 막혔을 수 있습니다. 방치하면 용량 가드가 향후 백업을 차단합니다. R2 대시보드에서 토큰 권한을 확인하세요."
  RETENTION_FAILED=1
else
  AFTER_COUNT="$(rclone lsjson "${R2_REMOTE}:${R2_BUCKET}/${R2_BACKUP_PREFIX}" --recursive --files-only 2>/dev/null | jq 'length' || echo 0)"
  log "보관정책 적용 완료: 객체 ${BEFORE_COUNT} → ${AFTER_COUNT}개"
  RETENTION_FAILED=0
fi

log "완료: $DEST (전체+public 데이터 전용 각 1개, 업로드·검증 성공)"

if [ "$RETENTION_FAILED" -eq 1 ]; then
  abort "백업 자체는 성공했지만 보관정책 삭제가 실패했습니다 — 위 경고를 확인하고 조치하세요(용량 무한 증가 방지)."
fi

exit 0
