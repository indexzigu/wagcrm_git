/**
 * 대금(입금·지급) 일정 이벤트의 **메모 본문 조립** — 금액과 지급 계좌 줄.
 *
 * 구글 캘린더의 대금 이벤트는 오너가 이체할 때 실제로 여는 화면이다. 그런데 종전
 * 메모에는 상대와 예정/실제 구분만 있고 **금액도 계좌도 없어서**, 이체 한 번에 CRM 을
 * 다시 열어야 했다(오너 요청 2026-08-25). 이 모듈이 그 두 줄을 만든다.
 *
 * ⛔ **채널 분기를 여기에 쓰지 말 것** — 어느 슬롯이 존재하고 상대가 누구인지는 전부
 * `resolveCampaignMoneySlots`(슬롯 SSOT)가 정한다. 이 함수는 슬롯 하나를 받아 줄을
 * 만들 뿐이고, 동사("입금"/"지급")도 `slot.verb` 를 그대로 쓴다(`kind === "DEPOSIT" ?
 * ... : ...` 삼항을 다시 만들지 않는다).
 *
 * ⚠️ **계좌는 지급 슬롯에만 붙인다.** 입금은 우리가 받는 쪽이라 이벤트에 적을 상대
 * 계좌라는 것이 존재하지 않는다(적어야 할 것이 있다면 그건 우리 계좌이고, 그건 상대가
 * 알아야 할 정보이지 이 캘린더가 나르는 정보가 아니다).
 *
 * ⚠️ **계좌번호는 평문으로 구글 서버에 올라간다.** 이 표면을 여는 것은 오너 확정이다
 * (2026-08-25, 대금 이벤트가 사는 회계·정산 캘린더 기준으로 「전체 표기」 선택). 셀러
 * 주민등록번호와 달리 계좌는 `resident-number-exposure.contract.test.ts` 의 스캔 대상이
 * 아니므로 기계 가드가 없다 — **새 표면에 계좌를 실을 때는 이 문단을 근거로 삼지 말고
 * 그 표면의 공유 범위를 따로 확인할 것.**
 */
import { formatCurrency } from "./format";
import type { CampaignMoneySlot } from "./tax-filing-board";

/** 지급 상대의 계좌 한 건. */
export type MoneyPayoutAccount = {
  /**
   * 예금주 표기. 셀러 지급은 이벤트 메모 위쪽 「셀러:」 줄이 이미 상대를 말하므로
   * `null` 로 넘겨 중복을 피한다. 공급사는 조합 캠페인에서 여럿일 수 있어 이름이
   * 곧 식별 수단이다.
   */
  holder: string | null;
  account: string;
};

export type MoneyNoteInput = {
  slot: CampaignMoneySlot;
  /**
   * ⛔ **`null` 은 0 이 아니라 「모름」이다.** 자사몰 공급사 지급 레그에는 대응하는 정산
   * 스칼라가 없다 — 캘린더가 읽는 두 컬럼은 각각 **입금 축**(`settlementSales` = 영업
   * 수익)과 **셀러 지급 축**(`actualPayoutAmount`)이라 어느 쪽도 공급사 지급액이 아니다.
   * 금전 대조에 쓰이는 메모에서 「0원」은 **확인된 0** 으로 읽히므로 접지 않는다.
   */
  amount: number | null;
  /** 지급 상대의 계좌들(입금 슬롯이면 무시된다). 빈 배열이면 「미등록」으로 적는다. */
  accounts: MoneyPayoutAccount[];
};

/** 값이 실제로 들어 있는 계좌만 남기고 같은 계좌를 접는다(조합은 멤버마다 딜이 달라 중복이 흔하다). */
function usableAccounts(accounts: MoneyPayoutAccount[]): MoneyPayoutAccount[] {
  const seen = new Set<string>();
  const result: MoneyPayoutAccount[] = [];
  for (const entry of accounts) {
    const account = entry.account?.trim();
    if (!account) continue;
    const holder = entry.holder?.trim() || null;
    // ⛔ `${holder} ${account}` 로 이어 붙이지 말 것 — 경계가 다른 두 계좌가 같은 키가 된다
    // (「가」+「나 다」 와 「가 나」+「다」). 접히면 공급사 한 곳의 계좌 줄이 통째로 사라지는데,
    // 그건 이 모듈이 「전부 나열」 규칙으로 막으려는 사고 그 자체다.
    const dedupKey = JSON.stringify([holder, account]);
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    result.push({ holder, account });
  }
  return result;
}

/** 계좌 한 건의 표기 — 예금주가 있으면 앞에 병기한다. */
function accountText(entry: MoneyPayoutAccount): string {
  return entry.holder ? `${entry.holder} ${entry.account}` : entry.account;
}

/**
 * 대금 이벤트 메모에 덧붙일 줄들. 금액 줄은 항상 나오고, 계좌 줄은 지급 슬롯에만 나온다.
 */
export function buildMoneyNoteLines({ slot, amount, accounts }: MoneyNoteInput): string[] {
  const lines = [
    `${slot.verb} 금액: ${amount == null ? "미정" : `₩${formatCurrency(amount)}`}`,
  ];

  if (slot.kind !== "PAYOUT") return lines;

  const usable = usableAccounts(accounts);
  if (usable.length === 0) {
    lines.push(`${slot.verb} 계좌: 미등록`);
  } else if (usable.length === 1) {
    lines.push(`${slot.verb} 계좌: ${accountText(usable[0])}`);
  } else {
    // 조합 캠페인은 멤버 딜이 갈리면 공급사도 갈린다. 하나를 골라 적으면 나머지 상대에게
    // 그 계좌로 보내는 사고가 나므로 전부 적고 오너가 고르게 한다.
    lines.push(`${slot.verb} 계좌:`);
    for (const entry of usable) {
      lines.push(`- ${entry.holder ?? "예금주 미상"}: ${entry.account}`);
    }
  }
  return lines;
}
