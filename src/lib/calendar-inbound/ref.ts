// [캘린더수집] 기안 출처 칸(`ActionProposal.sourceRef.calendarInbound`) 모양 — **순수 모듈**(Prisma 무의존).
// 결재함 카드(클라이언트 컴포넌트)도 이 리더를 import 하므로 DB 를 끌어오는 `adopt.ts` 와 갈라 뒀다.
// `adopt.ts` 가 그대로 다시 내보내므로 서버 쪽 import 경로는 바뀌지 않는다.
import { z } from "zod";
import { parseStoredJson } from "@/lib/stored-json";

/** 캘린더 수집이 기안을 올릴 때 쓰는 createdBy — 사람 승인자와 겹치지 않는다(self-approval 게이트). */
export const CALENDAR_INBOUND_CREATED_BY = "SYSTEM_CALENDAR_INBOUND";

/**
 * 기안 `sourceRef.calendarInbound` 모양 — 수집 스캔(`scan.ts`)이 쓰고 승인·반려·결재 카드가 읽는다.
 * 카드 표시용 칸(summary·날짜·htmlLink·warnings)도 함께 싣는다.
 */
export const calendarInboundRefSchema = z.object({
  /** CalendarInboundEvent.id */
  inboundId: z.string().min(1),
  /** 구글 이벤트 id */
  eventId: z.string().min(1),
  calendarId: z.string().min(1),
  ledgerKind: z.enum(["campaign", "deposit", "payout", "supplierPayout"]),
  /** false = 장부는 건드리지 않고 처리 끝으로만 표기(제안 단계 캠페인 대상 등). */
  adopt: z.boolean(),
  summary: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  /** 구글 캘린더 링크. 카드가 `<a href>` 로 그리므로 `https://` 만 받고 그 밖(javascript: 등)은 null 로 접는다. */
  htmlLink: z
    .string()
    .nullable()
    .transform((link) => (link !== null && link.startsWith("https://") ? link : null)),
  warnings: z.array(z.string()),
});

export type CalendarInboundRef = z.infer<typeof calendarInboundRefSchema>;

const sourceRefSchema = z.object({ calendarInbound: calendarInboundRefSchema });

/**
 * 기안의 `sourceRef` 에서 캘린더 출처를 읽는다. 없거나 모양이 틀리면 null(= 캘린더 출신이 아니다).
 * 🪤 raw Prisma 로 읽은 Json 은 SQLite 레인에서 문자열이다 — `parseStoredJson` 을 거친다(`stored-json.ts`).
 */
export function readCalendarInboundRef(sourceRef: unknown): CalendarInboundRef | null {
  const parsed = sourceRefSchema.safeParse(parseStoredJson<unknown>(sourceRef));
  return parsed.success ? parsed.data.calendarInbound : null;
}
