import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { updateSellerSchema } from "@/lib/validations/seller";
import { Prisma } from "@prisma/client";
import { recordActivityChange, recordActivityDelete, FIELD_LABELS, getCompareValue } from "@/lib/activity-log";
import { getAuthContext } from "@/lib/auth-context";
import { recordSellerFollowersSnapshot } from "@/lib/seller-history";
import { revalidateMasterDataCaches } from "@/lib/cache-tags";
import { parseChannelUrl } from "@/lib/channel-url";
import { computeFitLevel } from "@/lib/seller-fit";
import { encrypt, decryptOrNull } from "@/lib/encryption";
import { buildResidentNumberAuditEntry } from "@/lib/resident-number-audit";

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

  // Fetch current seller to compare field changes
  const current = await getPrisma().seller.findUnique({ where: { id } });
  if (!current) {
    return NextResponse.json({ error: "해당 셀러를 찾을 수 없습니다" }, { status: 404 });
  }

  const data = parsed.data;

  if (data.snsHandle && typeof data.snsHandle === "string") {
    data.snsHandle = data.snsHandle.trim().replace(/^@/, "");
  }

  // 1. channelUrl이 유입되었을 때 SNS 유형과 핸들을 자동 파싱하여 갱신
  if (data.channelUrl) {
    const parsedChannel = parseChannelUrl(data.channelUrl);
    if (parsedChannel) {
      // 바디에 명시적으로 snsType/snsHandle이 들어오지 않은 경우에만 자동 파싱 적용
      if (!data.snsType) {
        data.snsType = parsedChannel.snsType;
      }
      if (!data.snsHandle) {
        data.snsHandle = parsedChannel.snsHandle;
      }
      if (!current.name || current.name === current.snsHandle) {
        data.name = parsedChannel.snsHandle;
      }
    }
  }

  // 2. 자동 합산점수 기반 fitLevel 갱신 로직 (규칙 SSOT: src/lib/seller-fit.ts — sellerService와 공용)
  // 사용자가 적합성을 수동으로 명시 변경하는 경우 -> 자동 계산 우회
  if (data.fitLevel !== undefined) {
    // 자동 계산 없이 data.fitLevel 값 그대로 업데이트 진행
  }
  // 사용자가 점수만 변경하고 적합성은 수동으로 보내지 않은 경우 -> 점수 합산에 따른 자동 판정 적용
  else if (
    data.collaborationScore !== undefined ||
    data.adResponseScore !== undefined ||
    data.commentResponseScore !== undefined ||
    data.activityFrequency !== undefined
  ) {
    const calculatedFitLevel = computeFitLevel({
      collaborationScore: data.collaborationScore !== undefined ? data.collaborationScore : current.collaborationScore,
      adResponseScore: data.adResponseScore !== undefined ? data.adResponseScore : current.adResponseScore,
      commentResponseScore: data.commentResponseScore !== undefined ? data.commentResponseScore : current.commentResponseScore,
      activityFrequency: data.activityFrequency !== undefined ? data.activityFrequency : current.activityFrequency,
    });
    // 전부 미입력이면 null — fitLevel 자동 갱신 스킵 (미입력 ≠ 낙제)
    if (calculatedFitLevel !== null) {
      data.fitLevel = calculatedFitLevel;
    }
  }

  // Compare values before encrypting data for DB update
  const auditLogsToRecord: Array<{ fieldLabel: string; curVal: any; val: any }> = [];
  const auth = await getAuthContext();
  const actor = auth?.email ?? "SYSTEM";

  for (const key of Object.keys(data)) {
    const val = (data as Record<string, unknown>)[key];
    const curVal = (current as Record<string, unknown>)[key];
    
    if (key === "residentNumber") {
      // 이전 값이 현재 키로 안 열려도 던지지 않는다 — 감사 로그가 저장을 막으면
      // 고장난 값을 고칠 방법 자체가 사라진다(2026-08-13 실사고). 상세는 해당 모듈.
      const entry = buildResidentNumberAuditEntry(curVal as string | null, val as string | null);
      if (entry) auditLogsToRecord.push(entry);
    } else {
      if (getCompareValue(curVal) !== getCompareValue(val)) {
        const fieldLabel = FIELD_LABELS[key] || key;
        auditLogsToRecord.push({ fieldLabel, curVal, val });
      }
    }
  }

  // Encrypt residentNumber for DB save
  if (data.residentNumber) {
    data.residentNumber = encrypt(data.residentNumber);
  }

  // F6: 소개자(referredById)는 실존 셀러만, 자기 자신 금지
  if (data.referredById) {
    if (data.referredById === id) {
      return NextResponse.json({ error: "자기 자신을 소개자로 지정할 수 없습니다" }, { status: 400 });
    }
    const referrer = await getPrisma().seller.findUnique({
      where: { id: data.referredById },
      select: { id: true },
    });
    if (!referrer) {
      return NextResponse.json({ error: "소개자로 지정한 셀러를 찾을 수 없습니다" }, { status: 400 });
    }
  }

  // F6: 가용 일정은 셀러에게 직접 확인한 시점을 함께 남긴다 — 변경 시 서버가 자동 스탬프
  const updateData: Record<string, unknown> = { ...data };
  if (
    data.availabilityNote !== undefined &&
    getCompareValue(current.availabilityNote) !== getCompareValue(data.availabilityNote)
  ) {
    updateData.availabilityUpdatedAt = new Date();
  }

  // Update the seller record
  let updated;
  try {
    updated = await getPrisma().seller.update({
      where: { id },
      data: updateData,
    });
  } catch (error) {
    const isUniqueConstraintError =
      (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") ||
      (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "P2002");

    if (isUniqueConstraintError) {
      return NextResponse.json(
        { error: "이미 존재하는 셀러입니다" },
        { status: 409 },
      );
    }
    throw error;
  }

  // If followers count is updated, record history snapshot
  if (
    body.currentFollowers !== undefined &&
    body.currentFollowers !== current.currentFollowers
  ) {
    await recordSellerFollowersSnapshot(id, body.currentFollowers, "INTERNAL");
  }

  // Record audit logs
  for (const log of auditLogsToRecord) {
    await recordActivityChange("SELLER", id, log.fieldLabel, log.curVal, log.val, actor);
  }

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
