import { describe, it, expect } from "vitest";
import { parseStoreMetadata } from "../store-metadata";

// 휴브론 실측 페이지 구조를 축약한 픽스처(2026-07-05 실크롤 결과 기반).
// https://hubron.co.kr/product/휴브론-3-in-1-무선고데기/21/category/1/display/11/
const HUBRON_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>휴브론 | 3 in 1 무선고데기 - 스타일링 혁신</title>
  <meta property="og:title" content="휴브론 3 in 1 무선고데기 - 휴브론" />
  <meta name="description" content="휴브론 | 3 in 1 무선고데기. 기내 반입 가능하고 사용성이 뛰어난 스타일링 도구. 간편한 미니멀 라이프를 위한 필수 아이템." />
  <meta name="keywords" content="무선고데기, 3 in 1 고데기, 기내 반입 고데기, 스타일링 도구, 미니멀 라이프, 헤어 스타일링, 휴브론" />
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Product","name":"휴브론 3 in 1 무선고데기","description":"기내 반입이 가능한 3배럴 헤드 무선고데기!","brand":{"@type":"Brand","name":"휴브론"},"offers":[{"name":"휴브론 3 in 1 무선고데기(화이트)","price":89000,"priceCurrency":"KRW","availability":"InStock"}],"aggregateRating":{"@type":"AggregateRating","ratingValue":4.9,"reviewCount":47}}
  </script>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "휴브론",
    "url": "https://hubron.co.kr"
  }
  </script>
</head>
<body></body>
</html>
`;

// og:description이 존재하고 JSON-LD에 model/sku가 실존하는 합성 픽스처(휴브론 실측에는
// model/sku 필드가 없어 필드 파싱 경로 검증을 위해 별도 구성).
const MODEL_SKU_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>PB-10000X 보조배터리</title>
  <meta property="og:title" content="PB-10000X 대용량 보조배터리" />
  <meta property="og:description" content="초고속 충전 지원 PB-10000X 모델" />
  <meta name="description" content="메타 설명: PB-10000X 보조배터리" />
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Product","name":"파워뱅크 보조배터리","model":"PB-10000X","sku":"SKU-9981","brand":{"@type":"Brand","name":"파워브랜드"}}
  </script>
</head>
<body></body>
</html>
`;

const NON_PRODUCT_LD_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>단순 회사 소개 페이지</title>
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Organization","name":"어떤회사"}
  </script>
</head>
<body></body>
</html>
`;

const MALFORMED_LD_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>파싱 실패 케이스</title>
  <script type="application/ld+json">
  { "@type": "Product", "name": "정상 블록", "brand": { "name": "정상브랜드" } }
  </script>
  <script type="application/ld+json">
  { this is not valid json ][
  </script>
</head>
<body></body>
</html>
`;

describe("parseStoreMetadata", () => {
  it("휴브론 실측 구조: title/keywords/description을 추출한다", () => {
    const result = parseStoreMetadata(HUBRON_HTML);
    expect(result.storeTitle).toBe("휴브론 | 3 in 1 무선고데기 - 스타일링 혁신");
    expect(result.storeKeywords).toContain("3 in 1 고데기");
    expect(result.storeDescription).toContain("3 in 1 무선고데기");
  });

  it("JSON-LD 여러 블록 중 @type:Product인 블록만 골라 name/brand를 추출한다", () => {
    const result = parseStoreMetadata(HUBRON_HTML);
    expect(result.ldProduct).not.toBeNull();
    expect(result.ldProduct?.name).toBe("휴브론 3 in 1 무선고데기");
    expect(result.ldProduct?.brand).toBe("휴브론");
  });

  it("JSON-LD Product 블록에 model/sku가 있으면 추출한다", () => {
    const result = parseStoreMetadata(MODEL_SKU_HTML);
    expect(result.ldProduct?.model).toBe("PB-10000X");
    expect(result.ldProduct?.sku).toBe("SKU-9981");
  });

  it("og:description이 있으면 og:description을 사용한다(og 우선, 없으면 meta description)", () => {
    const result = parseStoreMetadata(MODEL_SKU_HTML);
    expect(result.storeDescription).toBe("초고속 충전 지원 PB-10000X 모델");
  });

  it("@type:Product가 아닌 JSON-LD 블록뿐이면 ldProduct는 null이다", () => {
    const result = parseStoreMetadata(NON_PRODUCT_LD_HTML);
    expect(result.ldProduct).toBeNull();
  });

  it("파싱 실패한 JSON-LD 블록은 개별 skip하고 정상 블록은 그대로 사용한다", () => {
    const result = parseStoreMetadata(MALFORMED_LD_HTML);
    expect(result.ldProduct).not.toBeNull();
    expect(result.ldProduct?.name).toBe("정상 블록");
    expect(result.ldProduct?.brand).toBe("정상브랜드");
  });

  it("메타데이터가 전혀 없으면 모두 빈 문자열/null로 반환한다(기존 동작 불변식)", () => {
    const result = parseStoreMetadata("<html><head></head><body></body></html>");
    expect(result.storeTitle).toBe("");
    expect(result.storeKeywords).toBe("");
    expect(result.storeDescription).toBe("");
    expect(result.ldProduct).toBeNull();
  });
});
