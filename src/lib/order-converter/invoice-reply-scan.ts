/**
 * 송장 회신 도착 감지 — 크론 `scan-invoice-replies` 의 본체(발주 자동화 1단계 B, 오너 승인 2026-10-06).
 *
 * 하는 일: 발주요청은 했는데 송장 등록이 덜 끝난 주문캠페인마다, 메일함에서 브랜드사의 송장 회신이
 * 왔는지 **보기만** 하고 `InvoiceReplyDetection` 에 한 줄 남긴다. 운영자는 주문 관리 카드의
 * 「송장 회신 도착 · 주문 N건 · HH:MM」 줄로 알게 되고, 실제 처리는 여전히 「송장회신」 버튼으로 한다.
 *
 * ## ⛔ 하지 않는 것 (1단계 범위 — 전부 오너 확인이 필요한 쓰기다)
 *
 * - 송장 등록 · 네이버 발송처리 · 네이버 호출 일체(Fixie 요청 0건이 이 단계의 조건이다)
 * - `OrderActionLog` 쓰기(그 장부는 운영자의 버튼 조작 기록이다)
 * - 메일 발송
 *
 * ## ⚠️ 운영 메일함이다 — 읽기 외의 어떤 흔적도 남기지 않는다
 *
 * - 편지함은 **`readOnly=true`(EXAMINE)** 로 연다. `imap-simple` 의 `openBox` 는 항상 read-write
 *   (SELECT)라 하위 `connection.imap.openBox(name, true, cb)` 를 직접 쓴다(세금계산서 스캔 선례).
 * - 모든 조회는 `markSeen: false` → node-imap 이 `BODY.PEEK[...]` 로 요청한다(읽음 표시 없음).
 * - ⛔ `addFlags`·`moveMessage`·`deleteMessage` 를 **부르지 않는다.** 수동 버튼
 *   (`order-converter/api/fetch-emails`)은 찾은 회신에 `\Seen` 을 찍는다 — 그 코드를 여기로
 *   복사하지 말 것. 운영자가 메일함에서 「안 읽은 회신」을 보고 일하는데 크론이 매시간 그 표시를
 *   지우면 사람 쪽 신호가 사라진다. 계약은 `invoice-reply-scan.contract.test.ts`.
 *
 * ## 매칭 규칙은 수동 버튼과 같은 SSOT 를 쓴다
 *
 * 「이 메일이 이 캠페인의 회신인가」는 `invoice-reply-match.ts` 하나가 판정한다(REF 태그 · 제목 ·
 * 발신 도메인 · 셀러명 첨부 · 브랜드 회신 규칙). 다른 점은 **비용 구조**뿐이다 — 캠페인마다
 * 로그인하지 않고 한 세션에서 편지함·헤더 목록을 한 번 받아 모든 대상 캠페인에 재사용한다.
 *   ℹ️ 서버 태그 검색만 캠페인별이 아니라 `[YGRD-REF:` 공통 접두로 **편지함당 1회** 한다. 결과는
 *   같다: 다른 캠페인 태그가 든 메일은 본문 단계(`pickReplyAttachment` 의 `other-campaign`)에서
 *   똑같이 걸러진다. 달라지는 것은 그런 메일의 본문을 한 번 받아 본다는 것뿐이다(UID 묶음 1회).
 *
 * ## 로그 위생 (P0 — 공개 레포 · 운영 로그)
 *
 * 메일 주소 · 제목 · 송장번호 · 셀러명을 로그에도 응답에도 싣지 않는다. 남기는 것은 개수와
 * 캠페인 id 뿐이다.
 */

import imaps, { type ImapSimple } from 'imap-simple';
import { resolveImapConfig, resolveMailCredentials } from '@/lib/mail-config';
import { fetchBodiesByUid } from '@/lib/tax-invoice-mail/mail-scan';
import { resolveOrderBrand, type OrderBrand } from './order-brand';
import {
  buildReplyMatchCriteria,
  isReplyHeaderCandidate,
  listReplyMailboxes,
  parseMailBody,
  parseReplyTracking,
  pickReplyAttachment,
  readReplyHeader,
  replyHeaderFetchOptions,
  replyHeaderSearchCriteria,
  replyAnyTagSearchCriteria,
  replyScanSince,
  type ReplyHeader,
  type ReplyMatchCriteria,
} from './invoice-reply-match';
import { deriveReplySentDates } from './invoice-reply-status';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 대상 선정 창(일) — 이 기간 안에 발주요청이 나간 캠페인만 본다. 메일 조회 창(7일)보다 넓은 것은
 * 「8일 전 발주 → 2일 전 회신」을 놓치지 않기 위해서다(메일은 여전히 최근 7일만 본다).
 */
export const TARGET_PO_LOOKBACK_DAYS = 14;

/**
 * 한 회차에 보는 캠페인 상한. 평시 동시 진행 발주는 이보다 훨씬 적다 — 데이터 결함(대량 임포트 등)이
 * 매시간 폭주로 번지는 것을 막는 방벽이다. 걸려 빠진 수는 응답에 남긴다(조용한 절단 금지).
 */
export const MAX_CAMPAIGNS_PER_RUN = 30;

/**
 * 한 회차에 본문을 받아 보는 메일 상한(편지함 합계). 브랜드사 도메인 설정이 빈 캠페인은 도메인
 * 조건이 꺼져 거의 모든 메일이 후보가 되므로(수동 버튼과 같은 규칙), 매시간 메일함 전체를 받지
 * 않게 막는다. 걸리면 `bodyCapHit` 로 알린다.
 */
export const MAX_BODY_FETCH_PER_RUN = 200;

/**
 * 한 회차의 메일 서버 작업 마감(접속 + 스캔). 소켓이 조용히 끊기면 node-imap 의 대기 중 요청은
 * 영영 안 끝날 수 있다 — 그러면 요청이 매달린 채 레이더에는 RUNNING 만 남는다. 러너
 * (`run-cron.sh`)의 클라이언트 제한 15분보다 **짧게** 잡아 이 라우트가 스스로 ERROR 를 기록하게 한다.
 */
export const RUN_DEADLINE_MS = 8 * 60 * 1000;

/** 크론이 쓰는 DB 표면 — 테스트가 이 모양만 흉내 내면 된다. */
export interface InvoiceReplyScanDb {
  orderFulfillmentState: {
    groupBy: (args: any) => Promise<any[]>;
  };
  orderActionLog: {
    findMany: (args: any) => Promise<any[]>;
  };
  orderCampaign: {
    findMany: (args: any) => Promise<any[]>;
  };
  invoiceReplyDetection: {
    findUnique: (args: any) => Promise<any | null>;
    create: (args: any) => Promise<unknown>;
  };
}

export interface InvoiceReplyTarget {
  orderCampaignId: string;
  template: string | null;
  sellerName: string;
  toEmail: string | null;
  sentDates: string[];
  /** 대상 선정 근거 — 마지막 발주요청 시각. 상한 정렬(최신 우선)에 쓴다. */
  lastPoRequestedAt: Date;
}

export interface TargetSelection {
  targets: InvoiceReplyTarget[];
  /** 창 안에 발주요청이 있었던 캠페인 수. */
  poRequestedCampaigns: number;
  /** 발주요청분이 전부 송장등록된 것으로 보여 뺀 수. */
  skippedRegistered: number;
  /** 마감(비활성) 캠페인이라 뺀 수. */
  skippedInactive: number;
  droppedByCap: number;
}

/**
 * 대상 = 최근 {@link TARGET_PO_LOOKBACK_DAYS}일 안에 발주요청이 나간(`OrderFulfillmentState.poRequestedAt`)
 * **활성** 주문캠페인 중, 송장 등록이 끝났다고 볼 수 없는 것.
 *
 * 「끝났다」= ① 마지막 발주요청 **뒤에** 송장등록 기록이 있고 ② 그 캠페인의 **누적** 송장등록 성공 수가
 * **누적** 발주요청 주문 수 이상이다. 두 쪽을 같은 범위(캠페인 전체 이력)로 센다 — 한쪽만 최근 창으로
 * 세면, 창 밖에서 발주한 옛 주문을 새 주문과 한 파일로 등록했을 때 성공 수가 부풀어 열린 주문이
 * 남았는데도 「끝났다」로 읽힌다(코드 리뷰 지적 2026-10-06). 건너뜀(skip)은 세지 않는다 — 같은
 * 파일을 다시 올리면 이미 발송된 주문이 또 건너뜀으로 잡혀 이중으로 세어진다.
 *
 * ⚠️ 「송장 등록 완료」를 DB 만으로 근사한다 — 정확한 판정(주문별 네이버 상태)은 스냅샷 블롭을
 * 읽어야 하는데, 매시간 도는 크론이 그것을 끌고 오지 않게 했다(Snapshot Blob Egress Discipline).
 * 근사는 **더 오래 지켜보는 쪽으로만** 틀린다: 판매자센터에서 직접 등록했거나 발주 후 취소된
 * 주문은 등록 기록이 안 남아 창이 끝날 때까지 계속 본다(메일만 읽으니 해가 없다). 반대로
 * 화면 표시의 「처리됨」은 이 근사가 아니라 실제 배송대기 상태에서 파생한다(invoice-reply-status.ts).
 */
export async function selectInvoiceReplyTargets(
  db: InvoiceReplyScanDb,
  now: Date,
  options: { maxCampaigns?: number } = {},
): Promise<TargetSelection> {
  const maxCampaigns = options.maxCampaigns ?? MAX_CAMPAIGNS_PER_RUN;
  const since = new Date(now.getTime() - TARGET_PO_LOOKBACK_DAYS * DAY_MS);

  const poGroups: Array<{
    campaignId: string | null;
    _count: { _all: number };
    _min: { poRequestedAt: Date | null };
    _max: { poRequestedAt: Date | null };
  }> = await db.orderFulfillmentState.groupBy({
    by: ['campaignId'],
    where: { campaignId: { not: null }, poRequestedAt: { gte: since } },
    _count: { _all: true },
    _min: { poRequestedAt: true },
    _max: { poRequestedAt: true },
  });

  const requested = new Map<string, { count: number; first: Date; last: Date }>();
  for (const group of poGroups) {
    if (!group.campaignId || !group._min.poRequestedAt || !group._max.poRequestedAt) continue;
    requested.set(group.campaignId, {
      count: group._count._all,
      first: group._min.poRequestedAt,
      last: group._max.poRequestedAt,
    });
  }
  const ids = [...requested.keys()];
  if (ids.length === 0) {
    return { targets: [], poRequestedCampaigns: 0, skippedRegistered: 0, skippedInactive: 0, droppedByCap: 0 };
  }

  // 같은 범위로 센다(위 주석) — 누적 발주요청 주문 수 · 누적 송장등록 성공 수 · 마지막 등록 시각.
  const totalGroups: Array<{ campaignId: string | null; _count: { _all: number } }> =
    await db.orderFulfillmentState.groupBy({
      by: ['campaignId'],
      where: { campaignId: { in: ids }, poRequestedAt: { not: null } },
      _count: { _all: true },
    });
  const totalRequested = new Map<string, number>();
  for (const group of totalGroups) {
    if (group.campaignId) totalRequested.set(group.campaignId, group._count._all);
  }

  const registrations: Array<{ campaignId: string | null; createdAt: Date; successCount: number }> =
    await db.orderActionLog.findMany({
      where: { action: 'REGISTER_INVOICE', campaignId: { in: ids } },
      select: { campaignId: true, createdAt: true, successCount: true },
    });
  const registeredTotal = new Map<string, number>();
  const lastRegisteredAt = new Map<string, number>();
  for (const row of registrations) {
    if (!row.campaignId) continue;
    registeredTotal.set(row.campaignId, (registeredTotal.get(row.campaignId) ?? 0) + row.successCount);
    const at = row.createdAt.getTime();
    if (at > (lastRegisteredAt.get(row.campaignId) ?? -Infinity)) lastRegisteredAt.set(row.campaignId, at);
  }

  let skippedRegistered = 0;
  const openIds: string[] = [];
  for (const id of ids) {
    const window = requested.get(id)!;
    const registeredAfterLastPo = (lastRegisteredAt.get(id) ?? -Infinity) >= window.last.getTime();
    const allRegistered = (registeredTotal.get(id) ?? 0) >= (totalRequested.get(id) ?? window.count);
    if (registeredAfterLastPo && allRegistered) {
      skippedRegistered += 1;
      continue;
    }
    openIds.push(id);
  }

  const campaigns: Array<{
    id: string;
    isActive: boolean;
    template: string | null;
    sellerName: string;
    toEmail: string | null;
    tasks: Array<{ date: string; status: string }>;
  }> = openIds.length
    ? await db.orderCampaign.findMany({
        where: { id: { in: openIds } },
        select: {
          id: true,
          isActive: true,
          template: true,
          sellerName: true,
          toEmail: true,
          // 수동 버튼이 받는 것과 같은 범위(campaigns-handler 의 최근 5일 태스크).
          tasks: { orderBy: { date: 'desc' }, take: 5, select: { date: true, status: true } },
        },
      })
    : [];

  let skippedInactive = 0;
  const eligible: InvoiceReplyTarget[] = [];
  for (const campaign of campaigns) {
    if (!campaign.isActive) {
      skippedInactive += 1;
      continue;
    }
    eligible.push({
      orderCampaignId: campaign.id,
      template: campaign.template,
      sellerName: campaign.sellerName,
      toEmail: campaign.toEmail,
      sentDates: deriveReplySentDates(campaign.tasks, now),
      lastPoRequestedAt: requested.get(campaign.id)!.last,
    });
  }

  // 최근 발주가 먼저 — 상한에 걸려도 지금 기다리는 회신부터 본다.
  eligible.sort((a, b) => b.lastPoRequestedAt.getTime() - a.lastPoRequestedAt.getTime());
  const targets = eligible.slice(0, maxCampaigns);

  return {
    targets,
    poRequestedCampaigns: ids.length,
    skippedRegistered,
    skippedInactive,
    droppedByCap: eligible.length - targets.length,
  };
}

/** 감지 1건 — DB 에 그대로 들어간다. 메일 주소·제목·송장번호는 담지 않는다. */
export interface DetectedInvoiceReply {
  orderCampaignId: string;
  messageId: string;
  mailbox: string;
  uid: number;
  receivedAt: Date;
  parsedTrackingCount: number;
  trackingOrderKeys: string[];
  /** 첨부는 찾았지만 브랜드 회신 규칙으로 못 읽었다(수동 버튼에서도 「송장번호를 찾지 못했습니다」). */
  parseFailed: boolean;
}

export interface MailboxScanResult {
  detections: DetectedInvoiceReply[];
  mailboxesListed: number;
  mailboxesOpened: number;
  headersScanned: number;
  bodiesFetched: number;
  bodyCapHit: boolean;
  /** 열다가 실패한 편지함 수(나머지는 계속 본다 — 수동 버튼과 같은 처분). */
  mailboxErrors: number;
  /** 끝까지 회신을 못 찾은 대상 수. */
  unresolved: number;
}

/**
 * 본문을 받을 UID 차례 — 캠페인을 **번갈아** 가며 각자의 최신 후보부터 하나씩 뽑는다.
 *
 * 🪤 캠페인 순서대로 이어 붙이면, 도메인 조건이 꺼진 캠페인(후보 = 거의 전 메일)이 본문 상한을
 * 혼자 먹어 뒤쪽 캠페인이 **매시간 같은 자리에서** 굶는다(코드 리뷰 지적 2026-10-06). 시작 캠페인은
 * 시(時) 단위로 돌려 상한 경계에 걸리는 캠페인도 회차마다 바뀌게 한다. 각 캠페인은 최신 매칭 1통만
 * 필요하므로 「최신부터 하나씩」이 곧 필요한 순서다.
 */
export function interleaveBodyFetchOrder(candidatesByCampaign: ReadonlyMap<string, readonly ReplyHeader[]>, now: Date): number[] {
  const lists = [...candidatesByCampaign.values()].filter((list) => list.length > 0);
  if (lists.length === 0) return [];
  const offset = Math.floor(now.getTime() / (60 * 60 * 1000)) % lists.length;
  const rotated = [...lists.slice(offset), ...lists.slice(0, offset)];
  const order: number[] = [];
  const seen = new Set<number>();
  const longest = Math.max(...rotated.map((list) => list.length));
  for (let depth = 0; depth < longest; depth++) {
    for (const list of rotated) {
      const header = list[depth];
      if (header && !seen.has(header.uid)) {
        seen.add(header.uid);
        order.push(header.uid);
      }
    }
  }
  return order;
}

/** 저장 키 상한 — 한 회신이 수천 행이어도 행 크기가 폭주하지 않게. */
const MAX_STORED_ORDER_KEYS = 1_000;

/**
 * ★ 편지함을 **읽기 전용**으로 연다(EXAMINE). `imap-simple` 의 `openBox` 는 SELECT 라 쓰지 않는다.
 * 반환값은 편지함 정보(메일 수 등).
 */
export function openMailboxReadOnly(connection: ImapSimple, boxName: string): Promise<{ messages?: { total?: number } }> {
  return new Promise((resolve, reject) => {
    connection.imap.openBox(boxName, true, (err: Error | null, box: unknown) =>
      err ? reject(err) : resolve((box ?? {}) as { messages?: { total?: number } }),
    );
  });
}

/**
 * 한 IMAP 세션으로 대상 캠페인 전부의 최신 회신을 찾는다(읽기 전용).
 *
 * 순회 차례·「첫 발견에서 멈춤」은 수동 버튼과 같다: 편지함은 `orderMailboxesForScan` 차례
 * (받은편지함 → 라벨 → 전체보관함), 편지함 안에서는 최신 메일부터, 캠페인마다 첫 매칭 1통.
 */
export async function scanInvoiceRepliesReadOnly(
  connection: ImapSimple,
  targets: ReadonlyArray<InvoiceReplyTarget & { brand: OrderBrand | null }>,
  options: { loginUser: string; now: Date; maxBodies?: number },
): Promise<MailboxScanResult> {
  const maxBodies = options.maxBodies ?? MAX_BODY_FETCH_PER_RUN;
  const since = replyScanSince(options.now);

  const pending = new Map<string, { target: InvoiceReplyTarget & { brand: OrderBrand | null }; criteria: ReplyMatchCriteria }>();
  for (const target of targets) {
    pending.set(target.orderCampaignId, {
      target,
      criteria: buildReplyMatchCriteria({
        campaignId: target.orderCampaignId,
        brandEmailDomains: target.brand ? target.brand.emailDomains : [],
        toEmail: target.toEmail,
        sellerName: target.sellerName,
        sentDates: target.sentDates,
      }),
    });
  }

  const result: MailboxScanResult = {
    detections: [],
    mailboxesListed: 0,
    mailboxesOpened: 0,
    headersScanned: 0,
    bodiesFetched: 0,
    bodyCapHit: false,
    mailboxErrors: 0,
    unresolved: 0,
  };
  if (pending.size === 0) return result;

  const boxes = await listReplyMailboxes(connection);
  result.mailboxesListed = boxes.length;

  for (const boxName of boxes) {
    if (pending.size === 0) break;
    try {
      const box = await openMailboxReadOnly(connection, boxName);
      result.mailboxesOpened += 1;
      if ((box.messages?.total ?? 0) === 0) continue;

      // 태그 검색은 공통 접두로 편지함당 1회(모듈 머리 주석 참조).
      const tagged = await connection.search(replyAnyTagSearchCriteria(since), replyHeaderFetchOptions());
      const taggedUids = new Set<number>(tagged.map((m: any) => m.attributes.uid));

      const messages = await connection.search(replyHeaderSearchCriteria(since), replyHeaderFetchOptions());
      result.headersScanned += messages.length;
      const headers: ReplyHeader[] = [];
      for (const message of messages) {
        const header = await readReplyHeader(message as any);
        if (header) headers.push(header);
      }
      // 최신 메일부터 — 수동 버튼과 같은 「가장 최근 회신」 규칙.
      headers.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));

      const candidatesByCampaign = new Map<string, ReplyHeader[]>();
      for (const [campaignId, entry] of pending) {
        const list = headers.filter((header) =>
          isReplyHeaderCandidate(header, entry.criteria, {
            loginUser: options.loginUser,
            taggedInImap: taggedUids.has(header.uid),
          }),
        );
        candidatesByCampaign.set(campaignId, list);
      }
      const wanted = interleaveBodyFetchOrder(candidatesByCampaign, options.now);

      const budget = Math.max(0, maxBodies - result.bodiesFetched);
      if (wanted.length > budget) result.bodyCapHit = true;
      const toFetch = wanted.slice(0, budget);
      // markSeen:false — BODY.PEEK[] 로 받는다(`fetchBodiesByUid`).
      const bodyByUid = toFetch.length ? await fetchBodiesByUid(connection, toFetch) : new Map<number, unknown>();
      result.bodiesFetched += toFetch.length;
      const parsedByUid = new Map<number, Awaited<ReturnType<typeof parseMailBody>>>();

      for (const [campaignId, entry] of [...pending]) {
        for (const header of candidatesByCampaign.get(campaignId) ?? []) {
          if (!bodyByUid.has(header.uid)) continue;
          let parsed = parsedByUid.get(header.uid);
          if (!parsed) {
            parsed = await parseMailBody(bodyByUid.get(header.uid));
            parsedByUid.set(header.uid, parsed);
          }
          const verdict = pickReplyAttachment(parsed, entry.criteria);
          if (verdict.kind !== 'match') continue;

          let trackingOrderKeys: string[] = [];
          let parseFailed = false;
          try {
            trackingOrderKeys = Object.keys(parseReplyTracking(verdict.attachment.content, entry.target.brand));
          } catch {
            // 첨부는 왔다 — 감지는 남기되 건수 0 으로. 사유(파일 내용)는 로그에 싣지 않는다.
            parseFailed = true;
          }
          result.detections.push({
            orderCampaignId: campaignId,
            messageId: header.messageId ?? `${boxName}#${header.uid}`,
            mailbox: boxName,
            uid: header.uid,
            receivedAt: header.date ?? options.now,
            parsedTrackingCount: trackingOrderKeys.length,
            trackingOrderKeys: trackingOrderKeys.slice(0, MAX_STORED_ORDER_KEYS),
            parseFailed,
          });
          pending.delete(campaignId);
          break;
        }
      }
    } catch (error) {
      // 한 편지함의 실패가 나머지를 막지 않는다(수동 버튼과 같은 처분). 삼키지 않고 센다 — 전부
      // 실패하면 호출부가 실행 실패로 선언한다. 메시지는 서버 오류 문구뿐이라 주소가 없다.
      result.mailboxErrors += 1;
      console.warn('[scan-invoice-replies] 편지함 조회 실패, 건너뜀:', error instanceof Error ? error.message : String(error));
    }
  }

  result.unresolved = pending.size;
  return result;
}

export interface InvoiceReplyRunSummary {
  failed?: boolean;
  failureReason?: string;
  targets: number;
  poRequestedCampaigns: number;
  skippedRegistered: number;
  skippedInactive: number;
  droppedByCap: number;
  /** 대상이 0이라 메일 서버에 붙지 않았다. */
  skippedNoTargets: boolean;
  mailboxesListed: number;
  mailboxesOpened: number;
  headersScanned: number;
  bodiesFetched: number;
  bodyCapHit: boolean;
  mailboxErrors: number;
  detected: number;
  created: number;
  alreadyKnown: number;
  parseFailed: number;
  unresolved: number;
  writeFailures: number;
  /** 새로 감지된 캠페인 id(개수 확인용). 이름·주소는 싣지 않는다. */
  newDetectionCampaignIds: string[];
}

/** 같은 메일을 다시 감지하면 건너뛴다 — 유니크 키 (주문캠페인, messageId). */
export async function persistInvoiceReplyDetections(
  db: InvoiceReplyScanDb,
  detections: readonly DetectedInvoiceReply[],
): Promise<{ created: number; alreadyKnown: number; writeFailures: number; createdCampaignIds: string[] }> {
  let created = 0;
  let alreadyKnown = 0;
  let writeFailures = 0;
  const createdCampaignIds: string[] = [];
  for (const detection of detections) {
    const key = { orderCampaignId: detection.orderCampaignId, messageId: detection.messageId };
    try {
      const existing = await db.invoiceReplyDetection.findUnique({
        where: { orderCampaignId_messageId: key },
        select: { id: true },
      });
      if (existing) {
        alreadyKnown += 1;
        continue;
      }
      await db.invoiceReplyDetection.create({
        data: {
          ...key,
          mailbox: detection.mailbox,
          uid: detection.uid,
          receivedAt: detection.receivedAt,
          parsedTrackingCount: detection.parsedTrackingCount,
          trackingOrderKeys: detection.trackingOrderKeys.length ? JSON.stringify(detection.trackingOrderKeys) : null,
        },
      });
      created += 1;
      createdCampaignIds.push(detection.orderCampaignId);
    } catch (error) {
      // 동시 실행(수동 실행 버튼 + 스케줄)이 같은 메일을 먼저 넣었다 — 실패가 아니다.
      if ((error as { code?: string })?.code === 'P2002') {
        alreadyKnown += 1;
        continue;
      }
      writeFailures += 1;
      console.warn('[scan-invoice-replies] 감지 기록 실패:', error instanceof Error ? error.message : String(error));
    }
  }
  return { created, alreadyKnown, writeFailures, createdCampaignIds };
}

export interface InvoiceReplyRunDeps {
  db: InvoiceReplyScanDb;
  now?: Date;
  /** 테스트 주입용. 기본은 `imap-simple` 실접속(SSOT 좌표). */
  connect?: () => Promise<ImapSimple>;
  resolveBrand?: (template: string | null) => Promise<OrderBrand | null>;
  /** 테스트 주입용. 기본 {@link RUN_DEADLINE_MS}. */
  deadlineMs?: number;
}

class RunDeadlineError extends Error {
  constructor(ms: number) {
    super(`메일 서버 작업이 ${Math.round(ms / 60_000) || 1}분 안에 끝나지 않아 중단했습니다`);
    this.name = 'RunDeadlineError';
  }
}

class SocketError extends Error {
  constructor(cause: unknown) {
    super(`메일 서버 연결 오류로 중단했습니다: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'SocketError';
  }
}

/**
 * 한 회차 실행. 대상이 없으면 메일 서버에 **붙지 않는다**(매시간 빈 로그인을 만들지 않는다).
 */
export async function runInvoiceReplyScan(deps: InvoiceReplyRunDeps): Promise<InvoiceReplyRunSummary> {
  const now = deps.now ?? new Date();
  const selection = await selectInvoiceReplyTargets(deps.db, now);

  const summary: InvoiceReplyRunSummary = {
    targets: selection.targets.length,
    poRequestedCampaigns: selection.poRequestedCampaigns,
    skippedRegistered: selection.skippedRegistered,
    skippedInactive: selection.skippedInactive,
    droppedByCap: selection.droppedByCap,
    skippedNoTargets: selection.targets.length === 0,
    mailboxesListed: 0,
    mailboxesOpened: 0,
    headersScanned: 0,
    bodiesFetched: 0,
    bodyCapHit: false,
    mailboxErrors: 0,
    detected: 0,
    created: 0,
    alreadyKnown: 0,
    parseFailed: 0,
    unresolved: 0,
    writeFailures: 0,
    newDetectionCampaignIds: [],
  };
  if (selection.targets.length === 0) return summary;

  const credentials = resolveMailCredentials();
  if (!credentials) {
    // 빈 자격증명으로 붙으면 인증 실패가 「회신 0건」으로 보인다 — 실행 실패로 드러낸다.
    return { ...summary, failed: true, failureReason: '메일 서버(IMAP) 연동 정보가 설정되어 있지 않습니다.' };
  }

  // 브랜드는 템플릿 단위로 한 번만 읽는다.
  const resolveBrand = deps.resolveBrand ?? resolveOrderBrand;
  const brandByTemplate = new Map<string, OrderBrand | null>();
  const targets: Array<InvoiceReplyTarget & { brand: OrderBrand | null }> = [];
  for (const target of selection.targets) {
    const key = target.template ?? '';
    if (!brandByTemplate.has(key)) brandByTemplate.set(key, await resolveBrand(target.template));
    targets.push({ ...target, brand: brandByTemplate.get(key) ?? null });
  }

  // ── 마감과 소켓 오류 감시. 둘 다 진행 중인 작업과 **경주**시켜, 먼저 터지면 연결을 끊고 실패로 기록한다.
  //    ⚠️ `error` 이벤트에 리스너가 없으면 EventEmitter 가 그 오류를 **프로세스 수준에서 던진다** —
  //    앱 서버 전체를 흔드는 경로라 연결 직후 반드시 단다(떼지 않는다: 종료 뒤 늦게 오는 오류도 받는다).
  const deadlineMs = deps.deadlineMs ?? RUN_DEADLINE_MS;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      reject(new RunDeadlineError(deadlineMs));
    }, deadlineMs);
  });
  let failOnSocketError: (error: Error) => void = () => {};
  const socketFailure = new Promise<never>((_, reject) => {
    failOnSocketError = reject;
  });
  // 경주에서 진 쪽의 거절이 「처리되지 않은 거절」로 새지 않게 한다.
  deadline.catch(() => {});
  socketFailure.catch(() => {});

  let connection: ImapSimple | null = null;
  try {
    const connecting = deps.connect
      ? deps.connect()
      : imaps.connect({ imap: resolveImapConfig(credentials, { authTimeout: 10_000 }) });
    // 마감 뒤에 늦게 붙은 연결은 바로 닫는다(새는 세션 방지).
    connecting
      .then((late) => {
        if (timedOut) safeEnd(late);
      })
      .catch(() => {});
    try {
      connection = await Promise.race([connecting, deadline]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...summary,
        failed: true,
        failureReason: error instanceof RunDeadlineError ? message : `메일 서버 연결 실패: ${message}`,
      };
    }
    (connection as unknown as { on?: (event: string, listener: (error: unknown) => void) => void }).on?.(
      'error',
      (error: unknown) => {
        // 주소·자격증명은 서버 오류 문구에 없다 — 메시지만 남긴다.
        console.warn('[scan-invoice-replies] 메일 서버 연결 오류:', error instanceof Error ? error.message : String(error));
        failOnSocketError(new SocketError(error));
      },
    );

    let scan: MailboxScanResult;
    try {
      const scanning = scanInvoiceRepliesReadOnly(connection, targets, { loginUser: credentials.user, now });
      scanning.catch(() => {});
      scan = await Promise.race([scanning, deadline, socketFailure]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const known = error instanceof RunDeadlineError || error instanceof SocketError;
      return { ...summary, failed: true, failureReason: known ? message : `메일함 조회 실패: ${message}` };
    }

    // 세션은 스캔이 끝나는 대로 닫는다(저장은 DB 만 쓴다).
    safeEnd(connection);
    connection = null;

    const persisted = await persistInvoiceReplyDetections(deps.db, scan.detections);

    const out: InvoiceReplyRunSummary = {
      ...summary,
      mailboxesListed: scan.mailboxesListed,
      mailboxesOpened: scan.mailboxesOpened,
      headersScanned: scan.headersScanned,
      bodiesFetched: scan.bodiesFetched,
      bodyCapHit: scan.bodyCapHit,
      mailboxErrors: scan.mailboxErrors,
      detected: scan.detections.length,
      created: persisted.created,
      alreadyKnown: persisted.alreadyKnown,
      parseFailed: scan.detections.filter((d) => d.parseFailed).length,
      unresolved: scan.unresolved,
      writeFailures: persisted.writeFailures,
      newDetectionCampaignIds: persisted.createdCampaignIds,
    };

    // 실질 실패 선언(레이더 빨강): 편지함을 하나도 못 열었거나, 감지를 하나도 못 남겼다.
    if (scan.mailboxesListed > 0 && scan.mailboxesOpened === 0) {
      return { ...out, failed: true, failureReason: `편지함 ${scan.mailboxErrors}곳을 모두 열지 못했습니다` };
    }
    if (persisted.writeFailures > 0 && persisted.created === 0 && persisted.alreadyKnown === 0) {
      return { ...out, failed: true, failureReason: `감지 기록 ${persisted.writeFailures}건 저장 실패` };
    }
    return out;
  } finally {
    clearTimeout(deadlineTimer);
    if (connection) safeEnd(connection);
  }
}

function safeEnd(connection: ImapSimple): void {
  try {
    connection.end();
  } catch {
    // 종료 실패는 결과에 영향이 없다.
  }
}
