import { formatLastSyncLabel } from '@/lib/date-utils';

/**
 * 주문 관리 캠페인 카드의 「발주서 준비됨 · 발주 대기 N건 · HH:MM 기준」 줄(데스크톱 전용, 발주 자동화 2단계).
 *
 * 그리는 조건은 서버가 준비본을 허락할 때다(`preparedPo` — 스위치 켜짐 · 마지막 변경 동기화 6시간 이내 ·
 * 조회창이 스냅샷 갱신 범위 안. 판정 SSOT `prepared-po.ts`, 발주요청 창과 **같은 판정**이라 카드는
 * 「준비됨」인데 창은 막는 모순이 없다). 허락하지 않으면(스위치 꺼짐 등) 줄 자체를 그리지 않는다.
 * N 은 카드의 발주 대기 수(주문확인 전+후)다 — 실제로 실릴 건수는 발주요청 미리보기가 정확히 센다.
 *
 * 발주 대기가 0 이어도 줄을 비우지 않고 흐린 「발주 대기 없음」을 그린다 — 주문이 들고 날 때마다 줄이
 * 생겼다 사라지면 아래 버튼 줄이 위아래로 튄다(상태 낱말 기준 ⑥ 자리 고정, 오너 확정 2026-10-08).
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
  if (!preparedPo) return null;
  if (pendingCount <= 0) {
    // 할 일이 없는 상태라 점·색을 받지 않는다(상태 낱말 기준 ②). 높이는 준비됨 줄과 같다(text-xs 한 줄).
    return (
      <div
        className="flex basis-full w-full items-center text-xs font-medium text-slate-500"
        data-testid="po-ready-line"
        data-empty="true"
      >
        발주 대기 없음
      </div>
    );
  }
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
