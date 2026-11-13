import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { candidateNameKey, candidateUrlKey } from "@/lib/price-monitor/match-axes";
import { buildBrandIdentities, parseBrandAliases } from "@/lib/price-monitor/match-context";
import {
  buildMatchEvidence,
  classifyLabelCause,
  evidenceSaidSame,
  sanitizeSeenJudgment,
} from "@/lib/price-monitor/label-evidence";
import { reevaluateLatestSnapshots, type ReevaluateSummary } from "@/lib/price-monitor/reevaluate-snapshots";
import { isOwnerMatchLabelValue, priceMatchLabelRepository } from "@/repositories/priceMatchLabelRepository";

/**
 * 최저가 감시 — 오너 「같은 상품 / 다른 상품」 표시(2026-11-13 3축 분리).
 * GET    ?dealIds=a,b   → 딜(옵션 포함)별 루트 id · 루트별 표시 · 회사 이름 · 자동 판정 정확도
 * POST   { dealId, label, candidate, searchQuery, defaultQuery?, seen? } → 서버가 그 후보를 다시 판정해 축별 근거·원인 분류와 함께
 *        저장(오너 지시 2026-11-13: 「다른 상품」은 왜 올라왔는지 개선 데이터가 되어야 한다) 후 최신 스냅샷 재판정.
 *        시스템 판정(systemSaidSame)도 클라이언트 값이 아니라 이 재판정 근거로 정한다.
 * DELETE { dealId, nameKey } → 표시 취소 후 재판정
 */

const MAX_DEAL_IDS = 200;
const MAX_FIELD_LENGTH = 500;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 저장 뒤의 정확도 조회 실패가 「저장 실패」로 보이지 않게 — 저장은 끝났으니 null 로 돌려준다. */
async function accuracySafely() {
  try {
    return await priceMatchLabelRepository.accuracy();
  } catch (error) {
    console.error("[price-monitoring/labels] accuracy failed", error);
    return null;
  }
}

async function reevaluateSafely(rootDealId: string): Promise<{ summary: ReevaluateSummary | null; error: string | null }> {
  try {
    return { summary: await reevaluateLatestSnapshots(rootDealId), error: null };
  } catch (error) {
    // 표시 저장은 이미 끝났다 — 재판정 실패는 숨기지 않고 응답에 실어 화면이 알린다(다음 정기 조회 때 반영).
    console.error("[price-monitoring/labels] reevaluate failed", error);
    return { summary: null, error: error instanceof Error ? error.message : "재판정 실패" };
  }
}

export async function GET(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const raw = new URL(request.url).searchParams.get("dealIds") ?? "";
  const dealIds = Array.from(new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))).slice(0, MAX_DEAL_IDS);

  const roots: Record<string, string> = Object.fromEntries(await priceMatchLabelRepository.resolveRootDealIds(dealIds));
  const rootIds = Array.from(new Set(Object.values(roots)));
  const [labels, aliasSettings, accuracy] = await Promise.all([
    priceMatchLabelRepository.findByRootDealIds(rootIds),
    priceMatchLabelRepository.findBrandAliasSettings(rootIds),
    accuracySafely(),
  ]);

  return NextResponse.json({
    roots,
    labels: Object.fromEntries(rootIds.map((id) => [id, labels.get(id) ?? []])),
    aliases: Object.fromEntries(rootIds.map((id) => [id, parseBrandAliases(aliasSettings.get(id)?.aliasesText ?? null)])),
    // 이름 제안 재료(판정에는 안 쓴다) — 화면이 「같은 회사로 볼 이름」 제안을 계산한다.
    companies: Object.fromEntries(rootIds.map((id) => [id, aliasSettings.get(id)?.companyName ?? null])),
    accuracy,
  });
}

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const body = await request.json().catch(() => null);
  const dealId = text(body?.dealId);
  const label = body?.label;
  const candidate = body?.candidate ?? {};
  const productName = text(candidate.productName);
  const searchQuery = text(body?.searchQuery);
  const defaultQuery = text(body?.defaultQuery);
  const tooLong = [productName, searchQuery, defaultQuery, text(candidate.mall), text(candidate.url), text(candidate.channel)].some(
    (value) => value != null && value.length > MAX_FIELD_LENGTH,
  );
  if (!dealId || !isOwnerMatchLabelValue(label) || !productName || !searchQuery || tooLong) {
    return NextResponse.json({ error: "표시할 후보 정보가 올바르지 않습니다." }, { status: 400 });
  }

  const context = await priceMatchLabelRepository.findMatchContext(dealId);
  if (!context) return NextResponse.json({ error: "판매 조건을 찾을 수 없습니다." }, { status: 404 });
  const { rootDealId } = context;

  const mall = text(candidate.mall);
  const evidence = buildMatchEvidence({
    searchQuery,
    defaultQuery,
    identities: buildBrandIdentities(context.brandName, context.aliasesText),
    unit: context.unit,
    modelName: context.modelName,
    candidate: { productName, mall },
    seen: sanitizeSeenJudgment(body?.seen),
  });
  const url = text(candidate.url);
  const nameKey = candidateNameKey(mall, productName);
  await priceMatchLabelRepository.upsert({
    dealId: rootDealId,
    nameKey,
    urlKey: candidateUrlKey(url),
    label,
    channel: text(candidate.channel),
    mall,
    productName,
    url,
    systemSaidSame: evidenceSaidSame(evidence),
    cause: classifyLabelCause(label, evidence),
    searchQuery,
    evidence: JSON.stringify(evidence),
  });

  const { summary, error } = await reevaluateSafely(rootDealId);
  return NextResponse.json({
    rootDealId,
    nameKey,
    reevaluated: summary,
    reevaluateError: error,
    accuracy: await accuracySafely(),
  });
}

export async function DELETE(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const body = await request.json().catch(() => null);
  const dealId = text(body?.dealId);
  const nameKey = text(body?.nameKey);
  if (!dealId || !nameKey) {
    return NextResponse.json({ error: "취소할 표시 정보가 올바르지 않습니다." }, { status: 400 });
  }
  const rootDealId = await priceMatchLabelRepository.resolveRootDealId(dealId);
  if (!rootDealId) return NextResponse.json({ error: "판매 조건을 찾을 수 없습니다." }, { status: 404 });

  const removed = await priceMatchLabelRepository.remove(rootDealId, nameKey);
  const { summary, error } = await reevaluateSafely(rootDealId);
  return NextResponse.json({
    rootDealId,
    removed,
    reevaluated: summary,
    reevaluateError: error,
    accuracy: await accuracySafely(),
  });
}
