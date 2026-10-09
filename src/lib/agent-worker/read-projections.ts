import { Buffer } from "node:buffer";
import { maskPiiForExport } from "@/lib/kakao/pii-mask";
import type { ClaimType, DerivedClaim } from "@/lib/order-converter/claim-derive";
import { MAX_RESULT_SUMMARY_CHARS } from "./contracts";

/**
 * 봇(agent worker)의 스토어 현황·카톡 업무기록 읽기가 **밖으로 내보내는 모양**만 정하는 순수 모듈
 * (Phase 3 ②⑧, 2026-10-09). DB 를 읽는 쪽은 `executor.ts` 이고, 여기는 받은 행을 허용 칸만 담은
 * **새 객체**로 옮기고 개인정보 가림을 다시 거는 일만 한다.
 *
 * ⛔ 행을 펼쳐(`...row`) 넘기지 말 것. 원본 행에 칸이 늘어나는 순간 그 칸이 검토 없이 봇의 대화
 *    맥락·슬랙 회신·결재함 기록까지 따라간다. 칸은 아래 타입에 적힌 것만 하나씩 옮긴다.
 * ⛔ 클레임의 구매자 이름·연락처(뒷 4자리 포함)·주소·주문번호·수거 송장은 싣지 않는다. 주문 관리
 *    화면(`maskClaimForClient`)은 오너가 보는 곳이라 이름을 보이지만, 이 결과는 슬랙과 클라우드
 *    모델(Muse)로 나간다 — 화면의 가림 수준을 그대로 쓰면 이름이 밖으로 나간다.
 */

/** 클레임 사유 한 줄의 상한(글자). 사유는 구매자가 직접 쓴 글일 수 있어 길이를 묶는다. */
export const MAX_CLAIM_REASON_CHARS = 200;

export type StoreClaimView = {
  claimType: ClaimType;
  claimStatus: string | null;
  claimStatusLabel: string;
  productName: string | null;
  quantity: number | null;
  /** 사유 코드의 한글 라벨, 또는 구매자가 쓴 상세 사유(가림 처리 후). */
  reason: string | null;
  requestDate: string | null;
};

export type ClaimTypeCounts = Record<ClaimType, { open: number; completed: number }>;

/**
 * 줄을 나누는 문자를 공백 하나로 누른다. JS `\s` 에 없는 \u0085·\u001c-\u001e 도 넣는다 — 결과를
 * 읽는 쪽(hermes, Python `splitlines`)은 그것들도 줄바꿈으로 친다. 한 기록·한 제목이 둘째 줄로
 * 넘어가 머리 줄처럼 읽히는 길을 막는 것이 목적이다(`get_action_proposal` 도 이 함수를 쓴다).
 */
export function flattenLineBreaks(text: string): string {
  return text.replace(/[\s\u0085\u001c-\u001e]+/g, " ").trim();
}

/** 코드포인트 단위로 자른다(한글·이모지가 반으로 갈리지 않게). */
function truncateChars(text: string, max: number): { text: string; truncated: boolean } {
  const chars = Array.from(text);
  if (chars.length <= max) return { text, truncated: false };
  return { text: `${chars.slice(0, max - 1).join("")}…`, truncated: true };
}

export const NAME_MASK_TOKEN = "[NAME_MASKED]";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 글 속에서 **이미 아는 이름**(그 주문의 구매자·수취인)을 가린다. `maskPiiForExport` 는 전화·이메일·계좌·주소·송장만
 * 가리고 이름은 못 가리는데, 클레임 상세 사유는 구매자가 직접 쓰는 칸이라 자기 이름을 적는 일이 있다.
 * 세 글자 한글 이름은 이름 부분(뒤 두 글자)만 적는 경우도 함께 가린다 — 지나치게 가리는 쪽이 낫다.
 * ⚠️ 모르는 이름(제3자)은 가리지 못한다. 그래서 사유는 길이도 묶는다(`MAX_CLAIM_REASON_CHARS`).
 */
export function maskKnownNames(text: string, names: readonly (string | null | undefined)[]): string {
  const needles = new Set<string>();
  for (const raw of names) {
    const name = typeof raw === "string" ? raw.normalize("NFC").trim() : "";
    if (Array.from(name).length < 2) continue;
    needles.add(name);
    const chars = Array.from(name);
    if (chars.length === 3 && /^[가-힣]{3}$/.test(name)) needles.add(chars.slice(1).join(""));
  }
  let result = text.normalize("NFC");
  // 긴 것부터 — 「홍길동」을 먼저 가려야 「길동」만 가려 「홍」이 남는 일이 없다.
  for (const needle of [...needles].sort((left, right) => right.length - left.length)) {
    result = result.replace(new RegExp(escapeRegExp(needle), "g"), NAME_MASK_TOKEN);
  }
  return result;
}

function maskedLine(
  value: string | null | undefined,
  max: number,
  knownNames: readonly (string | null | undefined)[] = [],
): string | null {
  if (value === null || value === undefined) return null;
  const flat = flattenLineBreaks(String(value));
  if (!flat) return null;
  return truncateChars(maskPiiForExport(maskKnownNames(flat, knownNames)).text, max).text;
}

/**
 * 클레임 하나를 허용 칸만 담은 새 객체로 옮긴다. 사유는 구매자가 쓴 글일 수 있어 그 주문의
 * 구매자·수취인 이름(`knownNames`)과 연락처·계좌 꼴을 가린다.
 */
export function toStoreClaimView(
  claim: DerivedClaim,
  knownNames: readonly (string | null | undefined)[] = [],
): StoreClaimView {
  return {
    claimType: claim.claimType,
    claimStatus: claim.claimStatus,
    claimStatusLabel: claim.claimStatusLabel,
    productName: claim.productName === null ? null : flattenLineBreaks(String(claim.productName)) || null,
    quantity: claim.quantity,
    reason: maskedLine(claim.claimReason, MAX_CLAIM_REASON_CHARS, [claim.buyerName, ...knownNames]),
    requestDate: claim.requestDate === null ? null : String(claim.requestDate),
  };
}

/**
 * 클레임 소스 주문에서 주문별 이름(구매자·수취인)을 모은다 — 사유 가림(`maskKnownNames`)의 재료.
 * 이 값은 가림에만 쓰고 어디에도 싣지 않는다.
 */
export function collectKnownNamesByOrder(orders: readonly unknown[]): Map<string, string[]> {
  const byOrder = new Map<string, string[]>();
  for (const order of orders) {
    const row = order as { productOrderId?: unknown; ordererName?: unknown; shippingAddress?: { name?: unknown } } | null;
    if (!row?.productOrderId) continue;
    const names = [row.ordererName, row.shippingAddress?.name].filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    if (names.length === 0) continue;
    const key = String(row.productOrderId);
    byOrder.set(key, [...(byOrder.get(key) ?? []), ...names]);
  }
  return byOrder;
}

/**
 * 종류별 진행 중/종결 건수. 「진행 중」의 판정은 claim-derive 의 `isCompleted` 를 그대로 쓴다 —
 * 주문 관리 「반품/교환」·홈 「오늘 처리할 주문」과 같은 판정이다(여기서 다시 쓰지 않는다).
 */
export function countClaimsByType(claims: readonly DerivedClaim[]): ClaimTypeCounts {
  const counts: ClaimTypeCounts = {
    CANCEL: { open: 0, completed: 0 },
    RETURN: { open: 0, completed: 0 },
    EXCHANGE: { open: 0, completed: 0 },
  };
  for (const claim of claims) {
    const bucket = counts[claim.claimType];
    if (!bucket) continue;
    if (claim.isCompleted) bucket.completed += 1;
    else bucket.open += 1;
  }
  return counts;
}

function requestTimeMs(claim: DerivedClaim): number {
  const ms = claim.requestDate ? Date.parse(claim.requestDate) : NaN;
  return Number.isFinite(ms) ? ms : -Infinity;
}

/** 진행 중 클레임만, 요청일 최신순(요청일 모름은 맨 뒤)으로 `limit` 건. */
export function selectOpenClaims(
  claims: readonly DerivedClaim[],
  limit: number,
  namesByOrder: ReadonlyMap<string, readonly string[]> = new Map(),
): StoreClaimView[] {
  return claims
    .filter((claim) => !claim.isCompleted)
    .sort((left, right) => requestTimeMs(right) - requestTimeMs(left))
    .slice(0, limit)
    .map((claim) => toStoreClaimView(claim, namesByOrder.get(claim.productOrderId) ?? []));
}

/** 요약 한 줄. 끼워 넣는 칸은 **전부** 한 줄로 누른다 — 네이버가 준 상태 라벨·날짜도 예외가 아니다. */
export function formatStoreClaimLine(claim: StoreClaimView): string {
  const quantity = claim.quantity === null ? "" : ` x${claim.quantity}`;
  const reason = claim.reason ? ` 사유=${flattenLineBreaks(claim.reason)}` : "";
  const requested = claim.requestDate ? ` requested=${flattenLineBreaks(claim.requestDate)}` : "";
  const product = claim.productName ? flattenLineBreaks(claim.productName) : "(상품명 없음)";
  return `${flattenLineBreaks(claim.claimType)} [${flattenLineBreaks(claim.claimStatusLabel)}] ${product}${quantity}${reason}${requested}`;
}

// ---------------------------------------------------------------------------
// 카톡 업무기록
// ---------------------------------------------------------------------------

/** 기록 하나의 본문 상한(글자). 한 기록이 상한 전부를 먹어 다음 기록이 0건이 되는 일을 막는다. */
export const MAX_WORK_RECORD_TEXT_CHARS = 4_000;
/** 한 번의 조회가 싣는 본문 총량(글자). 넘으면 그 앞에서 멈추고 `truncated` 를 켠다. */
export const MAX_WORK_RECORDS_TOTAL_TEXT_CHARS = 30_000;
/**
 * 결재함 기록에 들어가는 기록 목록의 직렬화 상한(바이트). 결재함 봉투 상한(64KB,
 * `read-result-record.ts` `MAX_READ_RESULT_BYTES`)을 넘으면 데이터 **전체가** 마커로 바뀌므로
 * 그보다 넉넉히 아래에서 멈춘다 — 한글은 UTF-8 로 글자당 3바이트라 글자 상한만으로는 못 지킨다.
 */
export const MAX_WORK_RECORDS_STRUCTURED_BYTES = 48 * 1024;
/** 요약(봇에게 가는 글) 한 줄의 본문 상한(글자). */
export const MAX_WORK_RECORD_SUMMARY_LINE_CHARS = 300;

export type WorkRecordRow = {
  sentAt: Date;
  sender: string | null;
  rawText: string;
  isMasked: boolean;
  entityType: string | null;
  entityId: string | null;
  campaignId: string | null;
};

export type WorkRecordView = {
  sentAt: string;
  sender: string | null;
  text: string;
  /** 기록 하나의 본문이 `MAX_WORK_RECORD_TEXT_CHARS` 에서 잘렸는가. */
  textTruncated: boolean;
  /** 수집 때 가림이 놓친 것을 이번 읽기에서 다시 가렸는가(수집 가림 누락의 신호). */
  remasked: boolean;
  entityType: string | null;
  entityId: string | null;
  campaignId: string | null;
};

/**
 * 기록 하나를 허용 칸만 담은 새 객체로 옮긴다. 본문은 수집 때(`ingest-mapper`) 이미 가려졌지만
 * 같은 가림을 **다시**, 더 넓게(`maskPiiForExport` — 주소·송장 추가) 건다 — 가림은 멱등이라 이미 가린 글은 그대로이고, 수집 경로가
 * 바뀌거나(직원 txt 업로드 등) 가림 규칙이 넓어진 뒤의 옛 기록이 그대로 나가는 것을 막는다.
 * 보낸 사람은 수집 때 가리지 않는 칸(카톡 닉네임 원문)이라 같은 가림을 처음으로 건다.
 * ⚠️ 가림은 전화·이메일·계좌·주민번호·도로명 주소·송장만이다 — **사람 이름은 가리지 못한다.** 그래서
 *    봇에게 가는 요약 글에서는 보낸 사람을 화자 번호로 바꾼다(`assignSpeakerAliases`).
 */
export function toWorkRecordView(row: WorkRecordRow): WorkRecordView {
  const text = maskPiiForExport(row.rawText ?? "");
  const sender = row.sender === null ? null : maskPiiForExport(row.sender);
  const bounded = truncateChars(text.text, MAX_WORK_RECORD_TEXT_CHARS);
  return {
    sentAt: row.sentAt.toISOString(),
    sender: sender === null ? null : flattenLineBreaks(sender.text) || null,
    text: bounded.text,
    textTruncated: bounded.truncated,
    remasked: text.masked || Boolean(sender?.masked),
    entityType: row.entityType,
    entityId: row.entityId,
    campaignId: row.campaignId,
  };
}

export type BoundedWorkRecords = {
  records: WorkRecordView[];
  /** 본문 총량·직렬화 상한에 걸려 뒤 기록을 싣지 못했는가. */
  textCapReached: boolean;
  totalTextChars: number;
};

/** 앞에서부터 상한 안에 드는 만큼만 싣는다. 첫 기록은 언제나 싣는다(기록 하나는 자체 상한으로 이미 작다). */
export function boundWorkRecords(views: readonly WorkRecordView[]): BoundedWorkRecords {
  const records: WorkRecordView[] = [];
  let totalTextChars = 0;
  let bytes = 2; // "[]"
  for (const view of views) {
    const chars = Array.from(view.text).length;
    const viewBytes = Buffer.byteLength(JSON.stringify(view), "utf8") + 1;
    if (
      records.length > 0 &&
      (totalTextChars + chars > MAX_WORK_RECORDS_TOTAL_TEXT_CHARS || bytes + viewBytes > MAX_WORK_RECORDS_STRUCTURED_BYTES)
    ) {
      return { records, textCapReached: true, totalTextChars };
    }
    records.push(view);
    totalTextChars += chars;
    bytes += viewBytes;
  }
  return { records, textCapReached: false, totalTextChars };
}

const KST_MINUTE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** KST `YYYY-MM-DD HH:mm`. */
export function formatKstMinute(iso: string): string {
  const parts = Object.fromEntries(KST_MINUTE.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/**
 * 보낸 사람 → 그 조회 안에서만 쓰는 화자 번호(처음 나온 순서대로 화자1, 화자2, …).
 *
 * 🔒 봇에게 가는 **요약 글**(슬랙·클라우드 모델 Muse 로 간다)에는 카톡 닉네임 대신 이 번호를 싣는다 —
 *    닉네임은 대개 실명이고 가림 규칙(`maskPiiForExport`)은 이름을 못 가린다. 진짜 보낸 사람은 오너만
 *    보는 결재함 기록(structuredResult.records[].sender)에만 남는다. 번호는 **조회마다 새로 매긴다**
 *    — 조회를 넘어 같은 번호가 같은 사람이라는 보장은 없다(그 보장을 주면 번호가 곧 식별자가 된다).
 *    보낸 사람이 비어 있는 기록은 번호를 받지 않는다.
 */
export function assignSpeakerAliases(views: readonly WorkRecordView[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const view of views) {
    if (view.sender === null || aliases.has(view.sender)) continue;
    aliases.set(view.sender, `화자${aliases.size + 1}`);
  }
  return aliases;
}

export function formatWorkRecordLine(view: WorkRecordView, speakerAliases: ReadonlyMap<string, string>): string {
  const text = truncateChars(flattenLineBreaks(view.text), MAX_WORK_RECORD_SUMMARY_LINE_CHARS).text;
  const speaker = view.sender === null ? "(보낸 사람 없음)" : (speakerAliases.get(view.sender) ?? "화자?");
  return `${formatKstMinute(view.sentAt)} ${speaker}: ${text}`;
}

// ---------------------------------------------------------------------------
// 요약 글 조립
// ---------------------------------------------------------------------------

/**
 * 머리 줄 + 본문 줄을 `MAX_RESULT_SUMMARY_CHARS` 안에 **줄 단위로** 담는다. 실행기의 `boundSummary`
 * 는 글자 단위로 잘라 마지막 줄을 반 토막 내므로, 여기서 먼저 온전한 줄만 고른다. 머리 줄은 몇 줄을
 * 담았는지(`shown`)를 알아야 쓸 수 있어 함수로 받는다.
 */
export function buildBoundedSummary(
  makeHeader: (shown: number) => string,
  lines: readonly string[],
  maxChars: number = MAX_RESULT_SUMMARY_CHARS,
): { summary: string; shown: number } {
  const prefix: number[] = [0];
  for (const line of lines) prefix.push(prefix[prefix.length - 1] + line.length + 1);
  for (let shown = lines.length; shown >= 0; shown -= 1) {
    const header = makeHeader(shown);
    if (header.length + prefix[shown] <= maxChars) {
      return { summary: [header, ...lines.slice(0, shown)].join("\n"), shown };
    }
  }
  return { summary: makeHeader(0), shown: 0 };
}
