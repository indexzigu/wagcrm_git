#!/usr/bin/env bash
set -euo pipefail

# 확장 고리 운영자(헤드리스 claude)가 프로덕션 DB 를 읽는 통로.
#   expansion-readonly-sql.sh "<SELECT/WITH 문 1개>"
#
# ⚠️ 이 래퍼의 문장 검사는 「최선 노력 필터」이지 보안 경계가 아니다 — 이름을 다시 쓰는 우회는 늘 존재한다.
# 진짜 경계는 전용 SELECT 전용 DB 역할이며 오너 조치로 대기 중이다. 그때까지의 겹겹 방벽:
#   1) 비슈퍼유저 역할 postgres 로 접속(supabase_admin 은 슈퍼유저라 쓰지 않는다)
#   2) 세션 설정 default_transaction_read_only=on (세션 안에서 되돌릴 수 있어 단독 방벽이 아니다)
#   3) 접두 검사(SELECT/WITH) + 주석·제어문자·다중 문장·위험 낱말 거부 — docker 호출 전 1차 관문
# 거부는 exit 2 — docker 는 호출되지 않는다. 오탐(안전 쪽 거부)은 허용한다.

# cron 의 최소 PATH 대비(status.sh 와 같은 보강). 기존 PATH 를 앞에 둔다.
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"
DOCKER=docker

reject() { printf 'expansion-readonly-sql: %s\n' "$1" >&2; exit 2; }

[ "$#" -eq 1 ] || reject "인자는 SQL 1개여야 합니다"
SQL="$1"

# 파서 불일치 계층을 없앤다: 주석 표지(--, /*, */)는 어디에 있든 거부한다(문자열 리터럴 안이어도 오탐 허용).
# Postgres 는 줄 주석을 \r 에서도 끝내고 블록 주석은 중첩되므로, 우리가 「주석 안」이라 본 글자가
# 서버에서는 실행 문장일 수 있다. 제어문자(\n·\t 제외)도 거부한다. 검증한 문자열을 그대로 실행한다.
case "$SQL" in
  *"/*"*|*"*/"*|*"--"*) reject "주석은 허용하지 않습니다" ;;
esac
ctl="${SQL//$'\n'/}"; ctl="${ctl//$'\t'/}"
case "$ctl" in
  *[[:cntrl:]]*) reject "제어문자는 허용하지 않습니다" ;;
esac

norm="${SQL#"${SQL%%[![:space:]]*}"}"
[ -n "$norm" ] || reject "빈 SQL"

lower="$(printf '%s' "$norm" | tr '[:upper:]' '[:lower:]')"
case "$lower" in
  select|select[!a-z0-9_]*|with|with[!a-z0-9_]*) ;;
  *) reject "SELECT/WITH 로 시작하는 읽기 전용 문장만 허용합니다" ;;
esac

# 위험 낱말 거부 목록(낱말 경계). 오탐은 안전 쪽이라 허용한다.
DENY='(^|[^a-z0-9_])(dblink|pg_read_|pg_ls_|lo_|query_to_xml|cursor_to_xml|ts_stat|ts_rewrite)|(^|[^a-z0-9_])(uescape|copy|pg_terminate_backend|pg_cancel_backend|set_config|pg_reload_conf|reset|set[[:space:]]+role|set[[:space:]]+session)([^a-z0-9_]|$)'
# 낱말 시작 접두 거부: pg_net(net.·http_)·vault·장시간 대기·복제 슬롯·통계 초기화(*_reset 으로 끝나는 식별자 포함).
DENY_PREFIX='(^|[^a-z0-9_])(net\.|http_|vault\.|pg_sleep|pg_create_physical_replication_slot|pg_create_logical_replication_slot|pg_drop_replication_slot|pg_stat_reset)|(^|[^a-z0-9_])[a-z0-9_]*_reset([^a-z0-9_]|$)'
# 따옴표·점 주변 공백으로 이름을 다시 쓴 형태(`"net"."http_get"`, `net . http_get`)도 같은 검사를 거친다.
squeezed="$(printf '%s' "$lower" | tr '"\n\t\r' '    ' | sed -E 's/[[:space:]]*\.[[:space:]]*/./g')"
for cand in "$lower" "$squeezed"; do
  if [[ "$cand" =~ $DENY ]] || [[ "$cand" =~ $DENY_PREFIX ]]; then
    reject "허용되지 않는 낱말이 있습니다"
  fi
done

# 유니코드 이스케이프 식별자(U&"…", U&'…')로 이름을 다시 쓰는 우회를 막는다.
case "$lower" in
  *'u&"'*|*"u&'"*) reject "유니코드 이스케이프 식별자는 허용하지 않습니다" ;;
esac

# 문장 여러 개 금지: 첫 ; 뒤에 공백 아닌 글자가 남으면 거부(끝의 ; 하나는 허용).
case "$norm" in
  *\;*)
    rest="${norm#*;}"
    rest="${rest//[[:space:]]/}"
    [ -z "$rest" ] || reject "문장 여러 개는 허용하지 않습니다"
    ;;
esac

exec "$DOCKER" exec -e PGOPTIONS='-c default_transaction_read_only=on' supabase-db \
  psql -U postgres -d postgres -At -v ON_ERROR_STOP=1 -c "$SQL"
