import { prisma } from './prisma';
import { readOrderTemplateSnapshot } from '@/lib/asset-storage';
import { DEFAULT_NEW_WORKBOOK_RULES, parseOrderExcelRules, type OrderExcelReply, type OrderExcelRules } from './excel-rules';

// F4-② 딜 온보딩 제로코드화 (GROWTH_FLYWHEEL_PLAN.md §F4)
// ─────────────────────────────────────────────────────────────
// 발주 브랜드(공급사)의 화면-설정 가능한 정체성을 단일 리졸버로 모은다.
// 지금까지 execute 라우트 3곳의 표시명 맵 · fetch-emails의 도메인 맵 ·
// 모달 2곳의 드롭다운 · 양식 분기(if templateId==='tripp')로 흩어져 있던
// "브랜드 하나당 6곳 수정"을 여기 한 곳으로 수렴시킨다.
//
// 저장 위치: Partner(거래처) 레코드의 order* 필드 (소유자 결정 2026-07-07).
// 해석 키: OrderCampaign.template(slug) === Partner.orderTemplateSlug.

export type OrderFormatAdapter = 'template-file' | 'tripp';

export interface OrderBrand {
  /** OrderCampaign.template과 매칭되는 안정 키 (= Partner.orderTemplateSlug) */
  slug: string;
  /** 설정을 소유한 거래처. 폴백(설정 미존재) 시 빈 문자열 */
  partnerId: string;
  /** 발주서·파일명·드롭다운 표시명 (예: 뉴트리원) */
  displayName: string;
  /** 회신 발주서 허용 발신 도메인 (정규화: 소문자 + '@' 접두 보장) */
  emailDomains: string[];
  /** 발주서 양식 어댑터 (레거시; excelRules 존재 시 무시 — 설계 D3) */
  formatAdapter: OrderFormatAdapter;
  /** 발주서 기본 수신 이메일(To). 미설정 시 null */
  toEmail: string | null;
  /** 발주서 보조 수신 이메일(CC). 미설정 시 null */
  ccEmail: string | null;
  /**
   * F4 Phase 2 열 매핑 규칙 (검수 확정본). 존재하면 rules.write.mode가 양식의 유일 권위이며
   * formatAdapter는 읽지 않는다(설계 D3). null이면 레거시 폴백 경로.
   */
  excelRules: OrderExcelRules | null;
}

/**
 * 발신 도메인 문자열("@a.co.kr, b.com")을 정규화 배열(["@a.co.kr","@b.com"])로.
 * 순수 함수 — 유닛 테스트 대상.
 */
export function parseEmailDomains(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((token) => {
      // 전체 주소(order@brand.co.kr)를 넣어도 도메인(@brand.co.kr)만 취한다.
      const domain = token.includes('@') ? token.slice(token.lastIndexOf('@') + 1) : token;
      return `@${domain}`;
    })
    .filter((d) => d.length > 1);
}

/** 저장된 어댑터 문자열을 알려진 값으로 정규화. 미지정/미지값은 기본(template-file). */
export function normalizeFormatAdapter(raw: string | null | undefined): OrderFormatAdapter {
  return raw === 'tripp' ? 'tripp' : 'template-file';
}

/**
 * 발주 브랜드 설정이 없는(거래처 미해석) slug의 최소 폴백.
 * 알려진 브랜드(뉴트리원·명성/트리프)는 거래처 orderExcelRules로 시드돼 이 경로에 오지 않는다 —
 * 레거시 하드코딩 폴백(LEGACY_FALLBACK)은 제거됨(2026-07-08, §7). 표시명은 slug 자체,
 * 규칙 미지정이라 생성은 표준 발주서(new-workbook), 회신은 표준 reply로 처리된다.
 */
function fallbackBrand(slug: string): OrderBrand {
  return {
    slug,
    partnerId: '',
    displayName: slug,
    emailDomains: [],
    formatAdapter: normalizeFormatAdapter(slug),
    toEmail: null,
    ccEmail: null,
    excelRules: null,
  };
}

type PartnerBrandRow = {
  id: string;
  name: string;
  orderTemplateSlug: string | null;
  orderDisplayName: string | null;
  orderEmailDomains: string | null;
  orderFormatAdapter: string | null;
  orderToEmail: string | null;
  orderCcEmail: string | null;
  orderExcelRules?: unknown;
};

const BRAND_SELECT = {
  id: true,
  name: true,
  orderTemplateSlug: true,
  orderDisplayName: true,
  orderEmailDomains: true,
  orderFormatAdapter: true,
  orderToEmail: true,
  orderCcEmail: true,
  orderExcelRules: true,
} as const;

/** Partner 행 → OrderBrand. orderTemplateSlug가 없으면 발주 브랜드가 아니므로 null. */
export function partnerToOrderBrand(p: PartnerBrandRow): OrderBrand | null {
  if (!p.orderTemplateSlug) return null;
  const toEmail = p.orderToEmail?.trim() || null;
  const ccEmail = p.orderCcEmail?.trim() || null;
  return {
    slug: p.orderTemplateSlug,
    partnerId: p.id,
    displayName: p.orderDisplayName?.trim() || p.name,
    // 회신(송장) 매칭 도메인: 수신 이메일(To)의 도메인에서 자동 추출. 없으면 레거시 도메인 필드.
    emailDomains: toEmail ? parseEmailDomains(toEmail) : parseEmailDomains(p.orderEmailDomains),
    formatAdapter: normalizeFormatAdapter(p.orderFormatAdapter),
    toEmail,
    ccEmail,
    // 손상된 JSON은 null(경고 로그) → 레거시 폴백으로 생성 유지 (parseOrderExcelRules 계약)
    excelRules: parseOrderExcelRules(p.orderExcelRules ?? null),
  };
}

/**
 * fill-template 규칙의 템플릿 스냅샷 버퍼 로드 (설계 D4).
 * 규칙이 fill-template인데 스냅샷을 읽지 못하면 조용히 public/ 레거시로 폴백하지 않고
 * 액션 가능한 에러로 중단한다 — 다른 양식으로 발주서가 나가는 사고 방지.
 */
export async function loadOrderTemplateBuffer(brand: OrderBrand | null): Promise<Buffer | undefined> {
  const rules = brand?.excelRules;
  if (!rules || rules.write.mode !== 'fill-template') return undefined;
  if (!rules.templateStoragePath) {
    throw new Error(
      `${brand!.displayName}의 열 매핑 규칙이 '양식 채움' 모드인데 템플릿 스냅샷이 없습니다. 거래처 발주 설정에서 양식을 재분석·확정하세요.`
    );
  }
  try {
    return await readOrderTemplateSnapshot(rules.templateStoragePath);
  } catch (error: any) {
    throw new Error(
      `${brand!.displayName}의 발주서 양식 스냅샷을 읽지 못했습니다(${error?.message ?? '저장소 오류'}). 거래처 발주 설정에서 재확정하세요.`
    );
  }
}

/**
 * 회신(송장) 파싱 규칙 해석 (설계 D6·D3): 확정 규칙의 reply가 있으면 그것이 권위,
 * 없으면 표준 reply로 폴백한다. 알려진 브랜드(뉴트리원·명성/트리프)는 거래처
 * orderExcelRules로 시드돼 있어 각자의 reply(예: 트리프 naver-strict)를 사용한다 —
 * 레거시 하드코딩 reply 폴백(legacyOrderExcelRules)은 제거됨(2026-07-08, §7).
 */
export function resolveReplyRule(brand: OrderBrand | null): OrderExcelReply {
  if (brand?.excelRules) return brand.excelRules.reply;
  return DEFAULT_NEW_WORKBOOK_RULES.reply;
}

/**
 * OrderCampaign.template(slug) → 발주 브랜드 설정.
 * DB 설정을 우선하고, 없으면 무중단 폴백(레거시/미지 slug)을 반환해 기존 동작을 보존한다.
 * slug가 비어 있으면 null (발주 미설정 캠페인).
 */
export async function resolveOrderBrand(slug: string | null | undefined): Promise<OrderBrand | null> {
  if (!slug) return null;
  const p = await prisma.partner.findUnique({ where: { orderTemplateSlug: slug }, select: BRAND_SELECT });
  const brand = p ? partnerToOrderBrand(p) : null;
  return brand ?? fallbackBrand(slug);
}

/** 드롭다운/목록용: 발주 브랜드로 설정된 거래처 전체 (표시명 오름차순). */
export async function listOrderBrands(): Promise<OrderBrand[]> {
  const partners = await prisma.partner.findMany({
    where: { orderTemplateSlug: { not: null } },
    select: BRAND_SELECT,
    orderBy: [{ orderDisplayName: 'asc' }, { name: 'asc' }],
  });
  return partners
    .map(partnerToOrderBrand)
    .filter((b): b is OrderBrand => b !== null);
}
