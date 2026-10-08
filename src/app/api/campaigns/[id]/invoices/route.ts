import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { revalidateCampaignCaches } from "@/lib/cache-tags";
import { CampaignInvoiceError, campaignInvoiceService } from "@/services/campaignInvoiceService";

type Context = { params: Promise<{ id: string }> };

/**
 * 캠페인 계산서 여러 장(T-240 후속) — 월정산 거래처의 공급사 계산서 칸.
 *
 * GET 은 저장된 행과 단위 정보만 준다. 메일 후보는 시트가 이미 받아 온 수취 조회 결과
 * (`/api/settlement/tax-invoice-receipts` 의 `results[].invoice`)로 화면이 고른다 — 메일함을 두 번
 * 스캔하지 않는다. 판정은 `campaign-invoices.ts` 하나다.
 *
 * POST 는 오너의 클릭만 근거로 쓴다(명세 「사람 검수 없는 자동 실행 금지」). 「몇 월분」은 화면이
 * 보낸 값이 아니라 작성일에서 서버가 다시 정한다.
 */
export async function GET(_request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;
  const { id } = await context.params;
  try {
    return NextResponse.json(await campaignInvoiceService.getView(id));
  } catch (error) {
    if (error instanceof CampaignInvoiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

const ymd = z.string().date();
// 열이 INTEGER(int4)라 그 범위를 넘는 값은 DB 오류(500)가 된다 — 입력 단계에서 400 으로 막는다.
const money = z.number().int().min(-2147483648).max(2147483647).nullable();

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("confirm"),
    issueId: z.string().trim().min(1).max(40),
    writtenDate: ymd,
    supplyAmount: money,
    taxAmount: money,
    totalAmount: money,
    itemName: z.string().max(500).nullable(),
    mailReceivedAt: z.string().datetime().nullable(),
  }),
  z.object({
    action: z.literal("manual"),
    writtenDate: ymd,
    totalAmount: money,
    approvalNo: z.string().trim().max(40).nullable(),
    note: z.string().max(500).nullable(),
  }),
  z.object({
    action: z.literal("waive"),
    yearMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    note: z.string().max(500).nullable(),
  }),
  z.object({
    action: z.literal("dismiss"),
    issueId: z.string().trim().min(1).max(40),
    writtenDate: ymd,
  }),
  z.object({
    action: z.literal("revert"),
    rowId: z.string().min(1),
  }),
]);

export async function POST(request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;
  const { id } = await context.params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }
  const body = parsed.data;
  try {
    let row;
    switch (body.action) {
      case "confirm":
        row = await campaignInvoiceService.confirmMailInvoice(id, body);
        break;
      case "manual":
        row = await campaignInvoiceService.recordManualInvoice(id, body);
        break;
      case "waive":
        row = await campaignInvoiceService.waiveMonth(id, body.yearMonth, body.note);
        break;
      case "dismiss":
        row = await campaignInvoiceService.dismissMailInvoice(id, body.issueId, body.writtenDate);
        break;
      case "revert":
        row = await campaignInvoiceService.revertRow(id, body.rowId);
        break;
    }
    revalidateCampaignCaches();
    return NextResponse.json({ ok: true, row });
  } catch (error) {
    if (error instanceof CampaignInvoiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
