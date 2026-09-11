import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 본문 조회 방식 계약 — 1통씩이 아니라 UID 묶음으로 받는다(2026-09-11 실측: 33통 61초 → 4.4초).
 *
 * IMAP 서버는 가짜로 세우되 `node-imap` 의 UID 인자 처리(인자마다 `parseInt`)를 그대로
 * 흉내 낸다 — 쉼표로 이은 문자열을 넘기면 실서버처럼 첫 번호 하나만 돌아오게 해서, 그
 * 회귀가 「일부 메일이 조용히 빠짐」으로 이 테스트에 드러나게 한다.
 */

interface FakeMail {
  uid: number;
  date: Date;
}

const state = {
  mailbox: [] as FakeMail[],
  /** 헤더 조회 뒤 본문 조회 전에 사라지는 메일 */
  vanished: new Set<number>(),
  bodySearches: [] as unknown[][],
};

function rawMime(uid: number): string {
  return `Subject: [전자세금계산서] ${uid}\r\nFrom: bill@example.com\r\n\r\nbody ${uid}`;
}

vi.mock("@/lib/mail-config", () => ({
  resolveMailCredentials: () => ({ user: "user", pass: "pass" }),
  resolveImapConfig: () => ({}),
}));

vi.mock("imap-simple", () => ({
  default: {
    connect: vi.fn(async () => ({
      getBoxes: async () => ({ 세금계산서: {} }),
      imap: {
        openBox: (_name: string, _readOnly: boolean, cb: (error: Error | null) => void) => cb(null),
      },
      end: () => {},
      search: async (criteria: unknown[][]) => {
        const [key, ...args] = criteria[0] as [string, ...unknown[]];
        if (key === "SINCE") {
          return state.mailbox.map((mail) => ({
            attributes: { uid: mail.uid, date: mail.date },
            parts: [
              {
                which: "HEADER",
                body: { subject: [`[전자세금계산서] ${mail.uid}`], from: ["bill@example.com"] },
              },
            ],
          }));
        }
        state.bodySearches.push(args);
        // node-imap 과 같은 해석 — 인자마다 parseInt. "3,1,2" 는 3 하나가 된다.
        const wanted = new Set(args.map((arg) => parseInt(String(arg), 10)));
        return state.mailbox
          .filter((mail) => wanted.has(mail.uid) && !state.vanished.has(mail.uid))
          .sort((a, b) => a.uid - b.uid) // 서버는 UID 순으로 준다 — 우리 정렬과 다르다
          .map((mail) => ({
            attributes: { uid: mail.uid },
            parts: [{ which: "", body: rawMime(mail.uid) }],
          }));
      },
    })),
  },
}));

const { scanTaxInvoiceMails, chunkUids } = await import("./mail-scan");

/** uid 1..count, 날짜는 uid 와 **반대 순서**(큰 uid 가 오래된 메일) — 정렬 기준을 가르기 위해. */
function seedMailbox(count: number) {
  const base = Date.UTC(2026, 8, 11);
  state.mailbox = Array.from({ length: count }, (_, index) => ({
    uid: index + 1,
    date: new Date(base - (index + 1) * 60_000),
  }));
}

beforeEach(() => {
  state.mailbox = [];
  state.vanished = new Set();
  state.bodySearches = [];
});

describe("본문 묶음 조회", () => {
  it("후보를 1통씩이 아니라 50통 묶음으로 요청하고, 전부 받는다", async () => {
    seedMailbox(120);

    const result = await scanTaxInvoiceMails({ invoicePassword: "0000000000" });

    expect(state.bodySearches.map((args) => args.length)).toEqual([50, 50, 20]);
    expect(result.mails).toHaveLength(120);
    expect(result.truncated).toBe(0);
  });

  it("UID 는 숫자 배열로 넘긴다 — 쉼표 문자열은 첫 번호만 읽힌다", async () => {
    seedMailbox(3);

    await scanTaxInvoiceMails({ invoicePassword: "0000000000" });

    for (const args of state.bodySearches) {
      for (const arg of args) expect(typeof arg).toBe("number");
    }
  });

  it("결과는 서버의 UID 순이 아니라 최신순이다(중복 승인번호 판정이 이 순서를 쓴다)", async () => {
    seedMailbox(4); // uid 1 이 가장 최근

    const result = await scanTaxInvoiceMails({ invoicePassword: "0000000000" });

    expect(result.mails.map((mail) => mail.uid)).toEqual([1, 2, 3, 4]);
  });

  it("헤더 조회 뒤 사라진 메일은 오류 없이 건너뛴다", async () => {
    seedMailbox(3);
    state.vanished.add(2);

    const result = await scanTaxInvoiceMails({ invoicePassword: "0000000000" });

    expect(result.mails.map((mail) => mail.uid)).toEqual([1, 3]);
  });

  it("상한을 넘는 후보는 본문을 요청하지 않고 truncated 로 보고한다", async () => {
    seedMailbox(5);

    const result = await scanTaxInvoiceMails({ invoicePassword: "0000000000", maxMessages: 3 });

    expect(state.bodySearches.flat()).toEqual([1, 2, 3]);
    expect(result.truncated).toBe(2);
  });
});

describe("chunkUids", () => {
  it("크기대로 자르고 마지막 묶음은 나머지다", () => {
    expect(chunkUids([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("빈 목록이면 요청하지 않는다", () => {
    expect(chunkUids([])).toEqual([]);
  });
});
