/**
 * 브랜드 정산 메일(첨부 「피벗」) ↔ CRM 판매캠페인 품목 줄 **옵션 단위 대조** — 순수 모듈(봇 조회
 * `get_settlement_reconciliation` v1). 메일함·DB 는 호출부(`agent-internal/settlement-reconciliation.ts`)가 읽고,
 * 여기서는 판정과 봇·사람에게 보일 글만 만든다. 아무것도 고쳐 쓰지 않는다 — 빠진 품목 줄·매핑은 기존 기안
 * (`add_campaign_items` → 승인 뒤 `apply_product_mappings`)으로 사람이 넣는다.
 *
 * ## 옵션 한 줄의 판정표 (피벗 옵션명 L 하나에 대해)
 * 비교 키는 `normalizeMappingOptionName`(= `campaignItemNameKey`) 정확 일치뿐이다 — 낱말 겹침·유사도는 쓰지 않는다.
 *  - M = 이 캠페인(그룹이면 멤버 전부)의 주문캠페인 매핑 중 옵션명 키가 L 과 같은 줄
 *  - D = 상위 판매 조건 밑 하위품목 중 이름 키가 L 과 같은 것(`campaignOptionNameKey` 로 「판매 조건 - 옵션」 꼴도 맞춘다)
 *  - 품목 줄 = 이 캠페인의 CampaignDeal
 *
 * | M | M 이 이 캠페인 품목 줄에 연결 | D 의 품목 줄 | 상태 |
 * |---|---|---|---|
 * | 있음 | 하나 이상 | (무관) | 수량 대조: MATCH · MAIL_LESS · MAIL_MORE (CRM 수량 = 연결된 서로 다른 줄의 합) |
 * | 있음 | 없음(빈 연결 · 다른 캠페인 줄) | 있음 | MAPPING_WRONG_LINE — 매핑이 이 줄을 안 가리킨다(사람이 고친다) |
 * | 있음 | 없음 | 없음(D 없음 포함) | LINE_MISSING — 품목 줄부터 넣는다 |
 * | 없음 | — | 있음 | MAPPING_MISSING — 줄은 있는데 네이버 동기화가 채울 매핑이 없다 |
 * | 없음 | — | D 는 있고 줄 없음 | LINE_MISSING |
 * | 없음 | — | D 없음 | OPTION_UNKNOWN |
 * 같은 키의 매핑이 여러 줄이면 이 캠페인 줄에 연결된 것만 본다(서로 다른 줄을 가리키면 그 줄들의 합).
 * D 의 품목 줄이 여럿이면(그룹 캠페인 — 멤버마다 같은 하위품목 줄) CRM 수량은 그 줄들의 합이다.
 * 일곱 상태는 서로 겹치지 않는다 — 첫 줄 칸의 합 = 옵션 수.
 *
 * ## 메일 합산
 * - 메일 하나의 내용 키 = 정산 달 + (옵션명 키, 수량) 정렬 목록의 해시. 재발송·같은 내용의 정정본은 한 번만 센다.
 * - 같은 달에 내용이 다른 메일이 둘 이상이면 그 달은 **합산하지 않고** 충돌(MAIL_CONFLICT)로 알린다.
 * - 이 캠페인 옵션과 하나도 안 맞는 메일은 남의 것이다 — 버린다(헛경보를 내지 않는다). 단 **보이게** 버린다: 첫 줄
 *   `버림=` 칸 · 「일부만 확인」 사유 · `partial=1`. 전부 버려도 실패(STATEMENT_NOT_FOUND)가 아니라 결과(mails=0)다.
 * - MAIL_LESS 는 다음 달 메일이 아직 안 왔으면 정상이다. MAIL_MORE(브랜드가 CRM 보다 많이 셈)와 충돌만 확정 불일치다
 *   — 단 `partial=1` 이면 메일많음도 확정이 아니다(같은 셀러의 다른 회차 메일이 섞였을 수 있다).
 *
 * ## ⛔ 밖으로 나가는 칸 (오너 결정 2: 옵션명 · 수량 · 상태 · 달만)
 * 금액·구매자·주문번호·메일 본문·보낸 사람·제목·첨부 파일명·셀러 실명은 이 모듈의 입력에도 출력에도 없다.
 * 출력 모양은 `settlementReconciliationDataSchema`(strict)가 화이트리스트다 — 창구 응답·결재함 READ 기록이 같은 값이다.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  campaignItemNameKey,
  campaignOptionNameKey,
  MAX_RESULT_SUMMARY_CHARS,
  normalizeMappingOptionName,
  opaqueIdSchema,
} from "@/lib/agent-worker/contracts";
import type { PivotRow } from "./statement-pivot-xls";

export const MAX_RECON_MAILS = 6;
/** 출력 옵션 줄 상한 — 넘는 줄은 개수(`optionsOmitted`)로만 싣고 첫 줄 칸은 전부를 센다. */
export const MAX_RECON_OPTIONS = 200;
/** 옵션명 출력 상한(글자). */
export const MAX_RECON_OPTION_NAME_CHARS = 80;
/** 둘째 줄부터 싣는 옵션 줄 상한 — 넘으면 「…외 N개」로 밝힌다(조용히 자르지 않는다). */
export const MAX_RECON_SUMMARY_OPTION_LINES = 40;
/** 첫 줄 상한 — 봇은 결과의 첫 줄만 받는다(hermes 완료 알림 ~200자). */
export const MAX_RECON_FIRST_LINE_CHARS = 200;

export const RECON_OPTION_STATUSES = [
  "MATCH",
  "MAIL_LESS",
  "MAIL_MORE",
  "LINE_MISSING",
  "MAPPING_MISSING",
  "MAPPING_WRONG_LINE",
  "OPTION_UNKNOWN",
] as const;
export type ReconOptionStatus = (typeof RECON_OPTION_STATUSES)[number];

const yearMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const ymdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const countSchema = z.number().int().min(0).max(1_000_000);

export const settlementReconciliationDataSchema = z
  .object({
    kind: z.literal("settlement_reconciliation"),
    version: z.literal(1),
    campaignId: opaqueIdSchema,
    partial: z.boolean(),
    /** 피벗을 읽은 메일 수(같은 내용은 한 번) */
    mailsRead: countSchema,
    lastMailMonth: yearMonthSchema.nullable(),
    /** 상한(6통)·본문 해석 실패로 못 본 후보 수 */
    truncated: countSchema,
    /** 첨부를 못 읽은 메일 수(암호·크기 초과·깨짐) */
    unreadable: countSchema,
    /** 첨부 표가 없는 메일 수 */
    withoutSheet: countSchema,
    /** 다른 셀러 이름도 함께 걸려 어느 쪽 것인지 모르는 메일 수 */
    ambiguous: countSchema,
    /** 이 캠페인 옵션과 하나도 안 맞아 버린 메일 수 */
    dropped: countSchema,
    /** 조회 기간에 겹치는 같은 셀러·같은 거래처의 다른 회차 수 */
    overlappingRounds: countSchema,
    timedOut: z.boolean(),
    conflictMonths: z.array(yearMonthSchema).max(24),
    mails: z
      .array(
        z
          .object({
            yearMonth: yearMonthSchema,
            receivedDate: ymdSchema,
            source: z.enum(["XLS", "NONE"]),
          })
          .strict(),
      )
      .max(MAX_RECON_MAILS),
    /** 상태별 옵션 수 — 출력 줄 상한과 무관하게 전부를 센다(첫 줄 칸) */
    counts: z
      .object({
        options: countSchema,
        MATCH: countSchema,
        MAIL_LESS: countSchema,
        MAIL_MORE: countSchema,
        LINE_MISSING: countSchema,
        MAPPING_MISSING: countSchema,
        MAPPING_WRONG_LINE: countSchema,
        OPTION_UNKNOWN: countSchema,
      })
      .strict(),
    options: z
      .array(
        z
          .object({
            optionName: z.string().min(1).max(MAX_RECON_OPTION_NAME_CHARS),
            status: z.enum(RECON_OPTION_STATUSES),
            mailQty: countSchema,
            crmQty: countSchema.nullable(),
          })
          .strict(),
      )
      .max(MAX_RECON_OPTIONS),
    optionsOmitted: countSchema,
  })
  .strict();

export type SettlementReconciliationData = z.infer<typeof settlementReconciliationDataSchema>;

/**
 * 메일 한 통(호출부가 고른 것). rows = 피벗 줄, 표를 못 읽었거나 없으면 null. 메일 식별 키는 없다 — 같은 메일 가르기는
 * 내용 키(`mailContentKey`)로 하고, 출력에도 메일을 가리키는 값을 싣지 않는다(코드 리뷰 2026-11-24: 쓰는 곳 없음).
 */
export type ReconMail = {
  yearMonth: string;
  receivedDate: string;
  source: "XLS" | "NONE";
  rows: readonly PivotRow[] | null;
};

export type ReconCatalog = {
  mainDeals: ReadonlyArray<{ id: string; name: string }>;
  optionDeals: ReadonlyArray<{ id: string; parentDealId: string; name: string }>;
  lines: ReadonlyArray<{ id: string; dealId: string; quantity: number }>;
  mappings: ReadonlyArray<{ optionName: string; campaignDealId: string | null }>;
};

export type ReconScanFacts = {
  truncated: number;
  unreadable: number;
  ambiguous: number;
  overlappingRounds: number;
  timedOut: boolean;
};

/** 메일 하나의 내용 키 — 재발송·같은 내용 정정본을 한 번만 세려고. */
export function mailContentKey(yearMonth: string, rows: readonly PivotRow[]): string {
  const body = rows
    .map((row) => `${normalizeMappingOptionName(row.label)}\u0000${row.qty}`)
    .sort()
    .join("\u0001");
  return createHash("sha256").update(`${yearMonth}\u0002${body}`).digest("hex");
}

type OptionJudgment = { status: ReconOptionStatus; crmQty: number | null };

/** 판정표(머리 주석) 그대로. */
export function judgeOption(label: string, mailQty: number, catalog: ReconCatalog): OptionJudgment {
  const key = normalizeMappingOptionName(label);
  const lineById = new Map(catalog.lines.map((line) => [line.id, line]));
  const mappings = catalog.mappings.filter((mapping) => normalizeMappingOptionName(mapping.optionName) === key);
  const linkedLineIds = new Set(
    mappings.map((mapping) => mapping.campaignDealId).filter((id): id is string => id !== null && lineById.has(id)),
  );
  const mainName = new Map(catalog.mainDeals.map((deal) => [deal.id, deal.name]));
  const nameDeals = catalog.optionDeals.filter((deal) => {
    const dealKey = campaignItemNameKey(deal.name);
    const parent = mainName.get(deal.parentDealId);
    return dealKey === campaignItemNameKey(label) || (parent !== undefined && dealKey === campaignOptionNameKey(parent, label));
  });
  // 그룹 캠페인은 같은 하위품목 줄이 멤버마다 있다 — 이름이 맞는 줄 전부의 합(서로 다른 줄 id 이므로 겹쳐 세지 않는다).
  const nameDealIds = new Set(nameDeals.map((deal) => deal.id));
  const nameLines = catalog.lines.filter((line) => nameDealIds.has(line.dealId));
  const nameLine = nameLines.length > 0 ? { quantity: nameLines.reduce((sum, line) => sum + line.quantity, 0) } : null;

  if (mappings.length > 0) {
    if (linkedLineIds.size > 0) {
      const crmQty = [...linkedLineIds].reduce((sum, id) => sum + (lineById.get(id)?.quantity ?? 0), 0);
      const status: ReconOptionStatus = mailQty === crmQty ? "MATCH" : mailQty < crmQty ? "MAIL_LESS" : "MAIL_MORE";
      return { status, crmQty };
    }
    return nameLine ? { status: "MAPPING_WRONG_LINE", crmQty: nameLine.quantity } : { status: "LINE_MISSING", crmQty: null };
  }
  if (nameLine) return { status: "MAPPING_MISSING", crmQty: nameLine.quantity };
  return nameDeals.length > 0 ? { status: "LINE_MISSING", crmQty: null } : { status: "OPTION_UNKNOWN", crmQty: null };
}

function isKnownLabel(label: string, catalog: ReconCatalog): boolean {
  return judgeOption(label, 0, catalog).status !== "OPTION_UNKNOWN";
}

const STATUS_ORDER: Record<ReconOptionStatus, number> = {
  MAIL_MORE: 0,
  LINE_MISSING: 1,
  MAPPING_WRONG_LINE: 2,
  MAPPING_MISSING: 3,
  OPTION_UNKNOWN: 4,
  MAIL_LESS: 5,
  MATCH: 6,
};

function capName(label: string): string {
  return label.length > MAX_RECON_OPTION_NAME_CHARS ? `${label.slice(0, MAX_RECON_OPTION_NAME_CHARS - 1)}…` : label;
}

/** 대조 본체 — 고른 메일 + CRM 품목·매핑 → 출력 데이터(화이트리스트 모양). */
export function reconcileSettlement(input: {
  campaignId: string;
  mails: readonly ReconMail[];
  catalog: ReconCatalog;
  scan: ReconScanFacts;
}): SettlementReconciliationData {
  const { catalog } = input;
  // 남의 메일 버리기 — 표가 있는데 이 캠페인 옵션과 하나도 안 맞으면.
  const kept = input.mails.filter((mail) => !mail.rows || mail.rows.some((row) => isKnownLabel(row.label, catalog)));
  const dropped = input.mails.length - kept.length;
  const withSheet = kept.filter((mail): mail is ReconMail & { rows: readonly PivotRow[] } => mail.rows !== null);

  // 달별 서로 다른 내용.
  const byMonth = new Map<string, Map<string, readonly PivotRow[]>>();
  for (const mail of withSheet) {
    const contents = byMonth.get(mail.yearMonth) ?? new Map<string, readonly PivotRow[]>();
    contents.set(mailContentKey(mail.yearMonth, mail.rows), mail.rows);
    byMonth.set(mail.yearMonth, contents);
  }
  const conflictMonths = [...byMonth.entries()].filter(([, contents]) => contents.size > 1).map(([month]) => month).sort();

  const mailQtyByKey = new Map<string, { label: string; qty: number }>();
  for (const [, contents] of byMonth) {
    if (contents.size !== 1) continue;
    for (const row of [...contents.values()][0]) {
      const key = normalizeMappingOptionName(row.label);
      const entry = mailQtyByKey.get(key) ?? { label: normalizeMappingOptionName(row.label), qty: 0 };
      entry.qty += row.qty;
      mailQtyByKey.set(key, entry);
    }
  }

  const judged = [...mailQtyByKey.values()].map(({ label, qty }) => ({
    optionName: capName(label),
    mailQty: qty,
    ...judgeOption(label, qty, catalog),
  }));
  judged.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.optionName.localeCompare(b.optionName, "ko"));

  const counts = Object.fromEntries(RECON_OPTION_STATUSES.map((status) => [status, 0])) as Record<ReconOptionStatus, number>;
  for (const option of judged) counts[option.status] += 1;

  const withoutSheet = kept.length - withSheet.length;
  const mailsRead = [...byMonth.values()].reduce((sum, contents) => sum + contents.size, 0);
  const months = [...byMonth.keys()].sort();
  const partial =
    input.scan.truncated > 0 ||
    input.scan.unreadable > 0 ||
    input.scan.ambiguous > 0 ||
    input.scan.overlappingRounds > 0 ||
    input.scan.timedOut ||
    withoutSheet > 0 ||
    dropped > 0 ||
    conflictMonths.length > 0 ||
    judged.length > MAX_RECON_OPTIONS;

  return {
    kind: "settlement_reconciliation",
    version: 1,
    campaignId: input.campaignId,
    partial,
    mailsRead,
    lastMailMonth: months.length > 0 ? months[months.length - 1] : null,
    truncated: input.scan.truncated,
    unreadable: input.scan.unreadable,
    withoutSheet,
    ambiguous: input.scan.ambiguous,
    dropped,
    overlappingRounds: input.scan.overlappingRounds,
    timedOut: input.scan.timedOut,
    conflictMonths,
    mails: kept.slice(0, MAX_RECON_MAILS).map((mail) => ({
      yearMonth: mail.yearMonth,
      receivedDate: mail.receivedDate,
      source: mail.source,
    })),
    counts: { options: judged.length, ...counts },
    options: judged.slice(0, MAX_RECON_OPTIONS).map(({ optionName, status, mailQty, crmQty }) => ({
      optionName,
      status,
      mailQty,
      crmQty,
    })),
    optionsOmitted: Math.max(0, judged.length - MAX_RECON_OPTIONS),
  };
}

/** 일부만 확인한 결과의 메일많음 — 같은 셀러 다른 회차 메일이 섞였을 수 있어 확정이 아니다. 충돌은 늘 확정이다. */
export const MAIL_MORE_UNCONFIRMED_TEXT = "메일 많음(미확정: 일부만 확인)";

const STATUS_TEXT: Record<ReconOptionStatus, string> = {
  MATCH: "일치",
  MAIL_LESS: "메일 적음(다음 달 메일 대기일 수 있음)",
  // partial=1 이면 MAIL_MORE_UNCONFIRMED_TEXT 로 바뀐다(첫 줄 칸은 그대로).
  MAIL_MORE: "메일 많음(브랜드가 CRM 보다 많이 셈)",
  LINE_MISSING: "품목 줄 없음",
  MAPPING_MISSING: "매핑 없음",
  MAPPING_WRONG_LINE: "매핑이 이 품목 줄에 연결 안 됨",
  OPTION_UNKNOWN: "모르는 옵션",
};

/**
 * 첫 줄 — 봇이 받는 전부. 칸 순서·이름이 hermes 쪽 사본 계약이다:
 * `recon campaign=<id> partial=<0|1> mails=<n> 옵션=<n> 일치=<n> 메일적음=<n> 메일많음=<n> 줄누락=<n> 매핑누락=<n>
 *  연결오류=<n> 미상=<n> 충돌=<n> 버림=<n>` (13칸, 이 순서). 충돌 = 충돌 달 수, 버림 = 이 캠페인 옵션과 하나도 안 맞아
 *  뺀 메일 수. 200자를 넘으면 숫자 칸이 아니라 캠페인 id 를 줄인다(봇은 자기가 보낸 id 를 안다).
 */
export function formatReconFirstLine(data: SettlementReconciliationData): string {
  const c = data.counts;
  const rest =
    ` partial=${data.partial ? 1 : 0} mails=${data.mailsRead} 옵션=${c.options} 일치=${c.MATCH} 메일적음=${c.MAIL_LESS}` +
    ` 메일많음=${c.MAIL_MORE} 줄누락=${c.LINE_MISSING} 매핑누락=${c.MAPPING_MISSING} 연결오류=${c.MAPPING_WRONG_LINE}` +
    ` 미상=${c.OPTION_UNKNOWN} 충돌=${data.conflictMonths.length} 버림=${data.dropped}`;
  const head = "recon campaign=";
  const room = MAX_RECON_FIRST_LINE_CHARS - head.length - rest.length;
  const id = data.campaignId.length <= room ? data.campaignId : `${data.campaignId.slice(0, Math.max(0, room - 1))}…`;
  return `${head}${id}${rest}`;
}

function partialReasons(data: SettlementReconciliationData): string[] {
  const reasons: string[] = [];
  if (data.truncated > 0) reasons.push(`못 본 후보 메일 ${data.truncated}통`);
  if (data.unreadable > 0) reasons.push(`못 읽은 첨부 ${data.unreadable}통`);
  if (data.withoutSheet > 0) reasons.push(`첨부 표 없는 메일 ${data.withoutSheet}통`);
  if (data.ambiguous > 0) reasons.push(`다른 셀러와 겹쳐 뺀 메일 ${data.ambiguous}통`);
  if (data.dropped > 0) reasons.push(`옵션이 하나도 안 맞아 뺀 메일 ${data.dropped}통`);
  if (data.overlappingRounds > 0) reasons.push(`같은 셀러 다른 회차 ${data.overlappingRounds}건이 기간에 겹침(메일 많음도 확정 아님)`);
  if (data.timedOut) reasons.push("시간 초과로 일부만 읽음");
  if (data.optionsOmitted > 0) reasons.push(`옵션 ${data.optionsOmitted}개는 표에서 생략`);
  return reasons;
}

function statusText(status: ReconOptionStatus, partial: boolean): string {
  return status === "MAIL_MORE" && partial ? MAIL_MORE_UNCONFIRMED_TEXT : STATUS_TEXT[status];
}

/**
 * 결과 요약 전체 — 첫 줄(봇) + 둘째 줄부터 사람용(슬랙 첨부·결재함 기록). 옵션 줄은 40줄 · 전체 글자 상한
 * (`MAX_RESULT_SUMMARY_CHARS`) 안에서만 싣고 나머지는 「…외 N개」로 밝힌다.
 */
export function formatSettlementReconciliation(data: SettlementReconciliationData): string {
  const lines = [formatReconFirstLine(data)];
  const reasons = partialReasons(data);
  if (reasons.length > 0) lines.push(`일부만 확인: ${reasons.join(" · ")}`);
  for (const month of data.conflictMonths) lines.push(`충돌 ${month}: 같은 달 정산 메일 내용이 서로 다름(합산하지 않음)`);
  for (const mail of data.mails) {
    lines.push(`메일 ${mail.yearMonth}분 · 받은 날 ${mail.receivedDate} · ${mail.source === "XLS" ? "첨부 표 읽음" : "첨부 표 없음"}`);
  }
  const reserve = 20; // 「…외 N개」 줄 자리
  let used = lines.join("\n").length;
  let shown = 0;
  for (const option of data.options) {
    if (shown >= MAX_RECON_SUMMARY_OPTION_LINES) break;
    const line = `옵션「${option.optionName}」 메일 ${option.mailQty} · CRM ${option.crmQty ?? "-"} · ${statusText(option.status, data.partial)}`;
    if (used + 1 + line.length > MAX_RESULT_SUMMARY_CHARS - reserve) break;
    lines.push(line);
    used += 1 + line.length;
    shown += 1;
  }
  const hidden = data.counts.options - shown;
  if (hidden > 0) lines.push(`…외 ${hidden}개`);
  return lines.join("\n");
}
