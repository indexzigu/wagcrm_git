import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * 본문 조회 방식 계약(T-158) — 후보 메일을 1통씩이 아니라 UID 묶음으로 받는다.
 * `mail-scan.ts` 의 `chunkUids` 를 재사용한 것과 같은 회귀를 잡는다
 * (`mail-scan.fetch.test.ts` 와 같은 형태 — 가짜 IMAP 서버가 UID 검색 인자를 기록한다).
 */

interface FakeMail {
  uid: number;
  from: string;
  date: Date;
}

const state = {
  mailbox: [] as FakeMail[],
  bodySearches: [] as unknown[][],
};

function rawMime(uid: number, from: string): string {
  return `Subject: 발주 회신 ${uid}\r\nFrom: ${from}\r\n\r\nbody ${uid}`;
}

vi.mock('@/lib/mail-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mail-config')>();
  return {
    ...actual,
    resolveMailCredentials: () => ({ user: 'me@example.com', password: 'pw' }),
    resolveImapConfig: () => ({}),
  };
});

// 브랜드 조회는 Prisma 를 타므로 무조건 null(도메인 화이트리스트 없음)로 고정한다 —
// 이 테스트가 보는 것은 본문 조회 방식이지 브랜드 판정이 아니다.
vi.mock('@/lib/order-converter/order-brand', () => ({
  resolveOrderBrand: async () => null,
  resolveReplyRule: () => ({}),
}));

vi.mock('imap-simple', () => ({
  default: {
    connect: vi.fn(async () => ({
      getBoxes: async () => ({ INBOX: {} }),
      openBox: async () => ({ messages: { total: state.mailbox.length } }),
      addFlags: vi.fn(async () => {}),
      end: vi.fn(),
      search: async (criteria: unknown[][]) => {
        const first = criteria[0] as [string, ...unknown[]];
        if (first[0] === 'UID') {
          const uids = first.slice(1) as number[];
          state.bodySearches.push(uids);
          return state.mailbox
            .filter((mail) => uids.includes(mail.uid))
            .map((mail) => ({
              attributes: { uid: mail.uid },
              parts: [{ which: '', body: rawMime(mail.uid, mail.from) }],
            }));
        }
        if (criteria.length === 2) {
          // 태그([YGRD-REF:...]) 검색 — 이 테스트는 태그 매칭을 쓰지 않는다.
          return [];
        }
        // 제목/발신자 헤더 검색
        return state.mailbox.map((mail) => ({
          attributes: { uid: mail.uid, date: mail.date },
          parts: [
            {
              which: 'HEADER',
              body: { subject: [`발주 회신 ${mail.uid}`], from: [mail.from] },
            },
          ],
        }));
      },
    })),
  },
}));

import { POST } from './route';

function seedMailbox(count: number) {
  const base = Date.UTC(2026, 8, 11);
  state.mailbox = Array.from({ length: count }, (_, index) => ({
    uid: index + 1,
    from: 'partner@brand.example.com',
    date: new Date(base - (index + 1) * 60_000),
  }));
}

function makeRequest(body: unknown) {
  return new NextRequest('http://localhost:3000/order-converter/api/fetch-emails', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  state.mailbox = [];
  state.bodySearches = [];
});

describe('fetch-emails 본문 조회', () => {
  it('후보 다수를 1통씩이 아니라 UID 묶음으로 요청한다', async () => {
    seedMailbox(55);

    await POST(makeRequest({ template: 'brand', sellerName: '테스트셀러' }));

    // 55통을 1통씩 요청했다면 항목 55개가 남는다 — 묶음이면 50/5 두 번뿐이다.
    expect(state.bodySearches.map((args) => (args as unknown[]).length)).toEqual([50, 5]);
  });

  it('UID 는 숫자 배열로 넘긴다 — 쉼표 문자열은 서버에서 첫 번호만 읽힌다', async () => {
    seedMailbox(3);

    await POST(makeRequest({ template: 'brand', sellerName: '테스트셀러' }));

    for (const args of state.bodySearches) {
      for (const arg of args as unknown[]) expect(typeof arg).toBe('number');
    }
  });
});
