import { ACCEPTED_UPLOAD_EXTENSIONS, MAX_FILE_SIZE_BYTES } from "@/lib/price-sheet/types";

/**
 * 어시스턴트 화면 가격표 인제스트 로직 (1단계 승인 스코프).
 *
 * 어시스턴트 LLM 턴(/api/assistant)은 관여하지 않는다 — 기존 가격표 API 2개
 * (POST /api/price-sheets → POST /api/price-sheets/[id]/extract)를 순차 호출하는
 * 클라이언트 오케스트레이션이다. Vercel 60초 클램프 안에서 LLM 호출(에이전트 턴 +
 * 추출 vision)을 중첩시키지 않기 위한 아키텍처 결정이므로, 이 흐름을 에이전트
 * 도구 안으로 옮기려면 그 제약부터 재검토해야 한다.
 */

export const PRICE_SHEET_ACCEPT = ACCEPTED_UPLOAD_EXTENSIONS.map((ext) => `.${ext}`).join(",");

// 추출 다음에 매핑 계산까지 채팅 안에서 이어붙인다(2단계). "mapping"은 /map 호출 + 행 조회.
export type PriceSheetIngestPhase = "uploading" | "extracting" | "mapping";

export type PriceSheetIngestResult =
  | {
      ok: true;
      priceSheetId: string;
      fileName: string;
      rowCount: number;
      detectedTables: number;
    }
  | {
      ok: false;
      error: string;
      /** 업로드는 성공했고 추출만 실패한 경우 상세 화면 재시도 링크용. */
      priceSheetId: string | null;
    };

/** 서버 게이트(업로드 라우트)와 동일한 문구로 선검증한다 — 문구 발명 금지(ss-ux P0). */
export function validatePriceSheetFile(file: File): string | null {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!(ACCEPTED_UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
    return `지원하지 않는 파일 형식입니다: .${ext} (xlsx/csv/pptx/pdf/png/jpg만 지원)`;
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return `파일 크기가 20MB를 초과합니다 (${(file.size / 1024 / 1024).toFixed(1)}MB)`;
  }
  return null;
}

/**
 * 업로드 → 추출을 순차 실행한다. 실패는 throw 대신 결과 객체로 반환한다 —
 * 어느 단계에서 실패했는지(priceSheetId 유무)가 UI의 후속 안내(상세 재시도 vs 목록)를
 * 가르기 때문이다. 실패 문구는 서버 error 원문을 그대로 쓴다(이 화면 기존 관례,
 * ss-ux P0 #7).
 */
export async function ingestPriceSheetFile(
  file: File,
  partnerId: string | null,
  onPhase?: (phase: PriceSheetIngestPhase) => void,
): Promise<PriceSheetIngestResult> {
  let priceSheetId: string | null = null;
  try {
    onPhase?.("uploading");
    const formData = new FormData();
    formData.append("file", file);
    if (partnerId) formData.append("partnerId", partnerId);

    const uploadRes = await fetch("/api/price-sheets", { method: "POST", body: formData });
    const uploadData = await uploadRes.json().catch(() => ({}));
    if (!uploadRes.ok) {
      return { ok: false, error: uploadData?.error ?? "업로드에 실패했습니다.", priceSheetId: null };
    }
    priceSheetId = uploadData?.priceSheet?.id ?? null;
    if (!priceSheetId) {
      return { ok: false, error: "업로드 응답에 가격표 ID가 없습니다.", priceSheetId: null };
    }

    onPhase?.("extracting");
    const extractRes = await fetch(`/api/price-sheets/${priceSheetId}/extract`, { method: "POST" });
    const extractData = await extractRes.json().catch(() => ({}));
    if (!extractRes.ok) {
      return {
        ok: false,
        error: extractData?.error ?? "가격표 추출 중 오류가 발생했습니다.",
        priceSheetId,
      };
    }

    return {
      ok: true,
      priceSheetId,
      fileName: file.name,
      rowCount: typeof extractData?.rowCount === "number" ? extractData.rowCount : 0,
      detectedTables:
        typeof extractData?.priceSheet?.detectedTables === "number"
          ? extractData.priceSheet.detectedTables
          : 0,
    };
  } catch {
    return { ok: false, error: "업로드 중 오류가 발생했습니다.", priceSheetId };
  }
}

// ── 2단계: 채팅 안에서 매핑 분석 → (깨끗한 건) 적용까지 ──────────────────────
//
// "깨끗함 vs 애매함"의 경계는 새로 발명하지 않는다 — 기존 매핑 시스템이 이미 긋는다.
//   NEW_DEAL   = 닮은 기존 딜 없음 → 새 딜 생성. 적용 파이프라인이 사람 확인 없이 받음 = 깨끗.
//   SUGGESTED  = 기존 딜과 유사. 잘못 연결하면 엉뚱한 딜 가격을 덮어씀(돈) → 적용 파이프라인이
//                의도적으로 거부하고 사람 확인을 요구 = 애매(검토 화면으로 넘김).
// needsReview 플래그·판매가 누락 행도 애매로 본다(채팅에서 바로 반영하기엔 확인이 필요).
//
// 부분 적용은 하지 않는다: 현재 /apply 는 실행 시 가격표 전체를 APPLIED 로 잠그므로(2차 적용
// 409), "깨끗한 것만 먼저·애매한 건 나중"이 성립하려면 돈 반영 파이프라인 수정이 필요하다.
// 그래서 애매한 행이 하나라도 있으면 채팅 적용을 열지 않고 검토 화면으로 통째로 넘긴다(1차 안전판).

export type PriceSheetRowSummary = {
  productName: string | null;
  optionName: string | null;
  sellingPrice: number | null;
};

export type PriceSheetReview = {
  priceSheetId: string;
  total: number;
  /** 채팅에서 바로 적용 가능한 신규 딜 행(미리보기용 요약). */
  clean: PriceSheetRowSummary[];
  /** 기존 딜과 겹치거나 확인이 필요해 검토 화면으로 넘길 행 수. */
  ambiguousCount: number;
};

export type PriceSheetApplyResult =
  | { ok: true; appliedRowCount: number; dealCount: number }
  | { ok: false; error: string };

type CategorizableRow = {
  productName?: string | null;
  optionName?: string | null;
  sellingPrice?: number | string | null;
  mappingStatus?: string | null;
  flags?: unknown;
};

// 검토 화면(review-table FlagBadges)이 배지로 경고하는 플래그 전부 — 채팅 원클릭 적용의
// 안전망이 기존 화면보다 좁으면 안 된다(교차검증 HIGH: 음수마진 행이 무경고 적용될 뻔).
const RISK_FLAG_KEYS = [
  "needsReview",
  "negativeMargin",
  "giftOrBundle",
  "singlePurchaseBlocked",
] as const;

/**
 * 매핑 계산 후의 행 목록을 깨끗/애매로 가른다. 순수 함수 — DB·fetch 없이 유닛테스트한다.
 * clean = NEW_DEAL(닮은 기존 딜 없음) + 판매가 있음 + 위험 플래그 없음. 나머지는 전부 애매.
 */
export function categorizePriceSheetRows(rows: CategorizableRow[]): {
  clean: PriceSheetRowSummary[];
  ambiguousCount: number;
} {
  const clean: PriceSheetRowSummary[] = [];
  let ambiguousCount = 0;
  for (const row of rows) {
    const price = row.sellingPrice == null ? null : Number(row.sellingPrice);
    const hasPrice = price != null && Number.isFinite(price);
    const flags = (row.flags ?? null) as Record<string, unknown> | null;
    const hasRiskFlag = RISK_FLAG_KEYS.some((key) => Boolean(flags?.[key]));
    if (row.mappingStatus === "NEW_DEAL" && hasPrice && !hasRiskFlag) {
      clean.push({
        productName: row.productName ?? null,
        optionName: row.optionName ?? null,
        sellingPrice: price,
      });
    } else {
      ambiguousCount += 1;
    }
  }
  return { clean, ambiguousCount };
}

/**
 * 추출 성공 후 자동 매핑 계산(/map) → 행 조회 → 분류. 어느 단계가 실패해도 throw 하지 않고
 * "전량 애매(검토 화면으로)"로 안전하게 저하시킨다 — 추출 자체는 성공했으므로 사용자는 항상
 * 상세 화면으로 이어갈 수 있어야 한다. extractedRowCount 는 조회 실패 시 애매 건수 표기용 폴백.
 */
export async function mapAndCategorize(
  priceSheetId: string,
  extractedRowCount: number,
): Promise<PriceSheetReview> {
  try {
    await fetch(`/api/price-sheets/${priceSheetId}/map`, { method: "POST" });
    const res = await fetch(`/api/price-sheets/${priceSheetId}`);
    if (!res.ok) {
      return { priceSheetId, total: extractedRowCount, clean: [], ambiguousCount: extractedRowCount };
    }
    const data = await res.json().catch(() => ({}));
    const rows = (data?.priceSheet?.rows ?? []) as CategorizableRow[];
    // 200인데 본문이 비정상(rows 누락)이면서 추출은 행을 만들었던 경우 — "품목 0개"로
    // 오표시하지 말고 문서화된 안전 저하(전량 애매)로 떨어뜨린다. 추출 행수 0이면 빈 시트가 정상.
    if (rows.length === 0 && extractedRowCount > 0) {
      return { priceSheetId, total: extractedRowCount, clean: [], ambiguousCount: extractedRowCount };
    }
    const { clean, ambiguousCount } = categorizePriceSheetRows(rows);
    return { priceSheetId, total: rows.length, clean, ambiguousCount };
  } catch {
    return { priceSheetId, total: extractedRowCount, clean: [], ambiguousCount: extractedRowCount };
  }
}

/**
 * 검수 확정 행(MAPPED/NEW_DEAL)을 딜에 반영한다 — 기존 적용 파이프라인(/apply: 승인 기안 →
 * 트랜잭션 → 딜 생성/수정)을 그대로 호출한다. 채팅에서 돈 건드리는 경로를 새로 짜지 않는다.
 * 채팅 적용은 애매 행이 0일 때만 호출되므로 반영 대상은 전부 깨끗한 NEW_DEAL 이다.
 */
export async function applyPriceSheetRows(priceSheetId: string): Promise<PriceSheetApplyResult> {
  try {
    const res = await fetch(`/api/price-sheets/${priceSheetId}/apply`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data?.error ?? "가격표 반영 중 오류가 발생했습니다." };
    }
    return {
      ok: true,
      appliedRowCount: typeof data?.rowCount === "number" ? data.rowCount : 0,
      dealCount: Array.isArray(data?.results) ? data.results.length : 0,
    };
  } catch {
    return { ok: false, error: "가격표 반영 중 오류가 발생했습니다." };
  }
}
