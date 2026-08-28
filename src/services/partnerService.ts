import { PartnerRepository } from "@/repositories/partnerRepository";

import { revalidateMasterDataCaches } from "@/lib/cache-tags";
import { recordActivityCreate, recordActivityChange, recordActivityDelete, FIELD_LABELS, getCompareValue } from "@/lib/activity-log";
import { googleDriveProvider } from "@/lib/asset-storage";
import { GEMINI_LITE_MODEL } from "@/lib/gemini-model";
import { getGeminiApiKeys } from "@/lib/agent/gemini-client";
import {
  parseOrderExcelRules,
  stripPreviousSlot,
  swapPreviousSlot,
  withPreviousSlot,
  type OrderExcelRules,
  type OrderExcelRulesCore,
} from "@/lib/order-converter/excel-rules";
import { Prisma } from "@prisma/client";

const NTS_API_URL = "https://api.odcloud.kr/api/nts-businessman/v1/status";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7일

type ExtractedBusinessInfo = {
  businessNumber: string;
  ceoName: string;
  name: string;
  address: string;
  companyRole: string;
  businessType: string;
  businessItem: string;
};

// 5초 타임아웃 지원 fetch 래퍼 함수
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

/**
 * bizno.net 웹 페이지를 스크래핑하여 대표자명과 주소를 추출합니다.
 */
async function scrapeBiznoWeb(businessNumber: string) {
  try {
    const formattedBn = businessNumber.replace(/(\d{3})(\d{2})(\d{5})/, "$1$2$3"); // 하이픈 제거 순수 숫자
    const res = await fetchWithTimeout(`https://bizno.net/article/${formattedBn}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      },
      cache: "no-store",
    }, 5000);

    if (!res.ok) {
      console.warn(`[scrapeBiznoWeb] bizno fetch failed: HTTP ${res.status}`);
      return { ceoName: null, address: null, companyName: null, businessType: null, businessItem: null };
    }

    const html = await res.text();
    let ceoName: string | null = null;
    let address: string | null = null;

    // 1. Meta Description 파싱 시도
    const metaRegex = /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i;
    const metaMatch = html.match(metaRegex);
    if (metaMatch) {
      const content = metaMatch[1];
      
      const ceoMatch = content.match(/대표자명\s*:\s*([^\s]+)/);
      if (ceoMatch) {
        ceoName = ceoMatch[1].trim();
      }

      const addressMatch = content.match(/회사주소\s*:\s*(.+?)(?=\s+(?:종업원수|사업자등록번호|법인등록번호|전화번호|팩스번호|설립일|대표자명|과세유형|법인구분))/);
      if (addressMatch) {
        address = addressMatch[1].trim();
      }
    }

    // 2. HTML Table 파싱 시도 (Fallback)
    if (!ceoName) {
      const tableCeoMatch = html.match(/<th>대표자명<\/th>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>/i);
      if (tableCeoMatch) {
        ceoName = tableCeoMatch[1].replace(/<[^>]*>/g, "").trim();
      }
    }

    if (!address) {
      const tableAddressMatch = html.match(/<th>회사주소<\/th>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>/i);
      if (tableAddressMatch) {
        address = tableAddressMatch[1]
          .replace(/<[^>]*>/g, "")
          .replace(/&nbsp;/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
    }

    if (address) {
      const parts = address.split(",");
      const koreanParts: string[] = [];
      for (const part of parts) {
        const hasKorean = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(part);
        const hasEnglish = /[a-zA-Z]/.test(part);
        if (hasEnglish && !hasKorean) {
          break;
        }
        koreanParts.push(part);
      }
      address = koreanParts.join(",").trim();
    }

    // 3. 상호(회사명)/업태/종목 추출 — th/td 라벨 맵 방식(공백·&nbsp; 정규화로 "업 태"·"종 목" 모두 매칭)
    const labelMap = new Map<string, string>();
    const pairRegex = /<th[^>]*>\s*([\s\S]*?)\s*<\/th>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>/gi;
    let pair: RegExpExecArray | null;
    while ((pair = pairRegex.exec(html)) !== null) {
      const label = pair[1].replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, "").replace(/\s+/g, "").trim();
      const value = pair[2]
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
      // bizno는 데이터가 없는 필드를 "-"로 렌더 → 빈 값으로 취급
      if (label && value && value !== "-" && !labelMap.has(label)) {
        labelMap.set(label, value);
      }
    }
    const businessType = labelMap.get("업태") ?? null; // "업 태"
    const businessItem = labelMap.get("종목") ?? null; // "종 목"

    // 상호(회사명)는 <title>에서 추출(bizno는 한글 상호를 별도 th/td로 노출하지 않음)
    let companyName: string | null = null;
    const titleMatch = html.match(/<title[^>]*>\s*([\s\S]*?)\s*<\/title>/i);
    if (titleMatch) {
      let t = titleMatch[1].replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").trim();
      t = t.split(/[|｜]/)[0].trim(); // 사이트명 접미사 제거
      t = t.replace(/에\s*대한\s*사업자정보.*$/, "").trim();
      if (t && t !== "-" && !/bizno|사업자정보|사업자등록번호조회|검색/i.test(t)) {
        companyName = t;
      }
    }

    return {
      ceoName: ceoName || null,
      address: address || null,
      companyName,
      businessType,
      businessItem,
    };
  } catch (err) {
    console.error("[scrapeBiznoWeb] Scraping failed or timed out:", err);
    return { ceoName: null, address: null, companyName: null, businessType: null, businessItem: null };
  }
}

// 국세청 API 응답 타입
interface NtsBizData {
  b_no: string;
  b_stt: string;
  b_stt_cd: string;
  tax_type: string;
  tax_type_cd: string;
  end_dt: string;
  utcc_yn: string;
}

interface NtsApiResponse {
  status_code: string;
  request_cnt: number;
  match_cnt: number;
  data: NtsBizData[];
}

export class PartnerService {
  static async createPartner(data: Prisma.PartnerCreateInput, actor: string) {
    const partner = await PartnerRepository.create(data);

    await recordActivityCreate("PARTNER", partner.id, actor);
    revalidateMasterDataCaches();

    // 구글 드라이브 폴더 비동기 선제 생성
    googleDriveProvider
      .createFolderForEntity({
        entityType: "PARTNER",
        entityId: partner.id,
        entityName: partner.name,
        section: "ETC",
      })
      .catch((err) => {
        console.warn(`[PartnerService.createPartner] Pre-creating Google Drive folder skipped:`, err);
      });

    return partner;
  }

  static async updatePartner(id: string, data: Prisma.PartnerUpdateInput, actor: string) {
    const current = await PartnerRepository.findByIdOrThrow(id);

    // F4-②: 발주 코드(orderTemplateSlug)는 자동 부여 — UI에 수동 필드가 없다.
    // 기본 수신 이메일(orderToEmail)이 채워지면 이 거래처를 발주 브랜드로 등록(슬러그=거래처 id, 아직 없을 때만),
    // 비우면 등록 해제(slug=null).
    // F4 Phase 2 D9 가드: 확정된 열 매핑 규칙(orderExcelRules)이 있으면 To를 비워도 해제하지
    // 않는다 — 규칙·폴백이 조용히 소멸해 발주가 중단되는 사고 방지. 해제는 규칙 삭제 후에만.
    if (Object.prototype.hasOwnProperty.call(data, "orderToEmail")) {
      const te = (data as Record<string, unknown>).orderToEmail;
      const toEmail = typeof te === "string" ? te.trim() : te;
      if (toEmail) {
        if (!(current as Record<string, unknown>).orderTemplateSlug) {
          (data as Record<string, unknown>).orderTemplateSlug = id;
        }
      } else if (!(current as Record<string, unknown>).orderExcelRules) {
        (data as Record<string, unknown>).orderTemplateSlug = null;
      }
    }

    const updated = await PartnerRepository.update(id, data);

    for (const key of Object.keys(data)) {
      const val = (data as Record<string, unknown>)[key];
      const curVal = (current as Record<string, unknown>)[key];
      if (getCompareValue(curVal) !== getCompareValue(val)) {
        const fieldLabel = FIELD_LABELS[key] || key;
        await recordActivityChange("PARTNER", id, fieldLabel, curVal, val, actor);
      }
    }

    revalidateMasterDataCaches();
    return updated;
  }

  // ─── F4 Phase 2: 발주서 열 매핑 규칙 (검수 확정 전용 쓰기 경로) ───
  // 일반 PATCH(updatePartnerSchema)로는 orderExcelRules를 받지 않는다 — 확정에는
  // previous 슬롯 관리·활동기록·슬러그 자동부여 부수효과가 있어 단일 경로로 강제한다.

  /** 검수 확정 저장: 기존 활성 규칙은 previous 슬롯으로(D10). 클라이언트가 보낸 previous는 무시. */
  static async savePartnerOrderRules(id: string, rules: OrderExcelRules | OrderExcelRulesCore, actor: string) {
    const current = await PartnerRepository.findByIdOrThrow(id);
    const cur = current as Record<string, unknown>;
    const currentActive = parseOrderExcelRules(cur.orderExcelRules ?? null);
    const toSave = withPreviousSlot(rules, currentActive);

    const data: Prisma.PartnerUpdateInput = {
      orderExcelRules: toSave as unknown as Prisma.InputJsonValue,
    };
    // 규칙 확정은 발주 브랜드 등록을 전제 — slug가 없으면 자동 부여(To 이메일 트리거와 동일 규칙)
    if (!cur.orderTemplateSlug) {
      data.orderTemplateSlug = id;
    }

    const updated = await PartnerRepository.update(id, data);
    await recordActivityChange(
      "PARTNER",
      id,
      "발주서 열 매핑 규칙",
      currentActive ? `확정본(${currentActive.columns.length}열)` : null,
      `확정(${toSave.columns.length}열 · ${toSave.write.mode === "fill-template" ? "양식 채움" : "신규 생성"})`,
      actor
    );
    revalidateMasterDataCaches();
    return updated;
  }

  /** 되돌리기: 활성↔직전 스왑(D10). 직전이 없으면 에러 — UI는 previous 존재 시에만 노출. */
  static async restorePartnerOrderRules(id: string, actor: string) {
    const current = await PartnerRepository.findByIdOrThrow(id);
    const active = parseOrderExcelRules((current as Record<string, unknown>).orderExcelRules ?? null);
    if (!active) throw new Error("되돌릴 매핑 규칙이 없습니다.");
    const swapped = swapPreviousSlot(active);
    if (!swapped) throw new Error("이전 매핑 규칙이 없습니다.");

    const updated = await PartnerRepository.update(id, {
      orderExcelRules: swapped as unknown as Prisma.InputJsonValue,
    });
    await recordActivityChange(
      "PARTNER",
      id,
      "발주서 열 매핑 규칙",
      `확정본(${active.columns.length}열)`,
      `이전 규칙으로 되돌림(${stripPreviousSlot(swapped).columns.length}열)`,
      actor
    );
    revalidateMasterDataCaches();
    return updated;
  }

  /** 규칙 삭제(명시적 해제 액션). 발주 브랜드 등록(slug/To)은 건드리지 않는다. */
  static async deletePartnerOrderRules(id: string, actor: string) {
    const current = await PartnerRepository.findByIdOrThrow(id);
    const active = parseOrderExcelRules((current as Record<string, unknown>).orderExcelRules ?? null);
    if (!active) return current;

    const updated = await PartnerRepository.update(id, { orderExcelRules: Prisma.DbNull });
    await recordActivityChange("PARTNER", id, "발주서 열 매핑 규칙", `확정본(${active.columns.length}열)`, null, actor);
    revalidateMasterDataCaches();
    return updated;
  }

  static async deletePartner(id: string, actor: string) {
    const partner = await PartnerRepository.findByIdOrThrow(id, {
      id: true,
      _count: {
        select: { deals: true },
      },
    });

    const typedPartner = partner as unknown as { _count: { deals: number } };
    if (typedPartner._count.deals > 0) {
      throw new Error("연결된 딜이 존재하여 삭제할 수 없습니다.");
    }

    await recordActivityDelete("PARTNER", id, actor);
    await PartnerRepository.delete(id);

    revalidateMasterDataCaches();
    return { success: true };
  }

  static async syncBusinessInfo(id: string, force: boolean) {
    const partner = await PartnerRepository.findByIdOrThrow(id);

    const businessNumber = partner.businessNumber;
    if (!businessNumber || !/^\d{10}$/.test(businessNumber)) {
      throw new Error("유효한 사업자번호가 없습니다.");
    }

    // 캐시 체크: 7일 이내 동기화 + force가 아닌 경우 캐시 반환
    if (!force && partner.bizSyncedAt) {
      const elapsed = Date.now() - new Date(partner.bizSyncedAt).getTime();
      if (elapsed < CACHE_TTL_MS) {
        return {
          skipped: true,
          message: "최근 7일 이내에 동기화되었습니다.",
          bizSyncedAt: partner.bizSyncedAt.toISOString(),
          companyStatus: partner.companyStatus,
          companyRole: partner.companyRole,
          ceoName: partner.ceoName,
          address: partner.address,
          businessType: partner.businessType,
          businessItem: partner.businessItem,
          name: partner.name,
        };
      }
    }

    const ntsServiceKey = process.env.NTS_SERVICE_KEY;

    // Mock 모드: API 키 미설정 시 테스트용 응답
    if (!ntsServiceKey || ntsServiceKey === "mock") {
      const updated = await PartnerRepository.update(id, {
        companyStatus: "계속사업자",
        companyRole: "법인사업자",
        ceoName: "홍길동 (테스트)",
        address: "서울특별시 송파구 올림픽로 35길 (테스트 주소)",
        businessType: "도매 및 소매업 (테스트)",
        businessItem: "전자상거래 (테스트)",
        bizSyncedAt: new Date(),
      });
      return {
        mock: true,
        companyStatus: updated.companyStatus,
        companyRole: updated.companyRole,
        ceoName: updated.ceoName,
        address: updated.address,
        businessType: updated.businessType,
        businessItem: updated.businessItem,
        name: updated.name,
        bizSyncedAt: updated.bizSyncedAt?.toISOString(),
      };
    }

    try {
      // 1단계: 국세청 사업자등록 상태조회 API
      let companyStatus: string | null = null;
      let companyRole: string | null = null;

      try {
        const ntsRes = await fetchWithTimeout(
          `${NTS_API_URL}?serviceKey=${encodeURIComponent(ntsServiceKey)}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({ b_no: [businessNumber] }),
            cache: "no-store",
          },
          5000
        );

        if (ntsRes.ok) {
          const ntsJson = (await ntsRes.json()) as NtsApiResponse;
          const bizData = ntsJson?.data?.[0];
          if (bizData) {
            companyStatus = bizData.b_stt || null;
            companyRole = bizData.tax_type || null;
          }
        } else {
          console.warn("[PartnerService.syncBusinessInfo] NTS API 응답 오류:", ntsRes.status);
        }
      } catch (err) {
        console.error("[PartnerService.syncBusinessInfo] NTS API 호출 실패 또는 타임아웃:", err);
      }

      // 2단계: bizno.net 무료 스크래핑을 통한 대표자명/주소/상호/업태/종목 수집
      let ceoName: string | null = null;
      let address: string | null = null;
      let companyName: string | null = null;
      let businessType: string | null = null;
      let businessItem: string | null = null;
      try {
        const scraped = await scrapeBiznoWeb(businessNumber);
        ceoName = scraped.ceoName;
        address = scraped.address;
        companyName = scraped.companyName;
        businessType = scraped.businessType;
        businessItem = scraped.businessItem;
      } catch (err) {
        console.error("[PartnerService.syncBusinessInfo] Bizno 스크래핑 처리 실패:", err);
      }

      // DB 업데이트
      const updateData: Record<string, unknown> = { bizSyncedAt: new Date() };
      if (companyStatus !== null) updateData.companyStatus = companyStatus;
      if (companyRole !== null) updateData.companyRole = companyRole;
      if (ceoName !== null) updateData.ceoName = ceoName;
      if (address !== null) updateData.address = address;
      if (businessType !== null) updateData.businessType = businessType;
      if (businessItem !== null) updateData.businessItem = businessItem;
      // 상호(name)는 캠페인 자동명명·별칭의 기준이라 기존 값을 덮어쓰지 않는다.
      // 현재 거래처명이 비어있을 때만 스크랩한 상호로 채운다.
      if (companyName !== null && !partner.name?.trim()) {
        updateData.name = companyName;
      }

      const updated = await PartnerRepository.update(id, updateData);

      return {
        companyStatus: updated.companyStatus,
        companyRole: updated.companyRole,
        ceoName: updated.ceoName,
        address: updated.address,
        businessType: updated.businessType,
        businessItem: updated.businessItem,
        name: updated.name,
        // 스크랩한 공식 상호 — 기존 거래처명을 덮어쓰지 않았어도 UI가 참고할 수 있도록 별도 노출
        bizCompanyName: companyName,
        bizSyncedAt: updated.bizSyncedAt?.toISOString(),
      };
    } catch (globalErr) {
      console.error("[PartnerService.syncBusinessInfo] 동기화 중 글로벌 오류 발생 (기존 값 반환):", globalErr);
      return {
        companyStatus: partner.companyStatus,
        companyRole: partner.companyRole,
        ceoName: partner.ceoName,
        address: partner.address,
        businessType: partner.businessType,
        businessItem: partner.businessItem,
        name: partner.name,
        bizSyncedAt: partner.bizSyncedAt?.toISOString(),
        error: "일부 정보를 동기화하는 도중 오류가 발생했습니다. 최신 정보가 반영되지 않았을 수 있습니다."
      };
    }
  }

  static async parseBusinessCardOcr(id: string, fileBase64: string, mimeType: string) {
    await PartnerRepository.findByIdOrThrow(id);

    // 키 선택은 SSOT(getGeminiApiKeys)에 맡긴다 — 3개 이상 계정을 돌려 쓰고
    // 호출마다 시작 키가 회전한다(2026-07-30 수렴). 종전엔 여기서 1·2번 키만
    // 직접 골라 3번째 계정을 쓰지 못했다.
    const rotatedKeys = getGeminiApiKeys();
    const apiKey = rotatedKeys[0];
    if (!apiKey || apiKey === "mock") {
      throw new Error("Gemini OCR API 키가 설정되지 않아 사업자 정보를 업데이트하지 않았습니다.");
    }

    let extractedInfo: ExtractedBusinessInfo = {
      businessNumber: "",
      ceoName: "",
      name: "",
      address: "",
      companyRole: "",
      businessType: "",
      businessItem: ""
    };

    // 사업자등록증 OCR은 순수 필드 추출(단순작업) — 최저가 flash-lite를 1차로 두고,
    // 어려운 문서에서만 flash→pro로 escalate(비용 최소화, 오너 지시 2026-07-24).
    const models = [GEMINI_LITE_MODEL, "gemini-2.5-flash", "gemini-2.5-pro"];
    const apiKeys = rotatedKeys;
    let success = false;

    const prompt = `이 문서는 한국의 사업자등록증 이미지 또는 PDF입니다. 다음 정보들을 정밀하게 추출해서 JSON 객체로 반환해 주세요:
- businessNumber (사업자등록번호: 하이픈 포함 혹은 제외한 10자리 숫자)
- ceoName (대표자 성명)
- name (상호명 또는 법인명)
- address (사업장 주소/소재지)
- companyRole (일반과세자, 간이과세자, 법인사업자 등 과세유형)
- businessType (업태: 예 "제조업", "도매 및 소매업". 여러 개면 쉼표로 연결. 없으면 빈 문자열)
- businessItem (종목: 예 "전자상거래", "화장품". 여러 개면 쉼표로 연결. 없으면 빈 문자열)

반드시 아래 JSON 스키마를 만족해야 하며 다른 텍스트는 일체 포함하지 마세요:
{
  "businessNumber": "string",
  "ceoName": "string",
  "name": "string",
  "address": "string",
  "companyRole": "string",
  "businessType": "string",
  "businessItem": "string"
}`;

    for (const currentKey of apiKeys) {
      if (success) break;
      for (const model of models) {
        if (success) break;
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentKey}`;
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { text: prompt },
                    {
                      inlineData: {
                        mimeType,
                        data: fileBase64
                      }
                    }
                  ]
                }
              ],
              generationConfig: {
                responseMimeType: "application/json"
                // flash-lite 티어는 thinkingLevel 미지원 — 단순 OCR엔 thinking 불요.
              }
            })
          });

          if (!res.ok) {
            const errorText = await res.text();
            console.warn(`[Gemini OCR] Model: ${model} failed with status: ${res.status}. Error: ${errorText}`);
            continue;
          }

          const responseData = await res.json();
          const text = responseData?.candidates?.[0]?.content?.parts?.[0]?.text;
          
          if (!text || typeof text !== "string") {
            console.warn(`[Gemini OCR] Model: ${model} failed to extract text.`);
            continue;
          }

          const parsed = JSON.parse(text.trim()) as Partial<ExtractedBusinessInfo>;
          extractedInfo = {
            businessNumber: parsed.businessNumber || "",
            ceoName: parsed.ceoName || "",
            name: parsed.name || "",
            address: parsed.address || "",
            companyRole: parsed.companyRole || "",
            businessType: parsed.businessType || "",
            businessItem: parsed.businessItem || ""
          };
          success = true;
        } catch (err) {
          console.warn(`[Gemini OCR] Model: ${model} exception:`, err);
        }
      }
    }

    if (!success) {
      throw new Error("사업자등록증 파싱에 실패해 기존 데이터를 유지했습니다. (모든 API 모델 및 백업 키 시도 실패)");
    }

    const cleanBusinessNumber = extractedInfo.businessNumber.replace(/\D/g, "").slice(0, 10);
    const updateData: Record<string, unknown> = {
      bizSyncedAt: new Date(),
      companyStatus: "계속사업자"
    };

    if (cleanBusinessNumber && cleanBusinessNumber.length === 10) {
      updateData.businessNumber = cleanBusinessNumber;
    }
    if (extractedInfo.ceoName) {
      updateData.ceoName = extractedInfo.ceoName;
    }
    if (extractedInfo.name) {
      updateData.name = extractedInfo.name;
    }
    if (extractedInfo.address) {
      updateData.address = extractedInfo.address;
    }
    if (extractedInfo.companyRole) {
      updateData.companyRole = extractedInfo.companyRole;
    }
    if (extractedInfo.businessType) {
      updateData.businessType = extractedInfo.businessType;
    }
    if (extractedInfo.businessItem) {
      updateData.businessItem = extractedInfo.businessItem;
    }

    const updatedPartner = await PartnerRepository.update(id, updateData);
    revalidateMasterDataCaches();
    return updatedPartner;
  }

  static async createContact(partnerId: string, data: Prisma.PartnerContactUncheckedCreateInput) {
    await PartnerRepository.findByIdOrThrow(partnerId);
    const result = await PartnerRepository.createContact(data);
    revalidateMasterDataCaches();
    return result;
  }

  static async updateContact(contactId: string, data: Prisma.PartnerContactUpdateInput) {
    const contact = await PartnerRepository.findContactById(contactId);
    if (!contact) {
      throw new Error("해당 담당자를 찾을 수 없습니다.");
    }
    const result = await PartnerRepository.updateContact(contactId, data);
    revalidateMasterDataCaches();
    return result;
  }

  static async deleteContact(contactId: string) {
    const contact = await PartnerRepository.findContactById(contactId);
    if (!contact) {
      throw new Error("해당 담당자를 찾을 수 없습니다.");
    }
    const result = await PartnerRepository.deleteContact(contactId);
    revalidateMasterDataCaches();
    return result;
  }
}
