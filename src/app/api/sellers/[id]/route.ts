import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { updateSellerSchema } from "@/lib/validations/seller";
import { recordActivityDelete } from "@/lib/activity-log";
import { getAuthContext } from "@/lib/auth-context";
import { revalidateMasterDataCaches } from "@/lib/cache-tags";
import { decryptOrNull } from "@/lib/encryption";
import { applySellerPatch } from "@/services/sellerPatchService";

type Context = {
  params: Promise<{ id: string }>;
};

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;

  const body = await request.json();
  const parsed = updateSellerSchema.safeParse(body);
  if (!parsed.success) {
    // ⛔ 요청 바디를 통째로 찍지 말 것(P0) — `updateSellerSchema` 는 주민등록번호·
    // 계좌번호·법적 실명·연락처를 받는다. 이 값들은 DB 에 암호화·마스킹되어 들어가는데
    // 로그로 나가면 평문 그대로 남는다(셀프호스트는 `logs/app.out.log` 로 영구 적재).
    // 진단에 필요한 것은 "어떤 키가 왔고 무엇이 규칙을 어겼나"이지 값이 아니다 —
    // 키 이름은 스키마에 이미 공개돼 있으므로 fail-closed 로 그것만 남긴다.
    console.error("[PATCH /api/sellers/[id]] Zod validation error:", {
      keys: Object.keys(body ?? {}),
      issues: parsed.error.flatten(),
    });
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const auth = await getAuthContext();
  const actor = auth?.email ?? "SYSTEM";

  // 본체(자동 파싱·적합성 판정·암호화·감사 기록·저장)는 `applySellerPatch` 가 소유한다 —
  // 에이전트 `update_record` 승인 실행이 같은 함수를 탄다. 라우트는 캐시·응답만 한다.
  const outcome = await applySellerPatch({ id, data: parsed.data, actor });
  if (outcome.kind === "error") {
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }
  const updated = outcome.updated;

  revalidateMasterDataCaches();

  // Decrypt residentNumber for response JSON
  //
  // ⚠️ `decrypt()` 로 되돌리지 말 것 (2026-08-12 실사고의 잔여 구멍). 이 줄은 **이미
  // 커밋된 쓰기의 메아리**를 만들 뿐인데, 던지면 저장이 끝난 뒤 500 이 나가고 열리지
  // 않는 값을 가진 셀러는 *다른 필드조차* 고칠 수 없게 된다 — #382 가 감사 로그 경로에서
  // 막은 것과 같은 피해다("부가 기능이 주 기능을 죽여서는 안 된다"). 못 연 값은 빈칸으로
  // 나가고(암호문이 화면에 새지 않는다) 실패는 경고로 남는다.
  if (updated && updated.residentNumber) {
    updated.residentNumber = decryptOrNull(updated.residentNumber);
  }

  return NextResponse.json(updated);
}

export async function DELETE(_request: Request, context: Context) {
  const { id } = await context.params;

  // Check if seller exists
  const seller = await getPrisma().seller.findUnique({
    where: { id },
    include: { _count: { select: { campaigns: true } } },
  });

  if (!seller) {
    return NextResponse.json({ error: "해당 셀러를 찾을 수 없습니다" }, { status: 404 });
  }

  // Check for linked campaigns
  if (seller._count.campaigns > 0) {
    return NextResponse.json(
      { error: "연결된 캠페인이 있어 삭제할 수 없습니다" },
      { status: 409 },
    );
  }

  const auth = await getAuthContext();
  const actor = auth?.email ?? "SYSTEM";
  await recordActivityDelete("SELLER", id, actor);

  // Delete the seller
  await getPrisma().seller.delete({ where: { id } });

  revalidateMasterDataCaches();

  return NextResponse.json({ ok: true });
}
