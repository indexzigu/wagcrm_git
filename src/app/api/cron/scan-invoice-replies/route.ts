import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { getPrisma } from "@/lib/prisma";
import { runInvoiceReplyScan, type InvoiceReplyScanDb } from "@/lib/order-converter/invoice-reply-scan";

/**
 * **송장 회신 도착 감지** — 매시 정각 10:00~20:00 KST(매일). 발주 자동화 1단계 B(오너 승인 2026-10-06).
 *
 * 발주요청은 했고 송장 등록이 덜 끝난 주문캠페인마다 메일함을 **읽기 전용**으로 훑어 브랜드사의
 * 송장 회신이 왔는지 기록만 한다. 주문 관리 카드가 그 기록으로 「회신 도착 · N건 · HH:MM」을 띄운다.
 *
 * ⛔ 송장 등록 · 네이버 호출 · `OrderActionLog` · 메일 발송 · 메일 읽음 표시를 하지 않는다.
 *    본체와 그 근거는 `src/lib/order-converter/invoice-reply-scan.ts` 머리 주석이 정본이다.
 *
 * 외부 IO(IMAP)는 이 라우트의 요청 안에서 끝난다 — DB 트랜잭션과 엮이지 않는 읽기라 `after()` 로
 * 뺄 이유가 없고, 결과(감지 수·실패)가 레이더 기록에 실려야 하므로 응답 전에 마친다.
 *
 * 실패는 `failed: true` 로 선언해 시스템 레이더를 빨강으로 만든다(HTTP 200 ≠ 성공).
 */

// IMAP 세션 1회(편지함 나열 + 헤더 조회 + 본문 상한 200통). 다른 메일 크론과 같은 상한.
export const maxDuration = 300;

async function handler(request: Request): Promise<Response> {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const summary = await runInvoiceReplyScan({
    db: getPrisma() as unknown as InvoiceReplyScanDb,
  });
  return NextResponse.json(summary);
}

export const GET = withSystemTaskStatus("scan-invoice-replies", handler);
