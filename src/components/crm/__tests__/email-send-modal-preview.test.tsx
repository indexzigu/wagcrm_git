// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EmailSendModal from '../shipping/modals/EmailSendModal';
import { PoReadyLine } from '../po-ready-line';

/**
 * 발주요청 창(발주 자동화 2단계)의 흐름 계약.
 * 네트워크는 전부 가짜다 — 실제 발주확인·메일은 나가지 않는다.
 */

type Route = { status?: number; body: unknown };
let routes: { match: (url: string, method: string) => boolean; reply: () => Route }[] = [];
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? 'GET').toUpperCase();
  const hit = routes.find((r) => r.match(url, method));
  const { status = 200, body } = hit ? hit.reply() : { body: {} };
  return new Response(JSON.stringify(body), { status });
});

const previewBody = (over: Record<string, unknown> = {}) => ({
  source: 'prepared',
  asOfIso: new Date().toISOString(),
  rows: [
    { productOrderId: 'A', orderId: 'O1', recipientName: '수령A', optionName: '블루', quantity: 1, shippingMemo: '', needsConfirm: true, missing: [] },
    { productOrderId: 'B', orderId: 'O2', recipientName: '', optionName: '레드', quantity: 2, shippingMemo: '문 앞', needsConfirm: false, missing: ['recipient'] },
  ],
  summary: { lineCount: 2, quantityTotal: 3, needsConfirmCount: 1, missingCount: 1 },
  empty: null,
  ...over,
});

const commitBody = {
  fileName: '발주서_브랜드.xlsx',
  fileBase64: btoa('xlsx'),
  productOrderIds: ['A', 'B'],
  dropped: [],
  confirm: { requested: 1, succeeded: 1, failed: 0, firstError: '' },
};

function useRoutes(opts: { available?: boolean; mailFailOnce?: boolean } = {}) {
  let mailCalls = 0;
  routes = [
    {
      match: (u, m) => u.endsWith('/purchase-order') && m === 'GET',
      reply: () => ({
        body: {
          availability: opts.available === false
            ? { available: false, reason: 'disabled', message: '이 캠페인은 발주서 자동 준비가 꺼져 있습니다.', asOfIso: null }
            : { available: true, asOfIso: new Date().toISOString() },
        },
      }),
    },
    { match: (u, m) => u.includes('/purchase-order?source=') && m === 'GET', reply: () => ({ body: previewBody() }) },
    { match: (u, m) => u.endsWith('/purchase-order') && m === 'POST', reply: () => ({ body: commitBody }) },
    {
      match: (u) => u.endsWith('/send-email'),
      reply: () => {
        mailCalls += 1;
        return opts.mailFailOnce && mailCalls === 1 ? { status: 500, body: { error: 'SMTP 오류' } } : { body: { ok: true } };
      },
    },
  ];
}

function renderModal(onResult = vi.fn(), onSuccess = vi.fn()) {
  render(
    <EmailSendModal
      campaignId="c1"
      defaultTo="brand@example.com"
      defaultSubject="발주"
      defaultMessage="본문"
      onClose={vi.fn()}
      onSuccess={onSuccess}
      onResult={onResult}
      addToast={vi.fn()}
    />,
  );
  return { onResult, onSuccess };
}

const callsTo = (fragment: string, method = 'GET') =>
  fetchMock.mock.calls.filter(([u, init]) => String(u).includes(fragment) && ((init?.method ?? 'GET').toUpperCase() === method));

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('발주요청 창 — 3단계 흐름', () => {
  it('준비본이 가능하면 기본 선택되고, 미리보기는 쓰기 없이 표를 보여 준다', async () => {
    useRoutes();
    const user = userEvent.setup();
    renderModal();
    const prepared = await screen.findByRole('radio', { name: /준비본 사용/ });
    await waitFor(() => expect(prepared).toBeChecked());
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    expect(await screen.findByRole('region', { name: '발주서 미리보기 표' })).toBeInTheDocument();
    expect(callsTo('/purchase-order?source=prepared')).toHaveLength(1);
    expect(callsTo('/purchase-order', 'POST')).toHaveLength(0);
    expect(callsTo('/send-email', 'POST')).toHaveLength(0);
  });

  it('준비본을 못 쓰면 비활성 + 사유를 보이고 「지금 다시 수집」이 선택된다', async () => {
    useRoutes({ available: false });
    renderModal();
    const prepared = await screen.findByRole('radio', { name: /준비본 사용/ });
    await waitFor(() => expect(prepared).toBeDisabled());
    expect(screen.getByRole('radio', { name: /지금 다시 수집/ })).toBeChecked();
    expect(screen.getByText(/꺼져 있습니다/)).toBeInTheDocument();
  });

  it('창 안에 form 이 없다 — 입력칸 Enter 가 발주확인·메일 발송이 되지 않게', async () => {
    useRoutes();
    renderModal();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('form')).toBeNull();
  });

  it('빈 칸 주문이 있으면 확인 체크 전까지 발송 버튼이 잠긴다', async () => {
    useRoutes();
    const user = userEvent.setup();
    renderModal();
    await screen.findByRole('radio', { name: /준비본 사용/ });
    await user.click(await screen.findByRole('button', { name: '미리보기' }));
    const send = await screen.findByRole('button', { name: '발주확인하고 발송' });
    expect(send).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /빈 칸이 있는 1건/ }));
    expect(send).toBeEnabled();
  });

  it('확정 → 메일 → 완료. 확정 요청은 미리보기 집합과 확인 전 주문만 싣는다', async () => {
    useRoutes();
    const user = userEvent.setup();
    const { onResult } = renderModal();
    await screen.findByRole('radio', { name: /준비본 사용/ });
    await user.click(await screen.findByRole('button', { name: '미리보기' }));
    await user.click(await screen.findByRole('checkbox', { name: /빈 칸이 있는/ }));
    await user.click(screen.getByRole('button', { name: '발주확인하고 발송' }));
    expect(await screen.findByText(/발송 완료 · 상품주문 2건/)).toBeInTheDocument();
    const [, init] = callsTo('/purchase-order', 'POST')[0];
    expect(JSON.parse(String(init!.body))).toMatchObject({ source: 'prepared', productOrderIds: ['A', 'B'], confirmIds: ['A'] });
    expect(onResult).toHaveBeenCalledWith(true, undefined, expect.any(String), 2);
  });

  it('메일만 실패하면 「메일 다시 보내기」가 확정을 되풀이하지 않고 메일만 다시 보낸다', async () => {
    useRoutes({ mailFailOnce: true });
    const user = userEvent.setup();
    renderModal();
    await screen.findByRole('radio', { name: /준비본 사용/ });
    await user.click(await screen.findByRole('button', { name: '미리보기' }));
    await user.click(await screen.findByRole('checkbox', { name: /빈 칸이 있는/ }));
    await user.click(screen.getByRole('button', { name: '발주확인하고 발송' }));
    await user.click(await screen.findByRole('button', { name: '메일 다시 보내기' }));
    expect(await screen.findByText(/발송 완료/)).toBeInTheDocument();
    expect(callsTo('/purchase-order', 'POST')).toHaveLength(1);
    expect(callsTo('/send-email', 'POST')).toHaveLength(2);
  });
});

describe('PoReadyLine — 카드의 준비됨 줄', () => {
  it('준비본 가능 + 발주 대기 > 0 일 때만 그린다', () => {
    const asOfIso = new Date().toISOString();
    const { rerender } = render(<PoReadyLine preparedPo={{ asOfIso }} pendingCount={3} />);
    expect(screen.getByTestId('po-ready-line')).toHaveTextContent('발주서 준비됨 · 발주 대기 3건');
    rerender(<PoReadyLine preparedPo={null} pendingCount={3} />);
    expect(screen.queryByTestId('po-ready-line')).toBeNull();
    rerender(<PoReadyLine preparedPo={{ asOfIso }} pendingCount={0} />);
    expect(screen.queryByTestId('po-ready-line')).toBeNull();
  });
});
