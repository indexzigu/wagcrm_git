import { NextResponse } from "next/server";
import { z } from "zod";
import { getPrisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";
import { getAuthContext } from "@/lib/auth-context";
import { PartnerService } from "@/services/partnerService";
import { readAssetBytes, storeOrderTemplateSnapshot } from "@/lib/asset-storage";
import { orderExcelRulesSchema, stripPreviousSlot } from "@/lib/order-converter/excel-rules";

// F4 Phase 2 §4단계 — 열 매핑 규칙 확정(저장)/되돌리기/삭제.
// 일반 거래처 PATCH와 분리된 단일 쓰기 경로: previous 슬롯(D10)·fill-template 템플릿
// 스냅샷 복사(D4)·활동기록 부수효과를 서버가 소유한다.

type Context = {
  params: Promise<{ id: string }>;
};

const confirmBodySchema = z.union([
  z.object({ restorePrevious: z.literal(true) }),
  z.object({ rules: orderExcelRulesSchema }),
]);

export async function POST(request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;
  const authCtx = await getAuthContext();
  const actor = authCtx?.email ?? "SYSTEM";

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문이 JSON이 아닙니다." }, { status: 400 });
  }
  const parsed = confirmBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    if ("restorePrevious" in parsed.data) {
      const updated = await PartnerService.restorePartnerOrderRules(id, actor);
      return NextResponse.json({ ok: true, orderExcelRules: updated.orderExcelRules });
    }

    // 서버가 previous 슬롯을 소유 — 클라이언트가 보낸 previous는 폐기
    const rules = stripPreviousSlot(parsed.data.rules);

    // D4: fill-template 확정은 템플릿 스냅샷 복사가 선행돼야 한다 —
    // 생성 경로를 자산 레코드 수명(삭제/교체)·provider 비결정성과 분리.
    if (rules.write.mode === "fill-template" && !rules.templateStoragePath) {
      if (!rules.sourceAssetId) {
        return NextResponse.json(
          { error: "'양식 채움' 모드는 분석 원본 양식이 필요합니다. 발주서 양식을 다시 분석해 확정하세요." },
          { status: 400 }
        );
      }
      const asset = await getPrisma().asset.findUnique({ where: { id: rules.sourceAssetId } });
      if (!asset) {
        return NextResponse.json(
          { error: "분석했던 발주서 양식 자산을 찾을 수 없습니다. 양식을 다시 분석해 확정하세요." },
          { status: 409 }
        );
      }
      try {
        const bytes = await readAssetBytes(asset);
        rules.templateStoragePath = await storeOrderTemplateSnapshot(id, bytes);
      } catch (error: any) {
        console.error("[order-rules] 템플릿 스냅샷 복사 실패:", error);
        return NextResponse.json(
          { error: `발주서 양식 스냅샷 저장에 실패했습니다: ${error?.message ?? "저장소 오류"}` },
          { status: 502 }
        );
      }
    }

    const updated = await PartnerService.savePartnerOrderRules(id, rules, actor);
    return NextResponse.json({ ok: true, orderExcelRules: updated.orderExcelRules });
  } catch (error: any) {
    console.error("[order-rules] 저장 실패:", error);
    return NextResponse.json({ error: error?.message ?? "매핑 규칙 저장에 실패했습니다." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;
  const authCtx = await getAuthContext();
  const actor = authCtx?.email ?? "SYSTEM";

  try {
    await PartnerService.deletePartnerOrderRules(id, actor);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("[order-rules] 삭제 실패:", error);
    return NextResponse.json({ error: error?.message ?? "매핑 규칙 삭제에 실패했습니다." }, { status: 500 });
  }
}
