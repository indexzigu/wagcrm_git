import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getPrisma } from "../src/lib/prisma";

type PlanAction =
  | "seller-merge"
  | "seller-create"
  | "deal-merge"
  | "deal-create-separate"
  | "campaign-create-normalized";

type PlanRow = {
  sourceKey: string;
  action: PlanAction;
  entity: "seller" | "deal" | "campaign";
  reference: string;
  payload: Record<string, string>;
};

type DecisionPlan = {
  generatedAt: string;
  counts: {
    plan: number;
    pending: number;
    invalid: number;
  };
  planRows: PlanRow[];
};

function getArg(flag: string) {
  return process.argv.includes(flag);
}

function getTarget() {
  const targetArg = process.argv.find((arg) => arg.startsWith("--target="));
  return (targetArg ? targetArg.slice("--target=".length) : "local").toLowerCase();
}

function readPlan() {
  const planPath = join(process.cwd(), "artifacts/notion-import-decision-plan.json");
  const raw = readFileSync(planPath, "utf8");
  return JSON.parse(raw) as DecisionPlan;
}

function rowHash(planRow: PlanRow) {
  return createHash("sha256").update(JSON.stringify(planRow)).digest("hex");
}

function toNullableString(value: unknown) {
  if (value == null) return null;
  const normalized = String(value).replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function parseDateToUtc(dateValue: string | null) {
  if (!dateValue) return null;
  const normalized = dateValue.trim();
  const slashMatch = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (slashMatch) {
    const [, year, month, day] = slashMatch;
    return new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00.000Z`);
  }
  const isoMatch = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00.000Z`);
  }
  const koreanMatch = normalized.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  if (koreanMatch) {
    const [, year, month, day] = koreanMatch;
    return new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00.000Z`);
  }
  return null;
}

function parseScheduleRange(rawSchedule: string | null) {
  if (!rawSchedule) return null;
  const normalized = rawSchedule.replace(/\s+/g, "");
  const rangeMatch = normalized.match(
    /(\d{4}[/-]\d{1,2}[/-]\d{1,2})[~→\-](\d{4}[/-]\d{1,2}[/-]\d{1,2})/,
  );
  if (rangeMatch) {
    const start = parseDateToUtc(rangeMatch[1]!.replace(/\//g, "-"));
    const end = parseDateToUtc(rangeMatch[2]!.replace(/\//g, "-"));
    if (start && end) return { start, end };
  }
  const singleDate = normalized.match(/(\d{4}[/-]\d{1,2}[/-]\d{1,2})/);
  if (singleDate) {
    const date = parseDateToUtc(singleDate[1]!.replace(/\//g, "-"));
    if (date) return { start: date, end: date };
  }
  return null;
}

function parseJsonObject(value: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractString(record: Record<string, unknown> | null, keys: string[]) {
  if (!record) return null;
  for (const key of keys) {
    const value = toNullableString(record[key]);
    if (value) return value;
  }
  return null;
}

function toNonEmpty(value: string | undefined) {
  const normalized = (value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

async function resolveSellerId(
  prisma: ReturnType<typeof getPrisma>,
  requestedId: string,
  sellerName: string,
) {
  if (requestedId) {
    const byId = await prisma.seller.findUnique({
      where: { id: requestedId },
      select: { id: true },
    });
    if (byId) return byId.id;
  }
  if (!sellerName) return null;
  const byName = await prisma.seller.findFirst({
    where: { name: sellerName },
    select: { id: true },
  });
  return byName?.id ?? null;
}

async function resolveDealId(
  prisma: ReturnType<typeof getPrisma>,
  requestedId: string,
  dealName: string,
) {
  if (requestedId) {
    const byId = await prisma.deal.findUnique({
      where: { id: requestedId },
      select: { id: true },
    });
    if (byId) return byId.id;
  }
  if (!dealName) return null;
  const byName = await prisma.deal.findMany({
    where: { dealName },
    select: { id: true },
    take: 2,
  });
  if (byName.length === 1) return byName[0]!.id;
  return null;
}

async function main() {
  const applyMode = getArg("--apply");
  const target = getTarget();
  if (target === "local") {
    process.env.DATABASE_URL = "file:./dev.db";
    process.env.DIRECT_URL = "";
  } else if ((process.env.DIRECT_URL ?? "").trim()) {
    process.env.DATABASE_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  }

  const plan = readPlan();
  const prisma = getPrisma();
  const artifactDir = join(process.cwd(), "artifacts");
  const artifactPath = join(
    artifactDir,
    `notion-decision-${applyMode ? "apply" : "dry-run"}-${target}.json`,
  );

  const summary = {
    mode: applyMode ? "apply" : "dry-run",
    target,
    generatedAt: new Date().toISOString(),
    planGeneratedAt: plan.generatedAt,
    planCount: plan.counts.plan,
    pendingCount: plan.counts.pending,
    invalidCount: plan.counts.invalid,
    executed: {
      sellerMerged: 0,
      sellerCreated: 0,
      dealMerged: 0,
      dealCreated: 0,
      campaignCreated: 0,
      skipped: 0,
      failed: 0,
    },
    failures: [] as Array<{ sourceKey: string; action: string; reason: string }>,
  };

  if (!applyMode) {
    writeFileSync(artifactPath, `${JSON.stringify({ ...summary, planRows: plan.planRows }, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, artifactPath, ...summary }, null, 2));
    await prisma.$disconnect();
    return;
  }

  if (plan.planRows.length === 0) {
    const skippedPayload = {
      ...summary,
      skippedApply: true,
      reason: "planRows-empty",
      planRows: plan.planRows,
    };
    writeFileSync(artifactPath, `${JSON.stringify(skippedPayload, null, 2)}\n`);
    console.log(
      JSON.stringify(
        {
          ok: true,
          artifactPath,
          ...skippedPayload,
        },
        null,
        2,
      ),
    );
    await prisma.$disconnect();
    return;
  }

  const batch = await prisma.importBatch.create({
    data: {
      sourceSystem: "NOTION",
      targetDatabase: target.toUpperCase(),
      mode: "DECISION_APPLY",
      status: "RUNNING",
      summary: "Notion decision plan apply",
    },
  });

  for (const planRow of plan.planRows) {
    try {
      if (planRow.action === "seller-merge") {
        const sellerId = planRow.payload.existingSellerId;
        if (!sellerId) throw new Error("missing existingSellerId");
        const nextPlatform = toNonEmpty(planRow.payload.confirmedPlatform);
        const nextHandle = toNonEmpty(planRow.payload.confirmedHandle);
        const nextChannelUrl = toNonEmpty(planRow.payload.confirmedChannelUrl);
        const nextNotes = toNonEmpty(planRow.payload.notes);

        const sellerUpdateData: {
          snsType?: string;
          snsHandle?: string;
          channelUrl?: string;
          notes?: string;
        } = {};
        if (nextPlatform) sellerUpdateData.snsType = nextPlatform.toUpperCase();
        if (nextHandle) sellerUpdateData.snsHandle = nextHandle;
        if (nextChannelUrl) sellerUpdateData.channelUrl = nextChannelUrl;
        if (nextNotes) sellerUpdateData.notes = nextNotes;

        if (Object.keys(sellerUpdateData).length === 0) {
          summary.executed.skipped += 1;
          continue;
        }

        await prisma.seller.update({
          where: { id: sellerId },
          data: sellerUpdateData,
        });
        summary.executed.sellerMerged += 1;
      } else if (planRow.action === "seller-create") {
        const snsType = (planRow.payload.confirmedPlatform || "INSTAGRAM").toUpperCase();
        const snsHandle = planRow.payload.confirmedHandle;
        const existingSeller = await prisma.seller.findFirst({
          where: {
            OR: [{ snsType, snsHandle }, { name: planRow.reference }],
          },
          select: { id: true },
        });
        if (existingSeller) {
          summary.executed.skipped += 1;
          continue;
        }

        await prisma.seller.create({
          data: {
            name: planRow.reference,
            snsType,
            snsHandle,
            channelUrl: planRow.payload.confirmedChannelUrl || null,
            currentFollowers: 0,
            notes: planRow.payload.notes || null,
          },
        });
        summary.executed.sellerCreated += 1;
      } else if (planRow.action === "deal-merge") {
        const requestedDealId = planRow.payload.existingDealId;
        const requestedDealName =
          toNonEmpty(planRow.payload.dealName) ??
          toNonEmpty(planRow.reference.split("/").pop()?.trim()) ??
          "";
        const dealId = await resolveDealId(prisma, requestedDealId ?? "", requestedDealName);
        if (!dealId) {
          throw new Error("unable to resolve dealId for local/target database");
        }
        const nextPartnerName = toNonEmpty(planRow.payload.confirmedPartnerName);
        const nextBrandName = toNonEmpty(planRow.payload.confirmedBrandName);
        const nextNotes = toNonEmpty(planRow.payload.notes);

        const dealUpdateData: {
          partnerCompanyName?: string;
          brandName?: string;
          sourcingMemo?: string;
        } = {};
        if (nextPartnerName) dealUpdateData.partnerCompanyName = nextPartnerName;
        if (nextBrandName) dealUpdateData.brandName = nextBrandName;
        if (nextNotes) dealUpdateData.sourcingMemo = nextNotes;

        if (Object.keys(dealUpdateData).length === 0) {
          summary.executed.skipped += 1;
          continue;
        }

        await prisma.deal.update({
          where: { id: dealId },
          data: dealUpdateData,
        });
        summary.executed.dealMerged += 1;
      } else if (planRow.action === "deal-create-separate") {
        const partnerName = planRow.payload.confirmedPartnerName;
        if (!partnerName) throw new Error("missing confirmedPartnerName");
        const partner = await prisma.partner.findFirst({ where: { name: partnerName } });
        if (!partner) throw new Error(`partner not found: ${partnerName}`);
        const dealName = planRow.reference.split("/").pop()?.trim() ?? planRow.reference;
        const existingSeparateDeal = await prisma.deal.findFirst({
          where: {
            partnerId: partner.id,
            dealName,
          },
          select: { id: true },
        });
        if (existingSeparateDeal) {
          summary.executed.skipped += 1;
          continue;
        }
        await prisma.deal.create({
          data: {
            dealName,
            partnerId: partner.id,
            baseMarginPolicy: JSON.stringify({
              byChannel: {
                OWN_MALL: { totalMarginRate: 0, sellerMarginRate: 0 },
                SELLER_MALL: { totalMarginRate: 0, sellerMarginRate: 0 },
                BRAND_MALL: { totalMarginRate: 0, sellerMarginRate: 0 },
              },
            }),
            status: "SOURCING",
            brandName: planRow.payload.confirmedBrandName || null,
            partnerCompanyName: partnerName,
            sourcingMemo: planRow.payload.notes || null,
          },
        });
        summary.executed.dealCreated += 1;
      } else if (planRow.action === "campaign-create-normalized") {
        const sellerId = await resolveSellerId(
          prisma,
          planRow.payload.normalizedSellerId,
          planRow.payload.sellerName,
        );
        const dealId = await resolveDealId(
          prisma,
          planRow.payload.normalizedDealId,
          planRow.payload.dealName,
        );
        if (!sellerId || !dealId) {
          throw new Error("unable to resolve sellerId or dealId for local/target database");
        }

        const existingCampaign = await prisma.salesCampaign.findFirst({
          where: {
            sellerId,
            dealId,
            salesCode: planRow.payload.normalizedSalesCode || planRow.reference,
          },
          select: { id: true },
        });
        if (existingCampaign) {
          summary.executed.skipped += 1;
          continue;
        }

        const reviewRecord = await prisma.importSourceRecord.findFirst({
          where: {
            sourceTable: "campaigns",
            sourceKey: planRow.sourceKey,
            action: "REVIEW",
          },
          orderBy: { createdAt: "desc" },
          select: {
            rawPayload: true,
            normalizedData: true,
          },
        });

        const rawPayload = parseJsonObject(reviewRecord?.rawPayload ?? null);
        const normalizedData = parseJsonObject(reviewRecord?.normalizedData ?? null);

        const rawSchedule =
          extractString(normalizedData, ["rawSchedule"]) ??
          extractString(rawPayload, ["진행일정", "rawSchedule"]);
        const sourceCreatedAt =
          extractString(normalizedData, ["sourceCreatedAt"]) ??
          extractString(rawPayload, ["생성 일시", "sourceCreatedAt"]);
        const scheduleRange = parseScheduleRange(rawSchedule);
        const sourceCreatedAtDate = parseDateToUtc(sourceCreatedAt);
        const fallbackDate = sourceCreatedAtDate ?? new Date();

        const salesChannel =
          extractString(normalizedData, ["salesChannel"]) ??
          extractString(rawPayload, ["판매채널", "채널", "salesChannel"]) ??
          "SELLER_MALL";
        const baseNaverLink =
          extractString(rawPayload, ["기본 네이버링크", "기본 네이버 링크", "baseNaverLink"]) ??
          "https://example.com";
        const generatedTrackingLink =
          extractString(rawPayload, ["생성 링크", "생성링크", "generatedTrackingLink"]) ??
          baseNaverLink;

        await prisma.salesCampaign.create({
          data: {
            sellerId,
            dealId,
            salesCode: planRow.payload.normalizedSalesCode || planRow.reference,
            startDate: scheduleRange?.start ?? fallbackDate,
            endDate: scheduleRange?.end ?? scheduleRange?.start ?? fallbackDate,
            salesChannel,
            baseNaverLink,
            generatedTrackingLink,
            // 🪤 `targetSales: 0` 이 있었다. 그 필드는 「목표 매출 제거」 작업에서
            //    **스키마째 사라졌는데**(`docs/private/kiro/specs/ux-fixes-and-field-editing`
            //    Requirement 4) 이 스크립트만 계속 넣고 있었다 — 실행하면 Prisma 가
            //    거부하는 상태였다. `scripts/` 가 타입체크 밖이라 아무도 몰랐다
            //    (2026-08-07 발견). 값이 0 이었으므로 줄만 지우면 동작이 복원된다.
            totalMarginRate: 0,
            sellerMarginRate: 0,
            netMarginRate: 0,
            status: "PROPOSAL",
            rawSchedule,
            sourceCreatedAt: sourceCreatedAtDate,
            notesFromImport: planRow.payload.notes || null,
          },
        });
        summary.executed.campaignCreated += 1;
      } else {
        summary.executed.skipped += 1;
      }

      await prisma.importSourceRecord.create({
        data: {
          batchId: batch.id,
          sourceTable: "decision_plan",
          sourceKey: planRow.sourceKey,
          rowHash: rowHash(planRow),
          action: "APPLY",
          targetEntity: planRow.entity.toUpperCase(),
          reviewReason: null,
          rawPayload: JSON.stringify(planRow),
          normalizedData: JSON.stringify(planRow.payload),
        },
      });
    } catch (error) {
      summary.executed.failed += 1;
      summary.failures.push({
        sourceKey: planRow.sourceKey,
        action: planRow.action,
        reason: error instanceof Error ? error.message : "unknown error",
      });
      await prisma.importSourceRecord.create({
        data: {
          batchId: batch.id,
          sourceTable: "decision_plan",
          sourceKey: planRow.sourceKey,
          rowHash: rowHash(planRow),
          action: "REVIEW",
          targetEntity: planRow.entity.toUpperCase(),
          reviewReason: "decision-apply-failed",
          rawPayload: JSON.stringify(planRow),
          normalizedData: JSON.stringify({
            error: error instanceof Error ? error.message : "unknown error",
          }),
        },
      });
    }
  }

  await prisma.importBatch.update({
    where: { id: batch.id },
    data: {
      status: summary.executed.failed > 0 ? "COMPLETED_WITH_REVIEW" : "COMPLETED",
      finishedAt: new Date(),
      summary: JSON.stringify(summary.executed),
    },
  });

  writeFileSync(
    artifactPath,
    `${JSON.stringify({ ...summary, batchId: batch.id, planRows: plan.planRows }, null, 2)}\n`,
  );
  console.log(JSON.stringify({ ok: true, artifactPath, batchId: batch.id, ...summary }, null, 2));
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
