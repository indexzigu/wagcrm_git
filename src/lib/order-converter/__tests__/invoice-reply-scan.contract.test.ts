import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * 송장 회신 감지 크론의 소스 계약 — 단위 테스트가 못 덮는 **미래의 코드**까지 막는다.
 *
 * ① 메일함 무흔적: 크론 본체에 쓰기 계열 IMAP 호출·`markSeen:true`·read-write openBox 가 없다.
 *    선례인 수동 버튼(`fetch-emails`)은 `\Seen` 을 찍으므로, 그 코드를 복사해 오는 것이 가장
 *    그럴듯한 회귀 경로다(세금계산서 스캔 계약 `mail-scan.contract.test.ts` 와 같은 이유).
 * ② 감지만: 네이버·발송·작업기록 경로를 import 하지 않는다(1단계 = 네이버 요청 0건).
 * ③ 매칭 SSOT: 수동 버튼과 크론이 `invoice-reply-match.ts` 를 함께 쓰고, 규칙 사본이 없다.
 *
 * 주석은 걷어내고 본다 — 금지 심볼을 **설명하려고** 인용한 주석이 자기 자신을 위반으로 잡는다.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const SCAN = 'src/lib/order-converter/invoice-reply-scan.ts';
const ROUTE = 'src/app/api/cron/scan-invoice-replies/route.ts';
const MATCH = 'src/lib/order-converter/invoice-reply-match.ts';
const MANUAL = 'src/app/order-converter/api/fetch-emails/route.ts';

/**
 * 메일함에 흔적을 남기는 IMAP 호출(메서드 호출 꼴)과 `markSeen:true` 를 찾는다.
 * node-imap·imap-simple 의 쓰기 계열 전부 — 플래그·키워드·라벨(구글)·복사·이동·추가·삭제·영구삭제.
 * ⚠️ 이 목록을 줄이면 계약이 조용히 약해진다. 아래 양성 프로브가 **이 함수 자체**를 나쁜 입력에
 * 돌려 탐지가 살아 있는지 본다(프로브가 스캐너를 다시 구현하면 스캐너가 죽어도 초록이다).
 */
const IMAP_WRITE_METHODS = [
  'addFlags',
  'delFlags',
  'setFlags',
  'addKeywords',
  'delKeywords',
  'setKeywords',
  'addLabels',
  'delLabels',
  'setLabels',
  'copy',
  'move',
  'moveMessage',
  'append',
  'deleteMessage',
  'expunge',
] as const;

function findMailboxWrites(source: string): string[] {
  const found = new Set<string>();
  const callRe = new RegExp(`\\.\\s*(${IMAP_WRITE_METHODS.join('|')})\\s*\\(`, 'g');
  for (const m of source.matchAll(callRe)) found.add(m[1]);
  if (/markSeen\s*:\s*true/.test(source)) found.add('markSeen:true');
  return [...found].sort();
}

describe('① 메일함 무흔적(크론)', () => {
  const src = strip(read(SCAN));

  it('양성 대조군 — 스캔 대상 문자열이 실제로 있다(스캐너 고장 감지)', () => {
    expect(src).toContain('openBox');
    expect(src).toContain('connection.search(');
    expect(src.length).toBeGreaterThan(1000);
  });

  it('모든 검색이 SSOT 헤더 옵션(markSeen:false)을 쓰고, 본문은 PEEK 경로(fetchBodiesByUid)로만 받는다', () => {
    const searches = src.match(/connection\.search\(/g) ?? [];
    const withSsotOptions = src.match(/connection\.search\([^;]*?,\s*replyHeaderFetchOptions\(\)\)/g) ?? [];
    expect(searches.length).toBeGreaterThan(0);
    expect(withSsotOptions.length).toBe(searches.length);
    expect(src).toContain('fetchBodiesByUid(');
  });

  it('양성 프로브 — 실제 탐지 함수가 나쁜 입력을 전부 잡고, 깨끗한 입력은 통과시킨다', () => {
    const bad = [
      "connection.addFlags(uid, ['\\\\Seen']);",
      'connection.imap.addKeywords(uid, "k", cb);',
      'connection.imap.setLabels(uid, ["x"], cb);',
      'connection.imap.copy(uid, "Box", cb);',
      'connection.imap.move(uid, "Box", cb);',
      'connection.append(raw, { mailbox: "Box" });',
      'connection.moveMessage(uid, "Box");',
      'connection.deleteMessage(uid);',
      'connection.imap.expunge(cb);',
      'connection.search(c, { bodies: [""], markSeen: true });',
    ].join('\n');
    expect(findMailboxWrites(bad)).toEqual(
      ['addFlags', 'addKeywords', 'append', 'copy', 'deleteMessage', 'expunge', 'markSeen:true', 'move', 'moveMessage', 'setLabels'].sort(),
    );
    expect(findMailboxWrites('connection.imap.openBox(boxName, true, cb); connection.search(c, { markSeen: false });')).toEqual([]);
  });

  it('쓰기 계열 IMAP 호출이 없다(크론 본체·매칭 SSOT·라우트)', () => {
    for (const path of [SCAN, MATCH, ROUTE]) {
      expect({ path, writes: findMailboxWrites(strip(read(path))) }).toEqual({ path, writes: [] });
    }
  });

  it('markSeen:true 가 없다', () => {
    expect(src).not.toMatch(/markSeen:\s*true/);
  });

  it('편지함은 readOnly=true 로만 연다 — imap-simple 의 read-write openBox 를 부르지 않는다', () => {
    expect(src).toMatch(/connection\.imap\.openBox\(\s*boxName,\s*true/);
    expect(src).not.toMatch(/connection\.openBox\(/);
  });

  it('헤더 조회 옵션의 SSOT 도 markSeen:false 다', () => {
    const match = strip(read(MATCH));
    expect(match).toMatch(/markSeen:\s*false/);
    expect(match).not.toMatch(/markSeen:\s*true/);
    expect(match).not.toMatch(/addFlags|moveMessage|deleteMessage/);
  });
});

describe('② 감지만 — 네이버·발송·작업기록 경로를 타지 않는다', () => {
  for (const path of [SCAN, ROUTE]) {
    it(`${path}`, () => {
      const src = strip(read(path));
      expect(src.length).toBeGreaterThan(200); // 앵커
      for (const forbidden of [
        'naver-commerce',
        'naver-order-sync',
        'naver-dispatch',
        'fetch-client',
        'proxyFetch',
        'apiRequest',
        'nodemailer',
        'send-email',
        'orderActionLog.create',
        'action-log',
        'stampPoRequested',
      ]) {
        expect({ path, forbidden, found: src.includes(forbidden) }).toEqual({ path, forbidden, found: false });
      }
    });
  }

  it('크론 본체가 쓰는 테이블은 감지 기록 하나다', () => {
    const src = strip(read(SCAN));
    const writes = [...src.matchAll(/db\.(\w+)\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(/g)].map(
      (m) => `${m[1]}.${m[2]}`,
    );
    expect(writes).toEqual(['invoiceReplyDetection.create']);
  });
});

describe('③ 매칭 규칙 SSOT — 수동 버튼과 크론이 같은 모듈을 쓴다', () => {
  it('두 소비처가 invoice-reply-match 의 판정 함수를 부른다', () => {
    for (const path of [MANUAL, SCAN]) {
      const src = strip(read(path));
      expect(src).toMatch(/from ['"](?:@\/lib\/order-converter|\.)\/invoice-reply-match['"]/);
      expect(src).toContain('isReplyHeaderCandidate(');
      expect(src).toContain('pickReplyAttachment(');
      expect(src).toContain('buildReplyMatchCriteria(');
    }
  });

  it('소비처에 규칙 사본(회사명 점수·태그 리터럴·정규화 비교)이 없다', () => {
    for (const path of [MANUAL, SCAN]) {
      const src = strip(read(path));
      for (const forbidden of ['와이그라운드', '[YGRD-REF:', 'normalizeForCompare', 'isOwnSenderAddress', 'extractTrackingMapByReply']) {
        expect({ path, forbidden, found: src.includes(forbidden) }).toEqual({ path, forbidden, found: false });
      }
    }
    // 양성 대조군 — 규칙은 SSOT 에 실제로 있다.
    const match = strip(read(MATCH));
    for (const needle of ['와이그라운드', 'normalizeForCompare', 'isOwnSenderAddress', 'extractTrackingMapByReply']) {
      expect(match).toContain(needle);
    }
  });

  it('발주 요청일 규칙(sentDates)도 화면과 크론이 같은 함수를 쓴다', () => {
    const dashboard = strip(read('src/components/crm/order-dashboard.tsx'));
    expect(dashboard).toContain('deriveReplySentDates(campaign.tasks)');
    expect(dashboard).not.toContain("t.status === 'EMAILED' || t.status === 'PENDING'");
    expect(strip(read(SCAN))).toContain('deriveReplySentDates(');
  });
});

describe('④ 표시 — 「처리됨」은 이행 상태에서 파생한다', () => {
  it('campaigns-handler 가 판정 SSOT 로 invoiceReply 를 싣는다', () => {
    const src = strip(read('src/app/order-converter/api/campaigns/campaigns-handler.ts'));
    expect(src).toContain('invoiceReply: resolveInvoiceReplyStatus(');
    expect(src).toContain('prisma.invoiceReplyDetection.findMany(');
  });

  it('주문 관리 카드가 그 값을 그린다', () => {
    const src = strip(read('src/components/crm/order-dashboard.tsx'));
    expect(src).toContain('<InvoiceReplyLine reply={(camp as CampaignPayload).invoiceReply} />');
  });
});
