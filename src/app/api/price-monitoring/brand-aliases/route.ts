import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import {
  MAX_BRAND_ALIAS_LENGTH as MAX_ALIAS_LENGTH,
  MAX_BRAND_ALIASES as MAX_ALIASES,
  formatBrandAliases,
  parseBrandAliases,
} from "@/lib/price-monitor/match-context";
import { reevaluateLatestSnapshots } from "@/lib/price-monitor/reevaluate-snapshots";
import { priceMatchLabelRepository } from "@/repositories/priceMatchLabelRepository";

/**
 * 최저가 감시 브랜드 축 — 딜 브랜드명 외에 「같은 회사로 볼 이름」(제조사 등) 저장.
 * PUT { dealId, aliases: string[] } → 루트 딜에 저장 후 그 딜 가족의 최신 스냅샷 재판정.
 */
export async function PUT(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const body = await request.json().catch(() => null);
  const dealId = typeof body?.dealId === "string" ? body.dealId.trim() : "";
  const list = Array.isArray(body?.aliases) ? body.aliases.filter((v: unknown): v is string => typeof v === "string") : null;
  if (!dealId || !list) {
    return NextResponse.json({ error: "회사 이름 정보가 올바르지 않습니다." }, { status: 400 });
  }
  const aliases = parseBrandAliases(list.join("\n"));
  if (aliases.length > MAX_ALIASES || aliases.some((name) => name.length > MAX_ALIAS_LENGTH)) {
    return NextResponse.json({ error: `회사 이름은 ${MAX_ALIASES}개, 한 이름당 ${MAX_ALIAS_LENGTH}자까지입니다.` }, { status: 400 });
  }

  const rootDealId = await priceMatchLabelRepository.resolveRootDealId(dealId);
  if (!rootDealId) return NextResponse.json({ error: "판매 조건을 찾을 수 없습니다." }, { status: 404 });

  await priceMatchLabelRepository.saveBrandAliases(rootDealId, formatBrandAliases(aliases));

  let reevaluateError: string | null = null;
  let reevaluated = null;
  try {
    reevaluated = await reevaluateLatestSnapshots(rootDealId);
  } catch (error) {
    console.error("[price-monitoring/brand-aliases] reevaluate failed", error);
    reevaluateError = error instanceof Error ? error.message : "재판정 실패";
  }
  return NextResponse.json({ rootDealId, aliases, reevaluated, reevaluateError });
}
