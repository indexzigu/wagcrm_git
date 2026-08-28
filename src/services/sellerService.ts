import { Prisma } from "@prisma/client";
import { sellerRepository } from "@/repositories/sellerRepository";
import { loadSellerSummaries } from "@/lib/seller-summary";
import { parseChannelUrl } from "@/lib/channel-url";
import { computeFitLevel } from "@/lib/seller-fit";
import { parseBulkSellerLines, BULK_SELLER_MAX } from "@/lib/bulk-seller-parse";
import { recordSellerFollowersSnapshot } from "@/lib/seller-history";
import { recordActivityCreate, recordActivityChange, recordActivityDelete, FIELD_LABELS, getCompareValue } from "@/lib/activity-log";
import { googleDriveProvider } from "@/lib/asset-storage";

// --- Custom Domain Errors ---

export class SellerNotFoundError extends Error {
  constructor(message = "해당 셀러를 찾을 수 없습니다") {
    super(message);
    this.name = "SellerNotFoundError";
  }
}

export class SellerDeletionBlockedError extends Error {
  constructor(message = "연결된 캠페인이 있어 삭제할 수 없습니다") {
    super(message);
    this.name = "SellerDeletionBlockedError";
  }
}

// --- Helpers ---

// --- Service ---

export const sellerService = {
  async getSellersList(params: {
    snsType?: string | null;
    category?: string | null;
    agencyId?: string | null;
    sortBy?: string | null;
    sortDir?: "asc" | "desc" | null;
  }) {
    const { snsType, category, agencyId, sortBy, sortDir } = params;

    const where: Prisma.SellerWhereInput = {};
    if (snsType) where.snsType = snsType;
    if (category) {
      where.categoryAssignments = { some: { category: { name: category } } };
    }
    if (agencyId) where.agencyId = agencyId;

    // 목록 갱신(GET /api/sellers)은 페이지 초기 로드와 반드시 같은 리치 SellerSummary를 반환해야
    // 한다 — 좁은 projection을 쓰면 갱신 시 aiComposite·acquisitionChannel이 사라진다. 단일 로더 사용.
    const orderBy: Prisma.SellerOrderByWithRelationInput | undefined = sortBy
      ? { [sortBy]: sortDir || "asc" }
      : undefined;

    return loadSellerSummaries({ where, orderBy });
  },

  async createSeller(
    input: {
      name: string;
      alias?: string | null;
      snsType: string;
      snsHandle: string;
      channelUrl?: string | null;
      currentFollowers?: number;
      category?: string | null;
      agencyId?: string | null;
      isMonitored?: boolean;
      // F6 outcome 적립: 유입 경로는 등록 시점에만 정확히 알 수 있다
      acquisitionChannel?: string | null;
      referredById?: string | null;
      acquisitionNote?: string | null;
    },
    actor: string
  ) {
    const candidate = { ...input };

    if (candidate.snsHandle && typeof candidate.snsHandle === "string") {
      candidate.snsHandle = candidate.snsHandle.trim().replace(/^@/, "");
    }

    const channelUrl =
      typeof candidate.channelUrl === "string" ? candidate.channelUrl.trim() : "";
    if (channelUrl.length > 0) {
      candidate.channelUrl = channelUrl;
    }

    const hasName =
      typeof candidate.name === "string" && candidate.name.trim().length > 0;
    const hasSnsType =
      typeof candidate.snsType === "string" && candidate.snsType.trim().length > 0;
    const hasSnsHandle =
      typeof candidate.snsHandle === "string" &&
      candidate.snsHandle.trim().length > 0;

    if (channelUrl && (!hasName || !hasSnsType || !hasSnsHandle)) {
      const parsedChannel = parseChannelUrl(channelUrl);
      if (!parsedChannel) {
        throw new Error("지원하지 않는 채널 URL 형식입니다. Instagram, YouTube 또는 X URL을 입력해주세요.");
      }

      if (!hasSnsType) candidate.snsType = parsedChannel.snsType;
      if (!hasSnsHandle) candidate.snsHandle = parsedChannel.snsHandle;
      if (!hasName) candidate.name = parsedChannel.snsHandle;
    }

    const seller = await sellerRepository.create({
      data: candidate as any,
    });

    await recordSellerFollowersSnapshot(seller.id, seller.currentFollowers, "INTERNAL");
    await recordActivityCreate("SELLER", seller.id, actor);

    // 구글 드라이브 폴더 비동기 생성 (실패해도 응답 흐름에 영향 없음)
    googleDriveProvider
      .createFolderForEntity({
        entityType: "SELLER",
        entityId: seller.id,
        entityName: seller.name,
        section: "ETC",
      })
      .catch((err) => {
        console.warn(`[sellers:POST] Pre-creating Google Drive folder skipped:`, err);
      });

    return seller;
  },

  /**
   * 발굴 셀러 대량 등록 — 자유 텍스트(URL/핸들 다건)를 파싱해 순차 생성한다.
   * 개별 행 단위로 성공/중복/실패를 격리 집계하므로 한 건 실패가 배치 전체를 무너뜨리지 않는다.
   * (팔로워·bio 등 지표 보강은 호출자가 생성 결과의 channelUrl로 백그라운드 스크래핑을 트리거한다.)
   */
  async createSellersBulk(
    rawText: string,
    opts: { isMonitored?: boolean },
    actor: string
  ) {
    const parsed = parseBulkSellerLines(rawText);

    const created: Array<Record<string, unknown>> = [];
    const duplicates: Array<{ raw: string; snsType?: string; snsHandle?: string; reason: string }> = [];
    const invalid: Array<{ raw: string; reason: string }> = [];

    // 정합성 미달·입력 내 중복은 즉시 분류.
    const creatable = parsed.filter((e) => {
      if (e.status === "invalid") {
        invalid.push({ raw: e.raw, reason: e.reason ?? "형식 오류" });
        return false;
      }
      if (e.status === "duplicate") {
        duplicates.push({
          raw: e.raw,
          snsType: e.snsType,
          snsHandle: e.snsHandle,
          reason: e.reason ?? "입력 내 중복",
        });
        return false;
      }
      return true;
    });

    // 상한 초과분은 조용히 버리지 않고 명시적으로 실패 표면화(P4 No silent caps).
    const overflow = creatable.slice(BULK_SELLER_MAX);
    for (const e of overflow) {
      invalid.push({
        raw: e.raw,
        reason: `1회 최대 ${BULK_SELLER_MAX}건 초과로 건너뜀`,
      });
    }
    const batch = creatable.slice(0, BULK_SELLER_MAX);

    // 커넥션 풀 고갈 방지를 위해 순차 처리.
    for (const entry of batch) {
      try {
        const seller = await this.createSeller(
          {
            name: entry.snsHandle!,
            snsType: entry.snsType!,
            snsHandle: entry.snsHandle!,
            channelUrl: entry.channelUrl,
            currentFollowers: 0,
            isMonitored: opts.isMonitored ?? false,
            // F6: 대량 발굴 유입은 등록 시점에 DISCOVERY로 태깅(소급 불가 데이터)
            acquisitionChannel: "DISCOVERY",
          },
          actor
        );
        created.push(seller as unknown as Record<string, unknown>);
      } catch (error) {
        const isUnique =
          (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") ||
          (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "P2002");
        if (isUnique) {
          duplicates.push({
            raw: entry.raw,
            snsType: entry.snsType,
            snsHandle: entry.snsHandle,
            reason: "이미 등록된 셀러",
          });
        } else {
          const message = error instanceof Error ? error.message : "생성 실패";
          invalid.push({ raw: entry.raw, reason: message });
        }
      }
    }

    return {
      created,
      duplicates,
      invalid,
      summary: {
        total: parsed.length,
        created: created.length,
        duplicates: duplicates.length,
        invalid: invalid.length,
      },
    };
  },

  async updateSeller(
    id: string,
    data: {
      name?: string;
      alias?: string | null;
      snsType?: string;
      snsHandle?: string;
      channelUrl?: string | null;
      currentFollowers?: number;
      category?: string | null;
      agencyId?: string | null;
      isMonitored?: boolean;
      fitLevel?: string | null;
      collaborationScore?: string | null;
      adResponseScore?: string | null;
      commentResponseScore?: string | null;
      activityFrequency?: string | null;
      lastReviewedAt?: Date | string | null;
      sourcingMemo?: string | null;
    },
    actor: string
  ) {
    const current = await sellerRepository.findUnique({
      where: { id },
    });
    if (!current) {
      throw new SellerNotFoundError();
    }

    const patchData = { ...data };

    if (patchData.snsHandle && typeof patchData.snsHandle === "string") {
      patchData.snsHandle = patchData.snsHandle.trim().replace(/^@/, "");
    }

    // 1. channelUrl 갱신 시 자동 파싱 적용
    if (patchData.channelUrl) {
      const parsedChannel = parseChannelUrl(patchData.channelUrl);
      if (parsedChannel) {
        if (!patchData.snsType) patchData.snsType = parsedChannel.snsType;
        if (!patchData.snsHandle) patchData.snsHandle = parsedChannel.snsHandle;
        if (!current.name || current.name === current.snsHandle) {
          patchData.name = parsedChannel.snsHandle;
        }
      }
    }

    // 2. 자동 합산점수 기반 fitLevel 갱신 로직 (규칙 SSOT: src/lib/seller-fit.ts)
    if (patchData.fitLevel !== undefined) {
      // 수동 지정 시 우회
    } else if (
      patchData.collaborationScore !== undefined ||
      patchData.adResponseScore !== undefined ||
      patchData.commentResponseScore !== undefined ||
      patchData.activityFrequency !== undefined
    ) {
      const calculatedFitLevel = computeFitLevel({
        collaborationScore: patchData.collaborationScore !== undefined ? patchData.collaborationScore : current.collaborationScore,
        adResponseScore: patchData.adResponseScore !== undefined ? patchData.adResponseScore : current.adResponseScore,
        commentResponseScore: patchData.commentResponseScore !== undefined ? patchData.commentResponseScore : current.commentResponseScore,
        activityFrequency: patchData.activityFrequency !== undefined ? patchData.activityFrequency : current.activityFrequency,
      });
      // 전부 미입력이면 null — fitLevel 자동 갱신 스킵 (미입력 ≠ 낙제)
      if (calculatedFitLevel !== null) {
        patchData.fitLevel = calculatedFitLevel;
      }
    }

    const updated = await sellerRepository.update({
      where: { id },
      data: patchData as any,
    });

    // 팔로워 수 업데이트 시 스냅샷 기록
    if (
      patchData.currentFollowers !== undefined &&
      patchData.currentFollowers !== current.currentFollowers
    ) {
      await recordSellerFollowersSnapshot(id, patchData.currentFollowers, "INTERNAL");
    }

    // 감사 로그 기록 — 원본 `data` 가 아니라 **실제로 저장한 `patchData`** 를 돈다.
    // 이 서비스는 저장 전에 값을 파생·정규화하므로(fitLevel 자동 재계산 · channelUrl 파싱 ·
    // snsHandle 의 @ 제거) 원본을 돌면 그 변경이 통째로 누락되고, snsHandle 은 저장되지도
    // 않은 원본 값이 기록된다. PATCH /api/sellers/[id] 는 파생값을 감사 대상 객체에 직접
    // 대입해 우연히 정합했고, 그래서 두 경로의 이력이 갈렸다.
    // 계약: sellerService.fitLevelAudit.contract.test.ts
    for (const key of Object.keys(patchData)) {
      const val = (patchData as Record<string, unknown>)[key];
      const curVal = (current as Record<string, unknown>)[key];
      if (getCompareValue(curVal) !== getCompareValue(val)) {
        const fieldLabel = FIELD_LABELS[key] || key;
        await recordActivityChange("SELLER", id, fieldLabel, curVal, val, actor);
      }
    }

    return updated;
  },

  async deleteSeller(id: string, actor: string) {
    const seller = await sellerRepository.findUnique({
      where: { id },
      include: { _count: { select: { campaigns: true } } },
    });

    if (!seller) {
      throw new SellerNotFoundError();
    }

    if (seller._count.campaigns > 0) {
      throw new SellerDeletionBlockedError();
    }

    await recordActivityDelete("SELLER", id, actor);
    await sellerRepository.delete(id);

    return { ok: true };
  },
};
