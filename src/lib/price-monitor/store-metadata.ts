// 스토어 페이지 HTML에서 검색어 추출 프롬프트에 쓰일 메타데이터를 파싱하는 순수함수(P1-1).
//
// 배경: extract-info route는 기존에 title/meta[keywords]만 사용하고 og:title/og:description/
// meta[description]/JSON-LD(schema.org Product)를 버리고 있었다. 휴브론 실제 스토어 페이지에는
// 이 필드들이 모두 존재하며, 특히 JSON-LD의 name/brand/model/sku는 모델명 보존(P1-3)의 핵심
// 입력이 된다.
import * as cheerio from "cheerio";

export type LdProductInfo = {
  name: string | null;
  brand: string | null;
  model: string | null;
  sku: string | null;
};

export type StoreMetadata = {
  storeTitle: string;
  storeKeywords: string;
  storeDescription: string;
  ldProduct: LdProductInfo | null;
};

/** brand 필드가 문자열(레거시) 또는 {name} 객체(schema.org 표준) 양쪽을 수용한다. */
function extractBrandName(brand: unknown): string | null {
  if (typeof brand === "string" && brand.trim()) return brand.trim();
  if (brand && typeof brand === "object" && typeof (brand as { name?: unknown }).name === "string") {
    const name = (brand as { name: string }).name.trim();
    return name || null;
  }
  return null;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

/**
 * script[type=application/ld+json] 전체를 순회해 @type이 "Product"(또는 @type 배열에 "Product"
 * 포함)인 첫 블록에서 name/brand/model/sku를 추출한다. 개별 블록 파싱 실패(JSON.parse 오류)는
 * skip하고 다음 블록을 계속 시도한다. Product 블록이 하나도 없으면 null.
 */
function extractLdProduct($: cheerio.CheerioAPI): LdProductInfo | null {
  const scripts = $('script[type="application/ld+json"]').toArray();

  for (const el of scripts) {
    const raw = $(el).contents().text();
    if (!raw || !raw.trim()) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // 파싱 실패 블록은 개별 skip
    }

    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      const type = (candidate as { "@type"?: unknown })["@type"];
      const isProduct =
        type === "Product" || (Array.isArray(type) && type.includes("Product"));
      if (!isProduct) continue;

      const record = candidate as Record<string, unknown>;
      return {
        name: toStringOrNull(record.name),
        brand: extractBrandName(record.brand),
        model: toStringOrNull(record.model),
        sku: toStringOrNull(record.sku),
      };
    }
  }

  return null;
}

/** 스토어 페이지 HTML을 파싱해 검색어 추출 프롬프트에 필요한 메타데이터를 반환한다. */
export function parseStoreMetadata(html: string): StoreMetadata {
  const $ = cheerio.load(html);

  const storeTitle =
    $("title").text().trim() || $("meta[property='og:title']").attr("content")?.trim() || "";
  const storeKeywords = $("meta[name='keywords']").attr("content")?.trim() || "";
  const storeDescription =
    $("meta[property='og:description']").attr("content")?.trim() ||
    $("meta[name='description']").attr("content")?.trim() ||
    "";

  const ldProduct = extractLdProduct($);

  return { storeTitle, storeKeywords, storeDescription, ldProduct };
}
