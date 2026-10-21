// [캘린더수집] 제목 파서가 쓰는 사전(셀러 이름들·딜 브랜드/딜명/거래처명) 적재.
// 비활성 딜도 포함한다 — 과거 회차 일정 매칭 때문. Seller/Deal 에는 소프트삭제 컬럼이 없다.
import type { InboundDictionary } from "./types";

type SellerRow = { id: string; name: string | null; alias: string | null };
type DealRow = {
  id: string;
  brandName: string | null;
  dealName: string;
  partner: { name: string } | null;
};

/** PrismaClient 의 필요한 면만. */
export type InboundDictionaryDb = {
  seller: {
    findMany(args: { select: Record<string, true> }): Promise<SellerRow[]>;
  };
  deal: {
    findMany(args: {
      select: {
        id: true;
        brandName: true;
        dealName: true;
        partner: { select: { name: true } };
      };
    }): Promise<DealRow[]>;
  };
};

function uniqueNonEmpty(values: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const t = v?.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export async function loadInboundDictionary(
  db: InboundDictionaryDb,
): Promise<InboundDictionary> {
  const [sellers, deals] = await Promise.all([
    db.seller.findMany({ select: { id: true, name: true, alias: true } }),
    db.deal.findMany({
      select: {
        id: true,
        brandName: true,
        dealName: true,
        partner: { select: { name: true } },
      },
    }),
  ]);
  return {
    sellers: sellers.map((s) => ({
      id: s.id,
      names: uniqueNonEmpty([s.alias, s.name]),
    })),
    deals: deals.map((d) => ({
      id: d.id,
      brandNames: uniqueNonEmpty((d.brandName ?? "").split(/[/,]/)),
      dealName: d.dealName,
      partnerName: d.partner?.name?.trim() || null,
    })),
  };
}
