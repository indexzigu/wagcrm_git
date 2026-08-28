import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import { PrismaClient } from "@prisma/client";
import {
  extractRelationTitles,
  normalizeKey,
  toNullableString,
} from "../src/lib/notion-import/normalize";

type ReviewType = "seller" | "deal" | "campaign";

type BacklogCsvRow = {
  reviewType: ReviewType;
  batchId: string;
  sourceTable: string;
  sourceKey: string;
  reviewReason: string;
  sellerName: string;
  dealName: string;
  partnerOrBrand: string;
  salesCode: string;
  rawSchedule: string;
  sourceCreatedAt: string;
  candidateId: string;
  candidateLabel: string;
  candidateReason: string;
  suggestedAction: string;
};

type SellerCandidate = {
  id: string;
  name: string;
  snsHandle: string;
};

type DealCandidate = {
  id: string;
  name: string;
  label: string;
  partnerName: string;
};

type ReviewRecord = {
  batchId: string;
  sourceTable: string;
  sourceKey: string;
  reviewReason: string | null;
  rawPayload: string | null;
  normalizedData: string | null;
};

type SellerRecord = {
  id: string;
  name: string;
  snsHandle: string;
};

type DealRecord = {
  id: string;
  dealName: string;
  brandName: string | null;
  partner: { name: string } | null;
};

type LoadedBacklog = {
  latestBatchId: string;
  reviewRecords: ReviewRecord[];
  sellers: SellerRecord[];
  deals: DealRecord[];
  connectionMode: "default" | "direct-fallback";
};

function bestStringMatch<T extends { name: string }>(
  value: string | null | undefined,
  candidates: T[],
): T | null {
  if (!value) return null;
  const key = normalizeKey(value);
  return candidates.find((candidate) => normalizeKey(candidate.name) === key) ?? null;
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  return JSON.parse(value) as T;
}

function relationOrString(value: unknown): string {
  if (typeof value !== "string") return "";
  const titles = extractRelationTitles(value);
  if (titles.length > 0) {
    return titles[0] ?? "";
  }
  return toNullableString(value) ?? "";
}

function inferReviewType(sourceTable: string): ReviewType {
  if (sourceTable === "sellers") return "seller";
  if (sourceTable === "deals") return "deal";
  return "campaign";
}

function isConnectivityError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Can't reach database server") ||
    message.includes("Timed out fetching a new connection") ||
    message.includes("Connection terminated unexpectedly") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ENOTFOUND")
  );
}

async function loadBacklogWithPrisma(
  prisma: PrismaClient,
  connectionMode: LoadedBacklog["connectionMode"],
) {
  const latestBatch = await prisma.importBatch.findFirst({
    where: {
      sourceSystem: "NOTION",
      targetDatabase: "REMOTE",
      mode: "APPLY",
    },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });

  if (!latestBatch) {
    throw new Error("No remote apply import batch found");
  }

  const [reviewRecords, sellers, deals] = await Promise.all([
    prisma.importSourceRecord.findMany({
      where: {
        batchId: latestBatch.id,
        action: "REVIEW",
      },
      orderBy: [{ sourceTable: "asc" }, { sourceKey: "asc" }],
      select: {
        batchId: true,
        sourceTable: true,
        sourceKey: true,
        reviewReason: true,
        rawPayload: true,
        normalizedData: true,
      },
    }),
    prisma.seller.findMany({
      select: { id: true, name: true, snsHandle: true },
      orderBy: { name: "asc" },
    }),
    prisma.deal.findMany({
      select: {
        id: true,
        dealName: true,
        brandName: true,
        partner: { select: { name: true } },
      },
      orderBy: { dealName: "asc" },
    }),
  ]);

  return {
    latestBatchId: latestBatch.id,
    reviewRecords,
    sellers,
    deals,
    connectionMode,
  } satisfies LoadedBacklog;
}

async function loadBacklog() {
  const defaultPrisma = new PrismaClient();
  try {
    return await loadBacklogWithPrisma(defaultPrisma, "default");
  } catch (error) {
    const directUrl = (process.env.DIRECT_URL ?? "").trim();
    if (!directUrl || !isConnectivityError(error)) throw error;

    const fallbackPrisma = new PrismaClient({
      datasources: {
        db: {
          url: directUrl,
        },
      },
    });

    try {
      return await loadBacklogWithPrisma(fallbackPrisma, "direct-fallback");
    } finally {
      await fallbackPrisma.$disconnect();
    }
  } finally {
    await defaultPrisma.$disconnect().catch(() => undefined);
  }
}

async function main() {
  const { latestBatchId, reviewRecords, sellers, deals, connectionMode } =
    await loadBacklog();

  const sellerCandidates: SellerCandidate[] = sellers.map((seller) => ({
    id: seller.id,
    name: seller.name,
    snsHandle: seller.snsHandle,
  }));

  const dealCandidates: DealCandidate[] = deals.map((deal) => {
    const partnerName = deal.partner?.name ?? "거래처 없음";
    return {
      id: deal.id,
      name: deal.dealName,
      label: `${deal.dealName} / ${partnerName}${deal.brandName ? ` / ${deal.brandName}` : ""}`,
      partnerName,
    };
  });

  const rows: BacklogCsvRow[] = reviewRecords.map((record) => {
    const reviewType = inferReviewType(record.sourceTable);
    const normalized = parseJson<Record<string, unknown>>(record.normalizedData) ?? {};
    const raw = parseJson<Record<string, unknown>>(record.rawPayload) ?? {};

    if (reviewType === "seller") {
      const sellerName = String((normalized.sellerName ?? raw["채널명"] ?? "") || "");
      const candidate = bestStringMatch(sellerName, sellerCandidates);
      return {
        reviewType,
        batchId: record.batchId,
        sourceTable: record.sourceTable,
        sourceKey: record.sourceKey,
        reviewReason: record.reviewReason ?? "",
        sellerName,
        dealName: "",
        partnerOrBrand: "",
        salesCode: "",
        rawSchedule: "",
        sourceCreatedAt: "",
        candidateId: candidate?.id ?? "",
        candidateLabel: candidate ? `${candidate.name} @${candidate.snsHandle}` : "",
        candidateReason: candidate ? "exact-name-match" : "no-current-match",
        suggestedAction: candidate ? "merge-into-existing-seller" : "confirm-channel-before-create",
      };
    }

    if (reviewType === "deal") {
      const dealName = String((normalized.dealName ?? raw["상품"] ?? "") || "");
      const partnerOrBrand = String(
        (normalized.partnerOrBrand ?? raw["회사명"] ?? raw["브랜드"] ?? "") || "",
      );
      const candidate = bestStringMatch(dealName, dealCandidates);
      return {
        reviewType,
        batchId: record.batchId,
        sourceTable: record.sourceTable,
        sourceKey: record.sourceKey,
        reviewReason: record.reviewReason ?? "",
        sellerName: "",
        dealName,
        partnerOrBrand,
        salesCode: "",
        rawSchedule: "",
        sourceCreatedAt: "",
        candidateId: candidate?.id ?? "",
        candidateLabel: candidate?.label ?? "",
        candidateReason: candidate ? "exact-deal-name-match" : "no-current-match",
        suggestedAction: candidate ? "decide-merge-vs-separate-deal" : "manual-deal-create-review",
      };
    }

    const sellerName = relationOrString(
      normalized.sellerName ?? raw["셀러 정보"] ?? raw["셀러 정보"] ?? "",
    );
    const dealName = relationOrString(normalized.dealName ?? raw["딜 리스트"] ?? "");
    const salesCode = String((normalized.salesCode ?? raw["세일즈코드"] ?? "") || "");
    const rawSchedule = String((normalized.rawSchedule ?? raw["진행일정"] ?? "") || "");
    const sourceCreatedAt = String((normalized.sourceCreatedAt ?? raw["생성 일시"] ?? "") || "");
    const sellerCandidate = bestStringMatch(sellerName, sellerCandidates);
    const dealCandidate = bestStringMatch(dealName, dealCandidates);

    return {
      reviewType,
      batchId: record.batchId,
      sourceTable: record.sourceTable,
      sourceKey: record.sourceKey,
      reviewReason: record.reviewReason ?? "",
      sellerName,
      dealName,
      partnerOrBrand: "",
      salesCode,
      rawSchedule,
      sourceCreatedAt,
      candidateId: [sellerCandidate?.id, dealCandidate?.id].filter(Boolean).join(" | "),
      candidateLabel: [
        sellerCandidate ? `${sellerCandidate.name} @${sellerCandidate.snsHandle}` : "",
        dealCandidate?.label ?? "",
      ]
        .filter(Boolean)
        .join(" | "),
      candidateReason: [
        sellerCandidate ? "seller-match" : "missing-seller",
        dealCandidate ? "deal-match" : "missing-deal",
      ].join(" / "),
      suggestedAction:
        sellerCandidate && dealCandidate
          ? "create-campaign-after-name-normalization"
          : sellerCandidate
            ? "create-or-normalize-deal-first"
            : dealCandidate
              ? "resolve-seller-first"
              : "resolve-seller-and-deal-first",
    };
  });

  const artifactDir = join(process.cwd(), "artifacts");
  mkdirSync(artifactDir, { recursive: true });
  const jsonPath = join(artifactDir, "notion-import-review-backlog.remote.json");
  const csvPath = join(artifactDir, "notion-import-review-backlog.remote.csv");
  const actionGroups = new Map<string, BacklogCsvRow[]>();

  for (const row of rows) {
    const action = row.suggestedAction.trim();
    const current = actionGroups.get(action) ?? [];
    current.push(row);
    actionGroups.set(action, current);
  }

  writeFileSync(jsonPath, `${JSON.stringify(rows, null, 2)}\n`);
  writeFileSync(csvPath, `${Papa.unparse(rows)}\n`);

  const actionPaths = [...actionGroups.entries()].map(([action, actionRows]) => {
    const safeAction = action.replace(/[^a-z0-9_-]+/gi, "-").replace(/-+/g, "-");
    const actionPath = join(
      artifactDir,
      `notion-import-review-backlog.remote.${safeAction}.csv`,
    );
    writeFileSync(actionPath, `${Papa.unparse(actionRows)}\n`);
    return { action, path: actionPath, count: actionRows.length };
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        batchId: latestBatchId,
        connectionMode,
        jsonPath,
        csvPath,
        rowCount: rows.length,
        actionPaths,
      },
      null,
      2,
    ),
  );
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
