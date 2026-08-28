#!/usr/bin/env bash
set -euo pipefail

# WAG CRM 셀프호스트 주간 전체 백업 — 실행체.
#
# ── 이게 왜 따로 필요한가(일간 백업이 못 덮는 두 구멍) ──
#
# 1) `backup.sh`(일간)는 DB 만 백업한다. 오브젝트 스토리지 파일(셀러가
#    올린 이미지 등, 현재 약 1,223 개·총 80MB 안팎)은 **어디에도 백업되지
#    않는다** — 이관 후에는 이 iMac 이 그 파일들의 유일한 사본이다. DB 는
#    행 단위 변경이 잦아 매일 통째로 덤프해도 부담이 적지만, 오브젝트
#    스토리지 파일은 한 번 올라가면 거의 바뀌지 않고(추가만 되고 수정은
#    드묾) 매일 80MB+ 를 통째로 타르로 묶어 올리는 건 낭비다 — 그래서
#    변경 빈도가 낮은 이 파일들은 주간 주기로 충분하고, 그래서 일간이
#    아니라 여기서 다룬다.
# 2) 앱과 일간 백업(R2)은 **같은 벤더 계정**에 얹혀 있다 — 그 계정은 이
#    배포의 터널·DNS 도 함께 쥐고 있다. 그 계정에 문제가 생기면 서비스와
#    백업이 동시에 사라진다. 그래서 이 스크립트의 목적지는 **다른
#    벤더**(Google Drive, rclone remote `gdrive`)여야 한다 — R2 를 다시
#    쓰면 이 스크립트를 만드는 이유 자체가 없어진다.
#
# ── 복원에 왜 이 두 산출물이 "함께" 필요한가 ──
# DB 덤프에는 오브젝트를 **가리키는 행**(경로·소유자·메타데이터)이 있고,
# 실제 **바이트**는 스토리지 타르 안에 있다. 하나만 복원하면 DB 는
# "존재한다"고 말하는 파일이 실제로는 없거나(타르 누락), 파일은 있는데
# 그 파일을 가리키는 행이 없어(덤프 누락) 애플리케이션이 참조를 못 찾는
# 상태가 된다 — 완전한 복원은 반드시 **둘 다** 있어야 한다.
#
# 나머지 안전장치(로그 실패 처리·PATH 대응·보관정책 비침묵 실패)는
# `backup.sh`(일간)와 최대한 동일한 관례를 따른다 — 그 파일 상단 주석이
# 이 원칙들의 배경 실사고를 담고 있다.
#
# ── manifest.json 을 왜 세 번째 산출물로 함께 올리는가(실사고 기반) ──
# 이 스크립트를 실제로 돌려본 직후, 오너가 rclone 을 **다른 Google
# 계정**으로 재인증했다. 그 순간부터 방금 성공한 백업을 `rclone lsjson` 로
# 조회하면 `directory not found` 가 떴다 — 파일이 지워진 게 아니라
# `scope=drive.file` 특성상 rclone 이 "자신이 만든 파일"만 볼 수 있어서,
# 계정을 바꾸면 이전 백업이 통째로 안 보이게 된 것뿐이었다. 문제는 이
# 증상이 "백업이 진짜로 사라졌다"와 겉보기에 완전히 동일하다는 점 —
# 몇 달 뒤, 어쩌면 이 iMac 조차 아닌 다른 머신에서 복구하는 사람은 이
# 구분을 할 방법이 없으면 "백업이 없다"고 오판하고 최악의 순간에 잘못된
# 결론으로 행동하게 된다. 백업의 위치는 경로 하나가 아니라 "경로 + 어느
# 계정으로 인증했을 때 보이는가"의 쌍이다 — manifest.json 이 그 뒷반쪽을
# 기록한다(계정 식별자·타임스탬프·산출물 이름과 크기). 로컬 로그
# (`~/selfhost/logs/backup-weekly.out.log`)에도 같은 계정 식별자를 남기지만,
# 로그는 이 iMac 이 사라지면 함께 사라진다 — manifest 는 백업 자체와 같은
# 곳에 올라가므로 그 상황에서도 살아남는다.

# ── 설정 ──
DB_CONTAINER="supabase-db"
PG_USER="postgres"
PG_DB="postgres"
STORAGE_VOLUME="supabase_storage-data"   # 호스트 바인드 마운트가 아니라 Docker 네임드 볼륨 —
                                          # macOS 가 storage 서비스에 필요한 extended-attribute 를
                                          # 지원하지 않아 바인드 마운트를 의도적으로 포기했다.
GDRIVE_REMOTE="gdrive"                   # rclone remote 이름. `rclone config create gdrive drive
                                          # scope=drive.file` 로 인가됨 — 이 스코프는 rclone 이
                                          # "자신이 만든 파일/폴더"만 보고 건드릴 수 있다는 뜻이다.
                                          # 즉 이 remote 로는 Drive 안의 다른 파일을 나열·수정할
                                          # 수 없고(권한 자체가 없음), 이 스크립트가 처음 업로드할
                                          # 때 rclone 이 스스로 만드는 폴더 트리만 이후 계속 보고
                                          # 관리할 수 있다.
GDRIVE_FOLDER="wagcrm-weekly-backups"
LOG_DIR="/Users/z9/selfhost/logs"
RETENTION_WEEKS="12"

# ── 용량 가드를 여기 두지 않는 이유 ──
# `backup.sh`(R2)는 업로드 전 `rclone size`로 버킷 "전체" 사용량을 재
# 무료 티어 초과를 막는다. 그 가드가 정확한 이유는 R2 액세스 토큰이 버킷
# 하나에만 스코프돼 있어 "이 버킷의 전체 사용량"을 그대로 신뢰할 수
# 있어서다. 여기서는 그 전제가 깨진다 — `drive.file` 스코프에서는 rclone
# 이 이 remote 로 만든 파일들만 보이므로, `rclone size gdrive:` 가 반환하는
# 값은 "이 스크립트가 쓴 용량"이지 "Drive 계정 전체 잔여 용량"이 아니다.
# 그 값으로 계정 전체 15GB 한도를 판단하면 실제로는 한도에 가까운데도
# 가드가 "여유 있다"고 오판할 수 있다 — 없는 것보다 더 위험한 거짓
# 안심이다. 그래서 여기서는 정확도가 보장되는 용량 가드 대신, 아래
# 보관정책(12주 삭제)이 무한 증가를 막는 유일한 장치다. 그 삭제가
# 실패하면(아래) 조용히 넘어가지 않고 반드시 nonzero exit 한다.

log() { printf '[backup-weekly] %s\n' "$*"; }
abort() { printf '[backup-weekly] 중단: %s\n' "$*" >&2; exit 1; }

# `rclone lsjson` 으로 원격을 조회할 때 "directory not found" 를 그냥
# 실패로 취급하지 않는다 — 위 헤더 주석의 실사고대로, 이 메시지는 (1) 정말
# 그 경로에 아무것도 없다 와 (2) rclone 이 이 백업을 올린 계정과 다른
# Google 계정으로 인증돼 있다 를 겉보기로 구분할 수 없다. 실패 자체는
# 호출부가 판단하게 두되(이 함수는 실패를 삼키지 않는다 — stderr 를 그대로
# 흘리고 원래 종료 코드를 반환), "directory not found" 로 보이면 그
# 애매함을 사람이 읽을 수 있는 한 줄로 남긴다.
lsjson_or_explain() {
  local target="$1"; shift
  local err_file out rc
  err_file="$(mktemp)"
  if out="$(rclone lsjson "$target" "$@" 2>"$err_file")"; then
    rm -f "$err_file"
    printf '%s' "$out"
    return 0
  else
    # ⚠️ $? 는 반드시 이 else 블록의 "첫" 문장에서 잡는다 — `fi` 다음
    # 줄에서 잡으면(먼저 그렇게 짰다가 실측으로 잡은 버그) `$?` 가 실패한
    # rclone 의 종료코드가 아니라 "분기를 안 탄 if 문 자체"의 종료코드(항상
    # 0, else 없는 if가 조건 거짓일 때의 정의된 동작)를 가리켜 실패가
    # 통째로 사라진다 — 아래 두 lsjson_or_explain 호출부가 `|| echo 0` 로
    # 조용히 0을 반환하는 원인이 될 뻔했다.
    rc=$?
  fi
  # ⚠️ stdout(fd1) 이 아니라 반드시 stderr(fd2) 에 쓴다 — 이 함수는
  # `lsjson_or_explain ... | jq ...` 형태로 파이프 왼쪽에서 호출된다. fd1 에
  # 쓰면 이 경고 메시지 자체가 jq 로 흘러들어가 파싱 에러로 조용히
  # 사라지고 실제로는 아무 데도 보고되지 않는다(직접 확인한 함정).
  if grep -qi "directory not found" "$err_file"; then
    printf '[backup-weekly] 주의: '\''%s'\'' 조회 결과 '\''directory not found'\'' — 이것만으로 백업이 없다고 단정할 수 없습니다. 두 가지 원인이 겉보기에 동일합니다: (1) 정말 그 경로에 백업이 없음, 또는 (2) rclone 이 이 백업을 올린 Google 계정과 다른 계정으로 인증돼 있음(scope=drive.file 특성상 계정이 다르면 파일이 아예 보이지 않습니다 — 삭제된 게 아닙니다). '\''rclone about gdrive:'\'' 로 현재 연결 상태를 확인하고, 해당 백업의 manifest.json 에 기록된 account_email 과 현재 인증 계정을 대조해 구분하세요(README 비상 복원 절차 참고).\n' "$target" >&2
  fi
  cat "$err_file" >&2
  rm -f "$err_file"
  return "$rc"
}

mkdir -p "$LOG_DIR"

# ── launchd 기본 PATH 대응 (backup.sh 와 동일 원인 — 이 클래스의 버그는
# 이미 두 번 나왔다: run-app.sh 의 node, backup.sh/restore-drill.sh 의
# rclone·docker. 세 번째로 여기서 또 나지 않도록 launchd 가 이 스크립트를
# 실행할 것을 전제로 시작부에 후보 경로를 직접 추가한다) ── launchd GUI
# 에이전트의 기본 PATH 는 /usr/bin:/bin:/usr/sbin:/sbin 뿐이라 Homebrew 로
# 설치한 rclone·docker(/usr/local/bin, Apple Silicon 은 /opt/homebrew/bin)
# 가 보이지 않는다. "dev 셸에서 되니까 launchd 에서도 되겠지"라고 가정하지
# 말 것 — 인터랙티브 셸의 PATH 를 그대로 물려받는 수동 실행에서는 이 버그가
# 전혀 드러나지 않는다.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

command -v rclone >/dev/null || abort "rclone 이 설치돼 있지 않습니다 (PATH=$PATH 에서 찾지 못함)."
command -v docker >/dev/null || abort "docker 가 설치돼 있지 않습니다 (PATH=$PATH 에서 찾지 못함)."

# `docker inspect` 만으로는 컨테이너 "존재"만 증명하고 "실행 중"은
# 증명하지 못한다(backup.sh 의 동일 가드와 이유가 같다).
RUNNING="$(docker inspect --format '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null || echo "false")"
[ "$RUNNING" = "true" ] || abort "컨테이너 $DB_CONTAINER 가 실행 중이 아닙니다."

TS="$(date '+%Y%m%d-%H%M%S')"
TMPDIR="$(mktemp -d "/tmp/wagcrm-backup-weekly.${TS}.XXXXXX")"
# 실패 경로 포함 전부에서 로컬 임시 파일을 정리한다.
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

# ── 1. DB 전체 덤프 (backup.sh 의 full.sql.gz 와 완전히 동일한 방식 —
# 새로 발명하지 않는다) ──
log "전체 덤프(pg_dump, 전 스키마) 생성 중..."
docker exec "$DB_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" \
  | gzip > "$TMPDIR/full.sql.gz"

# ── 2. 오브젝트 스토리지 타르 — 네임드 볼륨을 읽기 전용으로 일회용
# 컨테이너에 마운트해서 타르로 묶는다. 이 방식은 실행 중인 supabase-storage
# 컨테이너를 전혀 멈추거나 건드리지 않는다(같은 네임드 볼륨을 다른
# 컨테이너에서 동시에 읽기 전용으로 마운트하는 것은 Docker 에서 안전하고
# 흔한 패턴이다 — storage 서비스는 이 백업 컨테이너의 존재조차 모른다).
# alpine 은 이미 로컬에 있고 tar 가 기본 내장돼 있어 추가 설치 없이 쓴다.
log "오브젝트 스토리지 볼륨($STORAGE_VOLUME) 타르 생성 중..."
docker run --rm \
  -v "${STORAGE_VOLUME}:/data:ro" \
  -v "${TMPDIR}:/backup-out" \
  alpine sh -c 'tar -czf /backup-out/storage-data.tar.gz -C /data .' \
  || abort "오브젝트 스토리지 타르 생성 실패 — 일회용 컨테이너에서 tar 가 실패했습니다."

# 최소한의 무결성 확인 — gzip 자체가 깨졌거나 사실상 빈 출력을 낸 채로
# "성공"한 척하는 상황을 잡는다.
for f in full.sql.gz storage-data.tar.gz; do
  gzip -t "$TMPDIR/$f" || abort "$f 가 유효한 gzip 파일이 아닙니다 — 생성 중간에 실패했을 수 있습니다."
  SIZE="$(wc -c < "$TMPDIR/$f" | tr -d ' ')"
  [ "$SIZE" -gt 1024 ] || abort "$f 크기가 비정상적으로 작습니다(${SIZE} bytes) — 빈 산출물로 의심됩니다."
  log "$f 검증 완료: ${SIZE} bytes"
  # manifest.json 에 그대로 쓸 것이므로 파일별로 따로 보관한다(변수 재사용 금지).
  case "$f" in
    full.sql.gz) FULL_SIZE="$SIZE" ;;
    storage-data.tar.gz) STORAGE_SIZE="$SIZE" ;;
  esac
done

# ── 업로드 ──
DEST="${GDRIVE_REMOTE}:${GDRIVE_FOLDER}/${TS}"
log "업로드 중: $DEST"
rclone copy "$TMPDIR/full.sql.gz" "$DEST/" || abort "full.sql.gz 업로드 실패"
rclone copy "$TMPDIR/storage-data.tar.gz" "$DEST/" || abort "storage-data.tar.gz 업로드 실패"

# 업로드 후 실제로 원격에 존재하고 크기가 0이 아닌지 재확인한다 — rclone
# copy 가 exit 0 을 반환했다고 해서 원격 객체가 반드시 온전하다고 가정하지
# 않는다(P0: 상태 지레짐작 금지, backup.sh 와 동일 원칙).
UPLOADED_JSON="$(rclone lsjson "$DEST" 2>/dev/null)" || abort "업로드 검증(rclone lsjson) 실패"
UPLOADED_COUNT="$(printf '%s' "$UPLOADED_JSON" | jq '[.[] | select(.Size > 0)] | length')"
[ "$UPLOADED_COUNT" -eq 2 ] || abort "업로드 검증 실패 — 원격에서 크기>0 객체 2개를 기대했으나 ${UPLOADED_COUNT}개 확인됨: $DEST"
log "업로드 검증 완료: $DEST 에 객체 2개(비어있지 않음) 확인"

# ── 목적지 계정 식별자 확보 ──
# `rclone about` 은 이 remote 의 용량 정보만 줄 뿐 "누구로 인증돼 있는지"는
# 주지 않는다(직접 확인함 — 이 스코프에서 About API 호출은 storageQuota
# 필드만 반환한다). 대신 방금 우리가 만든 파일의 owner 메타데이터를 읽으면
# 그게 곧 "현재 인증된 계정"이다 — drive.file 스코프에서 이 remote 가 만든
# 파일의 소유자는 항상 그 파일을 만든 계정 자신이기 때문이다.
ACCOUNT_JSON="$(rclone lsjson "$DEST" -M 2>/dev/null)" || ACCOUNT_JSON=""
ACCOUNT_EMAIL="$(printf '%s' "$ACCOUNT_JSON" | jq -r '[.[].Metadata.owner // empty] | first // empty' 2>/dev/null || true)"
if [ -z "$ACCOUNT_EMAIL" ]; then
  ACCOUNT_EMAIL="(알수없음 — rclone lsjson -M 에서 owner 메타데이터를 가져오지 못함)"
  log "경고: 업로드된 객체에서 계정 식별자(owner 메타데이터)를 가져오지 못했습니다 — manifest.json 의 account_email 이 비게 됩니다. rclone 버전 또는 --drive-metadata-owner 설정을 확인하세요."
fi
# ⚠️ Google 계정 이메일은 자격증명(비밀번호·토큰)이 아니지만 개인 식별
# 정보다 — 로그·manifest 모두 "어느 계정으로 인증해야 이 백업이 보이는가"
# 를 답하는 데 필요한 최소한(이메일 하나)만 남기고, access_token·
# refresh_token 등 실제 인증 값은 어디에도 출력·기록하지 않는다.
log "백업 목적지 계정: $ACCOUNT_EMAIL — 재해복구 시 rclone 이 반드시 이 계정으로 인증돼 있어야 이 백업이 보입니다. 다른 계정이면 'directory not found' 가 뜨지만 그것이 곧 백업 소실을 뜻하지는 않습니다('rclone about gdrive:' 로 현재 연결을 확인하고 이 값과 대조하세요)."

# ── manifest.json 생성·업로드(세 번째 산출물) ──
# 위 헤더 주석의 실사고 근거: 이 파일 하나가 "경로 + 계정"의 뒷반쪽을
# 백업 자체와 같은 곳에 남긴다 — 로컬 로그가 사라져도 살아남는다.
MANIFEST_CREATED_UTC="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
jq -n \
  --arg backup_type "weekly" \
  --arg timestamp "$TS" \
  --arg created_at_utc "$MANIFEST_CREATED_UTC" \
  --arg account_email "$ACCOUNT_EMAIL" \
  --arg remote "$DEST" \
  --arg f1_name "full.sql.gz" --argjson f1_size "$FULL_SIZE" \
  --arg f2_name "storage-data.tar.gz" --argjson f2_size "$STORAGE_SIZE" \
  '{
    backup_type: $backup_type,
    timestamp: $timestamp,
    created_at_utc: $created_at_utc,
    account_email: $account_email,
    remote: $remote,
    artifacts: [
      {name: $f1_name, size_bytes: $f1_size},
      {name: $f2_name, size_bytes: $f2_size}
    ]
  }' > "$TMPDIR/manifest.json" || abort "manifest.json 생성 실패(jq)"

log "manifest.json 업로드 중..."
rclone copy "$TMPDIR/manifest.json" "$DEST/" || abort "manifest.json 업로드 실패"

# 세 산출물(DB 덤프·스토리지 타르·manifest) 전부 원격에 비어있지 않게
# 존재하는지 최종 재확인한다 — 위 2개짜리 확인과 동일한 원칙(P0: 상태
# 지레짐작 금지), manifest 를 더한 뒤 다시 한 번 통짜로 본다.
FINAL_JSON="$(rclone lsjson "$DEST" 2>/dev/null)" || abort "최종 업로드 검증(rclone lsjson) 실패"
FINAL_COUNT="$(printf '%s' "$FINAL_JSON" | jq '[.[] | select(.Size > 0)] | length')"
[ "$FINAL_COUNT" -eq 3 ] || abort "최종 업로드 검증 실패 — 원격에서 크기>0 객체 3개(DB 덤프+스토리지 타르+manifest.json)를 기대했으나 ${FINAL_COUNT}개 확인됨: $DEST"
log "최종 업로드 검증 완료: $DEST 에 객체 3개(비어있지 않음) 확인 — DB 덤프 + 스토리지 타르 + manifest.json"

# ── 보관정책(12주) ──
# ⚠️ 삭제 실패를 조용히 넘기지 않는다(backup.sh 와 동일 원칙): 이 삭제가
# 훗날 어떤 이유로든(스코프 변경 등) 막히면 오래된 백업이 무한히 쌓인다.
# 오늘 백업 자체는 이미 위에서 성공했으므로 데이터 유실은 아니지만, 방치를
# 사람이 모르고 지나가서는 안 된다.
log "보관정책 적용 중: ${GDRIVE_FOLDER}/ 아래 ${RETENTION_WEEKS}주 이상 지난 백업 삭제"
# --files-only: lsjson --recursive 는 Drive 의 폴더 객체도 같이 센다 —
# 빼지 않으면 파일 2개짜리 백업 1세트가 "객체 3개"(폴더 1 + 파일 2)로
# 잘못 보고된다.
BEFORE_COUNT="$(lsjson_or_explain "${GDRIVE_REMOTE}:${GDRIVE_FOLDER}" --recursive --files-only | jq 'length' 2>/dev/null || echo 0)"
if ! rclone delete "${GDRIVE_REMOTE}:${GDRIVE_FOLDER}" --min-age "${RETENTION_WEEKS}w"; then
  log "경고: 보관정책 삭제 실패 — delete 권한이 막혔을 수 있습니다. 방치하면 백업이 무한히 쌓입니다. rclone 인증 상태를 확인하세요."
  RETENTION_FAILED=1
else
  AFTER_COUNT="$(lsjson_or_explain "${GDRIVE_REMOTE}:${GDRIVE_FOLDER}" --recursive --files-only | jq 'length' 2>/dev/null || echo 0)"
  log "보관정책 적용 완료: 객체 ${BEFORE_COUNT} → ${AFTER_COUNT}개"
  RETENTION_FAILED=0
fi

log "완료: $DEST (전체 DB 덤프 + 오브젝트 스토리지 타르 + manifest.json, 업로드·검증 성공, 계정: $ACCOUNT_EMAIL)"

if [ "$RETENTION_FAILED" -eq 1 ]; then
  abort "백업 자체는 성공했지만 보관정책 삭제가 실패했습니다 — 위 경고를 확인하고 조치하세요(용량 무한 증가 방지)."
fi

exit 0
