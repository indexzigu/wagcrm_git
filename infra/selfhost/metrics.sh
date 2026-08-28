#!/usr/bin/env bash
set -euo pipefail

# 메뉴바 앱 리소스 그래프의 계측 SSOT — 읽기 전용. status.sh 의 자매 스크립트다
# (status.sh 소스 계약이 "docker 는 inspect 뿐"을 고정하므로 stats 가 필요한
# 계측은 이 파일이 소유한다). 판정(cpuLevel)은 여기서 완성한다 — 앱(Swift)은
# 파싱·그리기·차분만 한다.
#
# 네트워크는 **누적 카운터**를 그대로 싣는다 — 이 스크립트는 상태를 못 들고
# 있으므로 속도(바이트/초)는 앱의 링버퍼가 두 샘플 차분으로 계산한다(설계).
#
#   metrics.sh        # JSON 한 줄 출력
#
# 설계 정본: docs/private/specs/2026-08-14-menubar-server-control-design.md 개정 2
# 계약 테스트: scripts/__tests__/menubar-metrics.test.ts

# launchd 컨텍스트 대비 PATH 보강.
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"

# 테스트 훅 — 계약 테스트가 실행권한 없는 데이터 파일을 "bash <파일>" 로 주입한다
# (status.sh 와 같은 패턴 — PATH 스텁은 gh-stub-guard 계약 위반).
DOCKER="${METRICS_DOCKER_CMD:-docker}"
LAUNCHCTL="${METRICS_LAUNCHCTL_CMD:-launchctl}"
PS="${METRICS_PS_CMD:-ps}"
NETTOP="${METRICS_NETTOP_CMD:-nettop}"
SYSCTL="${METRICS_SYSCTL_CMD:-sysctl}"
DU="${METRICS_DU_CMD:-du}"

PROD_LABEL="kr.ygrd.wagcrm.app"
# supabase-db 의 데이터는 docker 볼륨이 아니라 **바인드 마운트**다(실측:
# docker inspect Mounts → /var/lib/postgresql/data). 그래서 호스트 du 로 잰다.
DB_DATA_DIR="$HOME/selfhost/supabase-docker/volumes/db/data"

CORES="$($SYSCTL -n hw.ncpu 2>/dev/null || echo 0)"
case "$CORES" in '' | *[!0-9]*) CORES=0 ;; esac

# raw CPU%(코어 합산 값) → 기계 전체 대비 %. 코어 수를 모르면 raw 그대로
# (판정 불능을 error 로 가장하지 않는다 — 아래 레벨은 그 값 기준).
norm_pct() {
  awk -v r="$1" -v c="$CORES" 'BEGIN{ if (c > 0) printf "%.1f", r / c; else printf "%.1f", r + 0 }'
}

# "지금 서버가 힘든가" 판정 — 기계 전체 대비 70% 노랑 · 90% 빨강(오너 승인 임계).
level_for() {
  awk -v p="$1" 'BEGIN{ if (p >= 90) print "error"; else if (p >= 70) print "warn"; else print "ok" }'
}

# ── CRM 서버 (launchd 프로세스) ─────────────────────────────
# PID → CPU%·RSS(ps) + 누적 송수신 바이트(nettop, 프로세스 필터).

CRM_JSON='"available":false'
PID="$($LAUNCHCTL list "$PROD_LABEL" 2>/dev/null | awk '/"PID"/{gsub(/[^0-9]/, ""); print; exit}' || true)"
if [ -n "$PID" ]; then
  read -r CRM_CPU_RAW CRM_RSS_KB <<EOF
$($PS -o %cpu=,rss= -p "$PID" 2>/dev/null | awk '{c += $1; r += $2} END{printf "%.1f %d", c, r}')
EOF
  # nettop -P 는 프로세스 행을 "<이름>.<PID>" 로 낸다 — 헤더·타 행은 안 걸린다.
  # ⚠️ 이 수치는 "현재 열린 연결"의 누적이라 연결이 닫히면 **줄어들고**, 열린
  # 연결이 하나도 없으면 **행 자체가 사라진다**(둘 다 실측). 앱 차분이 음수를
  # 버리므로 근사치로 안전하다.
  # ⛔ **이것은 권한 문제가 아니다 — 루트를 얻어도 해결되지 않는다**(2026-08-14
  # 실측 3종): ①비-root 로도 다른 사용자 소유 프로세스(_mdnsresponder)가 그대로
  # 읽힌다 = 루트가 넓혀줄 가시성이 없다 ②커널의 프로세스 자원 통계
  # (`rusage_info`, sys/resource.h)에는 diskio 바이트만 있고 **네트워크 바이트
  # 필드가 아예 없다** = 수명 누적을 줄 API 가 누구에게도 없다 ③연결을 하나 열고
  # 닫은 프로세스는 살아 있는데도 nettop 에서 사라진다 = flow 기반 확정.
  # 진짜 수명 누적을 원하면 root 상주 데몬(pf 라벨 규칙) 또는 SIP 해제 + dtrace 가
  # 필요한데, 전자는 "상주 데몬 금지" 설계 제약에, 후자는 보안 등급 하향에 걸린다.
  # 지금 표시는 **속도**라 이 근사로 충분하다 — 파헤치기 전에 이 문단을 읽을 것.
  NET_OUT="$($NETTOP -P -x -l 1 -p "$PID" 2>/dev/null | awk -v pid="$PID" '$2 ~ ("\\." pid "$") {print $3, $4; exit}' || true)"
  CRM_RX="${NET_OUT%% *}"
  CRM_TX="${NET_OUT##* }"
  CRM_PCT="$(norm_pct "$CRM_CPU_RAW")"
  CRM_LEVEL="$(level_for "$CRM_PCT")"
  CRM_MEM="$(awk -v k="$CRM_RSS_KB" 'BEGIN{printf "%.0f", k * 1024}')"
  CRM_JSON="\"available\":true,\"cpuPct\":$CRM_PCT,\"cpuLevel\":\"$CRM_LEVEL\",\"memBytes\":$CRM_MEM,\"netRxBytes\":${CRM_RX:-0},\"netTxBytes\":${CRM_TX:-0}"
fi

# ── 데이터베이스 (supabase 스택 컨테이너 합산) ───────────────
# "데이터베이스"의 실체는 supabase-db 하나가 아니라 스택 전체(11개 컨테이너)라
# 이름에 supabase 가 들어간 행을 전부 합산한다. NetIO 는 컨테이너 기동 이후
# 누적치 — 재시작으로 리셋되면 앱 쪽 차분이 음수를 버린다.

DB_JSON='"available":false'
STATS_OUT="$($DOCKER stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}' 2>/dev/null || true)"
if [ -n "$STATS_OUT" ]; then
  read -r DB_COUNT DB_CPU_RAW DB_MEM DB_RX DB_TX <<EOF
$(printf '%s\n' "$STATS_OUT" | awk -F'|' '
    function tb(s,   n, u, m) {
      n = s + 0; u = s
      sub(/^[[:space:]]*[0-9.]+/, "", u); gsub(/[[:space:]]/, "", u)
      if (u == "kB" || u == "KB") m = 1e3
      else if (u == "MB") m = 1e6
      else if (u == "GB") m = 1e9
      else if (u == "TB") m = 1e12
      else if (u == "KiB") m = 1024
      else if (u == "MiB") m = 1048576
      else if (u == "GiB") m = 1073741824
      else if (u == "TiB") m = 1099511627776
      else m = 1
      return n * m
    }
    $1 ~ /supabase/ {
      count++
      cpu += $2 + 0
      split($3, mm, "/"); mem += tb(mm[1])
      split($4, nn, "/"); rx += tb(nn[1]); tx += tb(nn[2])
    }
    END { printf "%d %.1f %.0f %.0f %.0f", count, cpu, mem, rx, tx }')
EOF
  if [ "$DB_COUNT" -gt 0 ]; then
    DB_PCT="$(norm_pct "$DB_CPU_RAW")"
    DB_LEVEL="$(level_for "$DB_PCT")"
    DB_JSON="\"available\":true,\"cpuPct\":$DB_PCT,\"cpuLevel\":\"$DB_LEVEL\",\"memBytes\":$DB_MEM,\"netRxBytes\":$DB_RX,\"netTxBytes\":$DB_TX"
  fi
fi

# ── DB 데이터 크기 (postgres 데이터 디렉터리) ────────────────
# 바인드 마운트라 호스트에서 직접 잰다(읽기 전용). 디렉터리가 없으면 확인 불가.

DBDATA_JSON='"available":false'
DBDATA_KB="$($DU -sk "$DB_DATA_DIR" 2>/dev/null | awk '{print $1; exit}' || true)"
if [ -n "$DBDATA_KB" ]; then
  DBDATA_JSON="\"available\":true,\"bytes\":$(awk -v k="$DBDATA_KB" 'BEGIN{printf "%.0f", k * 1024}')"
fi

printf '{"schemaVersion":1,"generatedAt":"%s","cores":%s,"crm":{%s},"db":{%s},"dbData":{%s}}\n' \
  "$(date +%Y-%m-%dT%H:%M:%S%z)" "$CORES" "$CRM_JSON" "$DB_JSON" "$DBDATA_JSON"
