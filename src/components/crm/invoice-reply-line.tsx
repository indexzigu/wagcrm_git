import { formatInvoiceReplyLine, type InvoiceReplyStatus } from '@/lib/order-converter/invoice-reply-status';

/**
 * 주문 관리 캠페인 카드의 「회신 도착 · N건 · HH:MM」 줄(데스크톱 전용).
 *
 * 크론 `scan-invoice-replies` 가 감지한 송장 회신 중 **아직 처리 안 된 것**이 있을 때만 그린다 —
 * 「처리됨」 판정은 서버가 배송대기 상태에서 파생해 `invoiceReply` 로 준다(null 이면 안 그린다).
 * 운영자가 할 일은 그대로 「송장회신」 버튼이다(1단계는 감지만 한다).
 *
 * 색은 같은 카드의 「미확인 N」과 같은 주의(caution) 계열 — 손이 필요한 소수 건 신호다.
 * 도트(면적 캐리어) + 굵은 글자, 새 색 토큰 없음(P8).
 */
export function InvoiceReplyLine({ reply, now }: { reply: InvoiceReplyStatus | null | undefined; now?: Date }) {
  if (!reply) return null;
  const label = formatInvoiceReplyLine(reply, now);
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--status-caution-text)] tabular-nums whitespace-nowrap"
      title="브랜드사의 송장 회신 메일이 도착했습니다. 송장회신 버튼으로 불러와 발송처리하세요."
      data-testid="invoice-reply-line"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-[var(--status-caution)] shrink-0" aria-hidden="true" />
      {label}
    </span>
  );
}
