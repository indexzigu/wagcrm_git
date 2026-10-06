import { formatLastSyncLabel } from '@/lib/date-utils';

/**
 * 주문 관리 캠페인 카드의 「발주서 준비됨 · 발주 대기 N건 · HH:MM 기준」 줄(데스크톱 전용, 발주 자동화 2단계).
 *
 * 그리는 조건은 둘 다 참일 때뿐이다 — ①서버가 준비본을 허락한다(`preparedPo` — 스위치 켜짐 · 마지막
 * 변경 동기화 6시간 이내 · 조회창이 스냅샷 갱신 범위 안. 판정 SSOT `prepared-po.ts`, 발주요청 창과
 * **같은 판정**이라 카드는 「준비됨」인데 창은 막는 모순이 없다) ②발주할 주문이 있다(발주 대기 > 0).
 * N 은 카드의 발주 대기 수(주문확인 전+후)다 — 실제로 실릴 건수는 발주요청 미리보기가 정확히 센다.
 *
 * 색은 의도적으로 중립이다: 「손이 필요한 소수」를 알리는 송장 회신 줄(caution, `invoice-reply-line.tsx`)
 * 보다 한 단계 낮은 정보 신호라, 도트만 브랜드 네이비(중립 태그 캐리어 — P8 §4)로 둔다. 두 줄이 함께
 * 뜨면 이 줄이 위, 송장 회신 줄이 버튼 바로 위다. aria-live 는 걸지 않는다(폴링마다 다시 읽히면 소음).
 */
export function PoReadyLine({
  preparedPo,
  pendingCount,
  now,
}: {
  preparedPo: { asOfIso: string } | null | undefined;
  pendingCount: number;
  now?: Date;
}) {
  if (!preparedPo || pendingCount <= 0) return null;
  const when = formatLastSyncLabel(preparedPo.asOfIso, now);
  return (
    <div
      className="flex basis-full w-full items-center gap-1.5 text-xs font-medium text-slate-700 tabular-nums"
      data-testid="po-ready-line"
    >
      <span className="w-2 h-2 rounded-full bg-primary shrink-0" aria-hidden="true" />
      <span>
        발주서 준비됨 · 발주 대기 {pendingCount.toLocaleString('ko-KR')}건{when ? ` · ${when} 기준` : ''}
        <span className="sr-only">. 발주요청에서 준비본을 쓸 수 있습니다</span>
      </span>
    </div>
  );
}
