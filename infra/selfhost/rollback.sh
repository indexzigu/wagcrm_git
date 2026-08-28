#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"

# WAG CRM 셀프호스트 컷오버 롤백 — 실행체.
#
# ⚠️⚠️⚠️ 이 스크립트가 되돌리지 "못하는" 것 — 실행 전에 반드시 읽을 것 ⚠️⚠️⚠️
#
#   컷오버(cutover.sh) 이후 자체호스팅(iMac) 시스템에 새로 쓰인 데이터는
#   이 롤백으로 복구되지 않는다. 롤백은 프로덕션 호스트네임과 크론을
#   "컷오버 이전 배포(클라우드)"로 되돌릴 뿐이고, 그 배포는 컷오버 시점
#   이후 자체호스팅에서 일어난 어떤 쓰기도 알지 못한다 — 즉:
#
#     - 롤백 이후 사용자가 보는 데이터는 "컷오버 시점"의 클라우드 데이터다.
#       컷오버부터 롤백까지 자체호스팅에서 생성/수정된 캠페인·정산·셀러
#       메모·업로드 파일 등은 전부 사라진 것처럼 보인다(실제로는 자체호스팅
#       DB/스토리지에 남아있지만, 클라우드 쪽에서는 존재한 적이 없다).
#     - 이 기간 동안 활성화됐던 크론(네이버 주문/정산 동기화, 세금계산서
#       확인, 미디어 재호스팅, 인스타그램 토큰 갱신)이 외부 시스템에 이미
#       일으킨 부수효과(주문 상태 변경, 발행된 세금계산서, 무효화된 토큰
#       등)는 되돌려지지 않는다 — 그건 이 스크립트의 범위 밖이다.
#
#   그래서 롤백은 "공짜 되돌리기"가 아니라 "컷오버 이후 쌓인 자체호스팅
#   전용 데이터를 포기하는 결정"이다. 이 비용 때문에 컷오버 계획서
#   (docs/private/plans/2026-08-12-imac-selfhost-migration.md, Task 15)는
#   롤백을 "중대 장애 시에만"으로 한정한다. 되돌리려면 그 데이터를 다시
#   클라우드로 역이관하는 별도 작업이 필요하며 이 스크립트는 그것을 하지
#   않는다.
#
# 이 스크립트가 실제로 하는 일(자동화됨):
#   1. infra/selfhost/crontab 의 보류(부수효과) 크론 5개를 다시 주석 처리
#      (재잠금) 하고 재설치한다 — 자체호스팅이 더 이상 네이버 동기화 등을
#      발화하지 않게 한다.
#   2. cloudflared ingress 에서 프로덕션 호스트네임 규칙을 제거하고 터널을
#      재기동한다 — 자체호스팅 스택이 더 이상 그 호스트네임을 서빙하지
#      않게 한다.
#
# 이 스크립트가 하지 "않는" 일(수동 필요, 아래 Step 3 안내 참고):
#   - Cloudflare DNS 에서 프로덕션 호스트네임을 클라우드 배포로 되돌리는 것.
#     `cutover.sh` 의 `cloudflared tunnel route dns` 는 이 호스트네임의
#     DNS 레코드를 터널로 덮어썼다 — 되돌리려면 Cloudflare DNS 에서 그
#     레코드를 컷오버 이전 대상(클라우드 배포)으로 다시 바꿔야 한다. 이
#     저장소에는 그 되돌리기를 검증된 형태로 자동화한 도구가 없어(DNS
#     레코드 변경은 계정 권한이 필요한 작업, P0) 여기서는 하지 않는다.
#   - 클라우드 배포 쪽 크론/서비스를 재활성화하는 것 — 그건 그 플랫폼(Vercel
#     등) 자체의 조작이라 이 저장소 밖의 작업이다.
#
# 사용법:
#   ./infra/selfhost/rollback.sh              # 대화형 확인 문구 입력 필요
#   ./infra/selfhost/rollback.sh --yes         # 비대화형(이미 확인했음을 전제) — 그래도 로그에 남긴다

log() { printf '[rollback] %s\n' "$*"; }
warn() { printf '[rollback] 경고: %s\n' "$*" >&2; }
abort() { printf '[rollback] 중단: %s\n' "$*" >&2; exit 1; }

CRONTAB_FILE="$REPO_ROOT/infra/selfhost/crontab"
CLOUDFLARED_CONFIG="$HOME/.cloudflared/config.yml"
PROD_HOSTNAME="crm.ygrd.kr"
TUNNEL_NAME="wagcrm"
HELD_CRON_JOBS="refresh-instagram-token rehost-seller-media naver-settlement-sync naver-order-sync tax-invoice-issue-confirm"

YES=0
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    -h|--help)
      cat <<'EOF'
사용법: rollback.sh [--yes]
  --yes   대화형 확인 문구 입력을 생략한다(비대화형 실행용) — 그래도 이
          플래그를 썼다는 사실 자체가 무엇을 잃는지 이해했다는 전제다.
EOF
      exit 0
      ;;
    *) abort "알 수 없는 옵션: $arg" ;;
  esac
done

cat <<'EOF'
════════════════════════════════════════════════════════════════
  롤백은 컷오버 이후 자체호스팅에 새로 쓰인 데이터를 복구하지 않습니다.
  프로덕션 호스트네임과 크론만 컷오버 이전 배포로 되돌립니다.
  위 파일 상단 주석(무엇이 안 돌아오는지)을 먼저 읽으십시오.
════════════════════════════════════════════════════════════════
EOF

if [ "$YES" -ne 1 ]; then
  if [ -t 0 ]; then
    printf '[rollback] 위 데이터 유실 범위를 이해하고도 진행합니까? 정확히 다음 문구를 입력하십시오: ROLLBACK UNDERSTOOD\n> '
    confirm_text=""
    read -r confirm_text
    [ "$confirm_text" = "ROLLBACK UNDERSTOOD" ] || abort "확인 문구가 일치하지 않아 중단합니다(입력값: '${confirm_text}')."
  else
    abort "비대화형 실행에는 --yes 플래그가 필요합니다(대화형 확인을 생략하려면 명시적으로 --yes 를 넘기십시오)."
  fi
else
  warn "--yes 로 대화형 확인을 생략했습니다 — 위 데이터 유실 범위를 이미 이해했다는 전제로 진행합니다."
fi

log "=== Step 1: 보류 크론 5개 재잠금(주석 재처리) ==="
[ -w "$CRONTAB_FILE" ] || abort "$CRONTAB_FILE 에 쓸 수 없습니다."
for job in $HELD_CRON_JOBS; do
  if grep -q "^[0-9].*run-cron\.sh ${job} " "$CRONTAB_FILE"; then
    sed -i.bak "s|^\([0-9].*run-cron\.sh ${job} .*\)|# \1|" "$CRONTAB_FILE"
    rm -f "${CRONTAB_FILE}.bak"
    log "재잠금(주석 처리): $job"
  else
    log "이미 비활성이거나 예상한 형식이 아님(스킵): $job"
  fi
done
if ! crontab "$CRONTAB_FILE"; then
  abort "crontab 재설치 실패 — $CRONTAB_FILE 은 이미 재잠금 상태로 수정됐을 수 있습니다. 'crontab -l' 로 현재 설치 상태를 확인하십시오."
fi
active_after="$(crontab -l 2>/dev/null | grep -cE '^[0-9*].*run-cron\.sh' || true)"
log "Step 1 완료 — 현재 활성 크론 ${active_after:-0}개(부수효과 5개를 재잠금했다면 crontab 파일의 앱 크론 수보다 5개 적어야 한다 — 고정 숫자로 판정하지 말 것: 크론은 계속 늘어난다)"

log "=== Step 2: cloudflared ingress 에서 프로덕션 호스트네임 규칙 제거 ==="
if [ -f "$CLOUDFLARED_CONFIG" ] && grep -q "hostname: $PROD_HOSTNAME" "$CLOUDFLARED_CONFIG"; then
  tmp="$(mktemp)"
  # `- hostname: <PROD_HOSTNAME>` 줄과 바로 다음 `service:` 줄 2줄을
  # 함께 제거한다(cutover.sh 가 추가한 형태 그대로). hostname 매치 줄
  # 자체는 이 규칙의 `next` 로 이미 1줄 제거되므로, skip 은 그 "다음"
  # 1줄(service: 줄)만 추가로 건너뛰면 된다 — skip=2 로 두면 catch-all
  # (`- service: http_status:404`)까지 같이 지워지는 실사고가 난다(교차
  # 검증에서 실측 재현: skip=2 로 3줄이 지워져 catch-all 이 사라짐).
  awk -v host="$PROD_HOSTNAME" '
    $0 ~ ("- hostname: " host) { skip=1; next }
    skip > 0 { skip--; next }
    { print }
  ' "$CLOUDFLARED_CONFIG" > "$tmp"
  if grep -q "hostname: $PROD_HOSTNAME" "$tmp"; then
    rm -f "$tmp"
    abort "ingress 규칙 제거 실패 — $CLOUDFLARED_CONFIG 형식이 예상과 다릅니다. 파일은 아직 변경되지 않았습니다. 수동으로 그 hostname 규칙 2줄을 제거하십시오."
  fi
  mv "$tmp" "$CLOUDFLARED_CONFIG"
  log "$CLOUDFLARED_CONFIG 에서 $PROD_HOSTNAME ingress 규칙 제거"

  if ! launchctl kickstart -k "gui/$(id -u)/kr.ygrd.wagcrm.tunnel"; then
    abort "터널 서비스 재기동 실패 — ingress 는 이미 바뀌었지만 실행 중인 cloudflared 는 옛 설정을 물고 있을 수 있습니다. 수동으로 'launchctl kickstart -k gui/\$(id -u)/kr.ygrd.wagcrm.tunnel' 을 실행하십시오."
  fi
  log "터널 서비스 재기동 완료 — 자체호스팅 스택은 더 이상 $PROD_HOSTNAME 을 서빙하지 않습니다(단, DNS 자체는 아직 안 바뀌었을 수 있음 — 아래 Step 3)."
else
  log "ingress 에 $PROD_HOSTNAME 규칙이 없습니다 — 이미 제거됐거나 컷오버가 Stage 7 까지 가지 않았을 수 있습니다. 스킵."
fi

cat <<EOF
=== Step 3(수동 — 이 스크립트가 자동화하지 않음): Cloudflare DNS 를 클라우드 배포로 되돌리기 ===

  cutover.sh Stage 7 은 'cloudflared tunnel route dns $TUNNEL_NAME $PROD_HOSTNAME'
  로 $PROD_HOSTNAME 의 DNS 레코드를 이 터널로 덮어썼습니다. 이 레코드를
  컷오버 이전 대상(클라우드 배포)으로 되돌리는 작업은 Cloudflare 계정
  권한이 필요한 DNS 변경이라 이 스크립트가 대행하지 않습니다(P0 — 계정/
  DNS 변경은 에이전트가 자동 실행하지 않고 오너가 직접 확인·실행합니다).
  Cloudflare 대시보드에서 이 레코드를 컷오버 이전 값으로 되돌리거나
  삭제해, 클라우드 배포 쪽 도메인 연결이 다시 유효해지게 하십시오.

  ⚠️ 되돌릴 "이전 값"은 기억에 의존하지 마십시오 — cutover.sh 가 덮어쓰기
  직전에 기존 레코드를 로그에 남깁니다:

      grep '덮어쓰기 전 기존 DNS 레코드' "\$HOME/selfhost/logs/cutover.log" | tail -1

=== Step 4(수동 — 이 스크립트 밖): 클라우드 배포 쪽 되살리기 ===

  이 저장소 안에서 자동화할 수 있는 부분은 여기까지입니다. 클라우드
  배포(Vercel 등)가 정지·축소돼 있었다면 그쪽 플랫폼에서 직접 재활성화가
  필요합니다.

  ⚠️ 클라우드 배포가 낡아 있습니다. 자동 승격은 2026-08-13 컷오버 때 껐으므로
  (오너 결정 — 이관 후에도 4시간마다 구 플랫폼 빌드를 태우지 않기 위해)
  \`release\` 는 그 시점에 멈춰 있습니다. 최신 코드로 되돌리려면 GitHub Actions
  → "Promote (auto)" → Run workflow 로 **수동 승격**하십시오.

  ⛔ 그리고 승격만으로는 **크론이 하나도 돌지 않습니다**:

  2026-08-15 에 vercel.json 의 crons 를 **전부 제거**했습니다. 컷오버 뒤에도 구
  배포가 같은 잡을 계속 발화해 자체호스팅과 이중 실행되고 있었기 때문입니다
  (07:00 자체호스팅 / 07:01 구 배포, 실측). 따라서 승격이 만드는 새 배포에는
  크론이 **등록되지 않습니다** — 되살리려면 그 제거 커밋을 되돌리는 별도 PR 이
  필요합니다(자동 부활이 없다는 것이 이제 안전 기본값입니다).

  순서:

      ① 먼저 이 스크립트가 되잠근 자체호스팅 크론이 정말 꺼졌는지 확인
         (crontab -l 로 부수효과 5개가 주석 처리됐는지)
      ② 수동 승격
      ③ 롤백이 길어질 것 같으면 vercel.json crons 복원 PR 을 올려 승격
         (짧으면 Actions → "Scheduled Crons" 수동 실행으로 버팁니다)

  ③ 을 ① 보다 먼저 하면 네이버 주문/정산 동기화·세금계산서 확인·미디어
  재호스팅·인스타그램 토큰 갱신이 **양쪽에서 동시 발화**합니다 — 컷오버
  Stage 8 이 막으려 했던 바로 그 사고를 반대 방향으로 일으키는 것입니다.

════════════════════════════════════════════════════════════════
  다시 한번: 컷오버 이후 자체호스팅에만 쓰인 데이터는 이 롤백으로
  복구되지 않습니다. 필요하면 별도의 역이관 작업을 계획하십시오.
════════════════════════════════════════════════════════════════
EOF

log "롤백(자동화 가능한 범위) 완료 — Step 3·4 는 위 안내대로 수동으로 마무리하십시오."
exit 0
