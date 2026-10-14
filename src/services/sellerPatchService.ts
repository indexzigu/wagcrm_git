/**
 * 셀러 수정(`PATCH /api/sellers/[id]`)의 **본체** — 라우트에서 옮겨 왔다(동작 그대로).
 *
 * 두 호출부가 같은 함수를 탄다: 화면 저장 라우트(트랜잭션 없음)와 에이전트 `update_record` 승인
 * 실행(승인 트랜잭션을 `tx` 로 넘긴다 — 저장·감사 기록이 기안 EXECUTED 전이와 함께 커밋/롤백된다).
 *
 * ⛔ 캐시 무효화·응답 복호화는 여기서 하지 않는다 — 라우트(커밋 뒤)와 에이전트 effects 명세가 한다.
 * ⚠️ 팔로워 수(`currentFollowers`)의 이력 스냅샷 writer(`recordSellerFollowersSnapshot`)는 트랜잭션을
 *    받지 못한다(수집기 공용 경로). 그래서 `tx` 로 부를 때 팔로워 수를 바꾸면 반쪽 커밋이 되므로
 *    거절한다 — 에이전트 쪽은 그 칸을 애초에 기안 대상에서 뺀다(`record-update-entities.ts`).
 */
import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { recordActivityChange, FIELD_LABELS, getCompareValue } from "@/lib/activity-log";
import { recordSellerFollowersSnapshot } from "@/lib/seller-history";
import { parseChannelUrl } from "@/lib/channel-url";
import { computeFitLevel } from "@/lib/seller-fit";
import { encrypt } from "@/lib/encryption";
import { buildResidentNumberAuditEntry } from "@/lib/resident-number-audit";
import type { UpdateSellerInput } from "@/lib/validations/seller";

export type SellerPatchOutcome =
  | { kind: "error"; status: number; error: string }
  | { kind: "ok"; updated: Awaited<ReturnType<ReturnType<typeof getPrisma>["seller"]["update"]>> };

export async function applySellerPatch(params: {
  id: string;
  data: UpdateSellerInput;
  actor: string;
  tx?: Prisma.TransactionClient;
}): Promise<SellerPatchOutcome> {
  const { id, data, actor, tx } = params;
  const prisma = tx ?? getPrisma();

  // Fetch current seller to compare field changes
  const current = await prisma.seller.findUnique({ where: { id } });
  if (!current) {
    return { kind: "error", status: 404, error: "해당 셀러를 찾을 수 없습니다" };
  }

  const followersChanged =
    data.currentFollowers !== undefined && data.currentFollowers !== current.currentFollowers;
  if (tx && followersChanged) {
    throw new Error("팔로워 수 변경은 이력 스냅샷 기록이 트랜잭션을 받지 못해 이 경로로 처리할 수 없습니다.");
  }

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
  const auditLogsToRecord: Array<{ fieldLabel: string; curVal: unknown; val: unknown }> = [];

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
      return { kind: "error", status: 400, error: "자기 자신을 소개자로 지정할 수 없습니다" };
    }
    const referrer = await prisma.seller.findUnique({
      where: { id: data.referredById },
      select: { id: true },
    });
    if (!referrer) {
      return { kind: "error", status: 400, error: "소개자로 지정한 셀러를 찾을 수 없습니다" };
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
    updated = await prisma.seller.update({
      where: { id },
      data: updateData,
    });
  } catch (error) {
    const isUniqueConstraintError =
      (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") ||
      (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "P2002");

    if (isUniqueConstraintError) {
      return { kind: "error", status: 409, error: "이미 존재하는 셀러입니다" };
    }
    throw error;
  }

  // If followers count is updated, record history snapshot
  if (followersChanged) {
    await recordSellerFollowersSnapshot(id, data.currentFollowers!, "INTERNAL");
  }

  // Record audit logs
  for (const log of auditLogsToRecord) {
    await recordActivityChange("SELLER", id, log.fieldLabel, log.curVal, log.val, actor, tx);
  }

  return { kind: "ok", updated };
}
