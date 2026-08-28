/**
 * 공구 오퍼 진단 (C2) — 자동/반자동 7행 + 운영자 응답 3행.
 *
 * 왜 필요한가: 판매 에셋 파이프라인은 소구점·스토리 같은 **표현**을 만든다.
 * 그런데 공구가 안 팔리는 이유는 대개 표현이 아니라 **오퍼 자체**다 — 가격
 * 이점이 없거나, 구성이 단품과 같거나, 배송비 문턱이 결정을 막거나.
 * 표현을 다듬기 전에 오퍼를 먼저 본다.
 *
 * 설계 규약(C1 `claim-gate`와 동일 계열):
 * - **순수 함수다.** 입력은 호출부가 모아 넣고 Prisma 를 모른다.
 * - **`UNKNOWN` 은 실패가 아니다.** 증거가 없다는 뜻이고, 여기서 FAIL 로
 *   뭉개면 데이터가 적은 딜이 나쁜 딜로 둔갑한다.
 * - **점수는 커버리지가 100% 일 때만 발행한다**(M3). 확인 안 된 행이 하나라도
 *   있으면 `score` 는 null 이고 커버리지만 보여준다 — 모르는 것을 0점으로
 *   뭉개면 그 숫자가 다시 의사결정에 들어간다.
 * - 판정에는 언제나 **그 행을 뒤집을 구체 수정**이 따른다. 점수만 던지면
 *   아무도 안 고친다.
 *
 * ⛔ 이것은 판매량 예측도, 오픈 차단 게이트도, 가격 결정기도 아니다(스펙 §2).
 */

export type OfferRowId =
  // 자동·반자동 7행 — 기존 필드에서 계산된다.
  | "RESULT_CLARITY"
  | "EVIDENCE"
  | "PRICE_ADVANTAGE"
  | "BUNDLE_DIFF"
  | "PURCHASE_FRICTION"
  | "SELLER_FIT"
  | "ENCORE_HISTORY"
  // 수동 3행 (M3) — 운영자가 확인해야 아는 것들.
  | "SCARCITY_TRUTH"
  | "TIME_DELAY"
  | "RISK_REVERSAL";

/**
 * 운영자가 답하는 행. 자동 행과 달리 PARTIAL 이 없다(판단이 흐려진다).
 *
 * ⚠️ **행 세트는 오너 결정 사안이다**(스펙 §9-Q1). 2026-08-01 재검토에서
 * `NAMING`(명명)이 실무 가치 없음으로 **제거**됐다 — 지워진 행 식별자가 담긴
 * `DealOfferAnswer` 행은 DB 에 남지만, 라우트가 이 목록에 없는 `rowId` 를
 * 버리므로 판정에 영향이 없다(행 세트가 바뀔 것을 전제한 설계).
 */
export const MANUAL_ROW_IDS = [
  "SCARCITY_TRUTH",
  "TIME_DELAY",
  "RISK_REVERSAL",
] as const satisfies readonly OfferRowId[];

export type ManualRowId = (typeof MANUAL_ROW_IDS)[number];

export type ManualAnswer = {
  verdict: "PASS" | "FAIL" | "UNKNOWN";
  note: string | null;
};

export type OfferVerdict = "PASS" | "PARTIAL" | "FAIL" | "UNKNOWN" | "NA";

export type OfferRow = {
  id: OfferRowId;
  label: string;
  verdict: OfferVerdict;
  /** 왜 그렇게 판정했는지 — 근거를 숫자로 보여준다. */
  reason: string;
  /** 이 행을 뒤집으려면 무엇을 하면 되는가. PASS면 null. */
  fix: string | null;
};

export type OfferDiagnosis = {
  rows: OfferRow[];
  /** 판정이 선 행 수 / 적용 대상 행 수 (NA 제외). UNKNOWN은 미달로 센다. */
  coverage: { decided: number; applicable: number };
  /**
   * 0~10 환산 점수. **커버리지 미달이면 null** — 확인 안 된 행이 있는데
   * 점수를 내면 "낮은 점수"와 "모르는 상태"가 구분되지 않는다(C1 게이트와
   * 같은 시맨틱).
   */
  score: number | null;
};

/** 최저가 방어 스냅샷 중 판정에 쓰는 부분. */
export type PriceVerdict = "OK" | "TIE" | "VIOLATED" | "NO_DATA";

export type OfferInput = {
  /** 정가(미설정이면 할인율 판정 불가 → UNKNOWN) */
  listPrice: number | null;
  /** 공구 판매가 */
  sellingPrice: number;
  /** 최저가 방어 스냅샷 verdict. 없으면 null */
  priceVerdict: PriceVerdict | null;
  /** 배송비(0 또는 null이면 무료로 본다) */
  shippingFee: number | null;
  /** 무료배송 문턱 */
  freeShippingThreshold: number | null;
  /** 이 딜에 매달린 옵션 개수(자기 자신 제외) */
  optionCount: number;
  /** 구성·사은품 등 부가 설명 */
  supplementaryInfo: string | null;
  /** 승인된 소구점 수 (C1 DealClaim: kind=APPROVED_CLAIM, status=APPROVED) */
  approvedClaimCount: number;
  /** 그중 실측 근거(MEASURED) 수 */
  measuredClaimCount: number;
  /**
   * 셀러 적합도 — 아직 적합도 점수 기능이 없으므로 호출부가 못 넘기면
   * 이 행은 NA 로 빠진다(셀러 미배정도 NA).
   */
  sellerFit: "GOOD" | "WEAK" | null;
  /**
   * 이 딜(옵션 포함)로 **실제 실행된** 캠페인 수 — 시작일이 도래한
   * `RUN_STATUSES` 캠페인만 센다(`recampaign-timing.ts` 와 같은 어휘).
   * 제안·준비 단계는 아직 시장 반응이 없으므로 이력이 아니다.
   */
  priorRunCount: number;
  /**
   * 수동 3행의 운영자 응답. 없는 행은 UNKNOWN 으로 본다 —
   * 답이 없다는 것이지 실패가 아니다.
   */
  manualAnswers?: Partial<Record<ManualRowId, ManualAnswer>>;
};

/** 할인율이 이 아래면 "공구가"라 부르기 민망하다 — 업계 통념 기준의 하한. */
const MIN_MEANINGFUL_DISCOUNT = 0.1;
/** 옵션이 이보다 많으면 고르는 것 자체가 마찰이 된다. */
const MAX_COMFORTABLE_OPTIONS = 8;

function row(
  id: OfferRowId,
  label: string,
  verdict: OfferVerdict,
  reason: string,
  fix: string | null,
): OfferRow {
  return { id, label, verdict, reason, fix };
}

/** ① 결과 명확성 — 무엇이 좋아지는지 말할 수 있는가(C1 승인 소구점 기준). */
function diagnoseResultClarity(input: OfferInput): OfferRow {
  const { approvedClaimCount } = input;
  if (approvedClaimCount === 0) {
    return row(
      "RESULT_CLARITY",
      "결과 명확성",
      "UNKNOWN",
      "승인된 소구점이 없습니다",
      "딜 상세 '표현 관리'에서 소구점을 등록하고 승인하세요. 승인 표현이 없으면 브리프·대본이 근거 없이 쓰입니다.",
    );
  }
  if (approvedClaimCount === 1) {
    return row(
      "RESULT_CLARITY",
      "결과 명확성",
      "PARTIAL",
      "승인 소구점 1건",
      "소구점이 하나면 셀러가 콘텐츠를 여러 개 만들 각도가 없습니다. 2~3건으로 늘리세요.",
    );
  }
  return row(
    "RESULT_CLARITY",
    "결과 명확성",
    "PASS",
    `승인 소구점 ${approvedClaimCount}건`,
    null,
  );
}

/** ② 근거 실증 — 믿을 근거가 실측인가. */
function diagnoseEvidence(input: OfferInput): OfferRow {
  const { approvedClaimCount, measuredClaimCount } = input;
  if (approvedClaimCount === 0) {
    return row(
      "EVIDENCE",
      "근거 실증",
      "UNKNOWN",
      "판정할 소구점이 없습니다",
      "소구점을 먼저 등록하세요(①과 같은 조치).",
    );
  }
  if (measuredClaimCount === 0) {
    return row(
      "EVIDENCE",
      "근거 실증",
      "PARTIAL",
      `승인 ${approvedClaimCount}건 중 실측 근거 0건`,
      "시험성적서·인증번호처럼 제3자 근거가 있는 소구점을 최소 1건 확보하세요. 브랜드 주장만으로는 확신이 서지 않습니다.",
    );
  }
  return row(
    "EVIDENCE",
    "근거 실증",
    "PASS",
    `실측 근거 ${measuredClaimCount}건`,
    null,
  );
}

/**
 * ③ 가격 우위 — 타처 대비 방어 가능한가.
 *
 * 최저가 스냅샷이 우선한다(실측이라서). 스냅샷이 없으면 정가 대비 할인율로
 * 대신 보되, 그건 "타처보다 싸다"의 증거가 아니므로 PASS 를 주지 않는다.
 */
function diagnosePriceAdvantage(input: OfferInput): OfferRow {
  const { priceVerdict, listPrice, sellingPrice } = input;

  if (priceVerdict === "VIOLATED") {
    return row(
      "PRICE_ADVANTAGE",
      "가격 우위",
      "FAIL",
      "최저가 방어 실패: 타처가 더 쌉니다",
      "브랜드와 공급가를 재협상하거나, 가격 대신 구성(사은품·수량)으로 차별화하세요. 이대로 열면 셀러 팔로워가 먼저 알아챕니다.",
    );
  }
  if (priceVerdict === "TIE") {
    return row(
      "PRICE_ADVANTAGE",
      "가격 우위",
      "PARTIAL",
      "타처와 동가: 가격 이점이 없습니다",
      "'공구니까 싸다'가 성립하지 않습니다. 구성·사은품으로 차이를 만들거나 공급가를 다시 보세요.",
    );
  }

  const discount =
    listPrice && listPrice > 0 ? 1 - sellingPrice / listPrice : null;

  if (priceVerdict === "OK") {
    return row(
      "PRICE_ADVANTAGE",
      "가격 우위",
      "PASS",
      discount !== null
        ? `최저가 방어 OK · 정가 대비 ${Math.round(discount * 100)}% 할인`
        : "최저가 방어 OK",
      null,
    );
  }

  // 스냅샷 없음(NO_DATA 또는 미수집) — 할인율만으로는 확정할 수 없다.
  if (discount === null) {
    return row(
      "PRICE_ADVANTAGE",
      "가격 우위",
      "UNKNOWN",
      "최저가 스냅샷도 정가도 없습니다",
      "정가를 입력하고 최저가 모니터링을 켜세요. 가격 우위는 이 딜의 핵심 판단인데 지금은 확인할 근거가 없습니다.",
    );
  }
  if (discount < MIN_MEANINGFUL_DISCOUNT) {
    return row(
      "PRICE_ADVANTAGE",
      "가격 우위",
      "FAIL",
      `정가 대비 ${Math.round(discount * 100)}%: 공구가라 하기 어렵습니다`,
      "할인 폭을 키우거나 구성으로 가치를 더하세요.",
    );
  }
  return row(
    "PRICE_ADVANTAGE",
    "가격 우위",
    "PARTIAL",
    `정가 대비 ${Math.round(discount * 100)}% 할인 · 타처 비교는 미확인`,
    "최저가 모니터링을 켜면 타처 대비 방어 가능 여부까지 확인됩니다.",
  );
}

/** ④ 구성 차별 — 단품 대비 "여기서만"이 있는가. */
function diagnoseBundleDiff(input: OfferInput): OfferRow {
  const { optionCount, supplementaryInfo } = input;
  const hasInfo = Boolean(supplementaryInfo && supplementaryInfo.trim());
  if (optionCount > 0 && hasInfo) {
    return row(
      "BUNDLE_DIFF",
      "구성 차별",
      "PASS",
      `옵션 ${optionCount}종 + 구성 설명 있음`,
      null,
    );
  }
  if (optionCount > 0 || hasInfo) {
    return row(
      "BUNDLE_DIFF",
      "구성 차별",
      "PARTIAL",
      optionCount > 0
        ? `옵션 ${optionCount}종 · 구성 설명 없음`
        : "구성 설명만 있음",
      "이 공구에서만 얻는 것(수량 구성·사은품·한정 옵션)을 명시하세요. 단품과 같으면 굳이 공구로 살 이유가 없습니다.",
    );
  }
  return row(
    "BUNDLE_DIFF",
    "구성 차별",
    "FAIL",
    "옵션도 구성 설명도 없습니다",
    "단품과 동일한 오퍼입니다. 수량 구성·사은품·한정 옵션 중 하나는 만드세요.",
  );
}

/** ⑤ 구매 마찰 — 옵션 수·배송비가 결정을 막지 않는가. */
function diagnosePurchaseFriction(input: OfferInput): OfferRow {
  const { optionCount, shippingFee, freeShippingThreshold, sellingPrice } =
    input;
  const problems: string[] = [];
  const fixes: string[] = [];

  if (optionCount > MAX_COMFORTABLE_OPTIONS) {
    problems.push(`옵션 ${optionCount}종`);
    fixes.push(
      `옵션이 ${MAX_COMFORTABLE_OPTIONS}종을 넘으면 고르는 것 자체가 부담입니다. 대표 구성을 추리세요.`,
    );
  }

  const fee = shippingFee ?? 0;
  if (fee > 0) {
    // 문턱이 판매가보다 높으면 사실상 "항상 배송비를 낸다"는 뜻이다.
    if (freeShippingThreshold && freeShippingThreshold > sellingPrice) {
      problems.push(
        `배송비 ${fee.toLocaleString()}원 · 무료 문턱(${freeShippingThreshold.toLocaleString()}원)이 판매가보다 높음`,
      );
      fixes.push(
        "1개만 사면 무조건 배송비가 붙습니다. 문턱을 판매가 이하로 낮추거나 배송비를 판매가에 흡수하세요.",
      );
    } else if (!freeShippingThreshold) {
      problems.push(`배송비 ${fee.toLocaleString()}원 · 무료 조건 없음`);
      fixes.push("무료배송 문턱을 정하면 객단가도 같이 올라갑니다.");
    }
  }

  if (problems.length === 0) {
    return row(
      "PURCHASE_FRICTION",
      "구매 마찰",
      "PASS",
      fee > 0 ? "배송비 조건 무난 · 옵션 수 적정" : "무료배송 · 옵션 수 적정",
      null,
    );
  }
  return row(
    "PURCHASE_FRICTION",
    "구매 마찰",
    problems.length >= 2 ? "FAIL" : "PARTIAL",
    problems.join(" · "),
    fixes.join(" "),
  );
}

/** ⑥ 셀러 정합 — 셀러 미배정이거나 적합도 기능이 없으면 NA. */
function diagnoseSellerFit(input: OfferInput): OfferRow {
  if (input.sellerFit === null) {
    return row(
      "SELLER_FIT",
      "셀러 정합",
      "NA",
      "셀러 미배정(또는 적합도 미산출)",
      null,
    );
  }
  if (input.sellerFit === "WEAK") {
    return row(
      "SELLER_FIT",
      "셀러 정합",
      "FAIL",
      "셀러 계정 성격과 상품 카테고리가 어긋납니다",
      "다른 셀러를 검토하거나, 이 셀러 계정에서 자연스러운 각도로 소구점을 다시 잡으세요.",
    );
  }
  return row("SELLER_FIT", "셀러 정합", "PASS", "셀러-상품 정합 양호", null);
}

/**
 * ⑦ 앵콜·재진행 이력 — 이 오퍼가 시장에서 한 번이라도 검증됐는가.
 *
 * 오너 결정(2026-08-01, 스펙 §9-Q1 재검토)으로 신설했다. 공구에서 **재진행은
 * 오퍼 품질의 가장 강한 사후 증거**다 — 반응이 없던 오퍼는 두 번 열리지 않는다.
 *
 * **운영자에게 묻지 않고 자동 판정한다**: 실행 이력은 CRM 이 이미 안다.
 * 이미 아는 것을 매 딜마다 다시 물으면 M4② 에서 오너가 기각한 "체크되지 않는
 * 체크리스트"가 된다.
 *
 * 이력 0회는 **UNKNOWN 이 아니라 PARTIAL** 이다 — "아직 안 본 것"이 아니라
 * "첫 공구임이 확인된 것"이다. 여기서 UNKNOWN 을 주면 신규 딜은 영원히 점수를
 * 못 받는다(커버리지 100% 규칙과 충돌).
 */
function diagnoseEncoreHistory(input: OfferInput): OfferRow {
  const { priorRunCount } = input;
  if (priorRunCount >= 2) {
    return row(
      "ENCORE_HISTORY",
      "앵콜·재진행 이력",
      "PASS",
      `과거 ${priorRunCount}회 실행: 재진행된 오퍼`,
      null,
    );
  }
  if (priorRunCount === 1) {
    return row(
      "ENCORE_HISTORY",
      "앵콜·재진행 이력",
      "PARTIAL",
      "과거 1회 실행: 재진행 이력은 없음",
      "지난 회차 성과(판매 수량·전환)를 먼저 확인하세요. 반응이 있었다면 앵콜로, 없었다면 오퍼를 바꿔서 여는 것이 순서입니다.",
    );
  }
  return row(
    "ENCORE_HISTORY",
    "앵콜·재진행 이력",
    "PARTIAL",
    "첫 공구: 검증 이력 없음",
    "검증된 적 없는 오퍼입니다. 초도는 수량·기간을 보수적으로 잡고, 반응을 보고 앵콜을 설계하세요.",
  );
}

/**
 * 수동 3행의 라벨과, 답이 없을 때 무엇을 하라고 할지.
 *
 * 자동 행과 달리 코드가 판정할 수 없다 — 재고 실물, 브랜드 배송 조건,
 * 반품 약정은 사람이 확인해야 안다. 그래서 이 행들은 "무엇을 확인해야
 * 하는지"를 안내하는 역할이 크다.
 */
const MANUAL_ROW_META: Record<
  ManualRowId,
  { label: string; askFor: string; failFix: string }
> = {
  SCARCITY_TRUTH: {
    label: "한정성 진위",
    askFor:
      "브랜드에 확보 수량을 확인하고 기간·수량 한정이 실제인지 기록하세요.",
    // 가짜 한정은 마케팅 기법이 아니라 리스크다 — 셀러 계정 신뢰가 우리 자산이다.
    failFix:
      "실체 없는 한정은 셀러 팔로워가 알아채고, 그 손해는 셀러 계정 신뢰에서 나옵니다. 한정 문구를 빼거나 실제 확보 수량으로 맞추세요.",
  },
  TIME_DELAY: {
    label: "시간 지연",
    askFor: "브랜드 배송 리드타임을 확인해 오픈~수령 기간을 기록하세요.",
    failFix:
      "공구는 선주문이라 배송이 길면 이탈합니다. 발송일을 앞당기거나, 예상 수령일을 오퍼에 명시해 기대를 맞추세요.",
  },
  RISK_REVERSAL: {
    label: "위험 역전",
    askFor: "반품·교환·품질 보증 조건을 조건 조율 결과에서 확인해 기록하세요.",
    failFix:
      "구매 결정의 마지막 장벽은 '실패하면 어떻게 되나'입니다. 반품 조건을 브랜드와 정하고 오퍼에 명시하세요.",
  },
};

/** 수동 행 3개를 운영자 응답으로 판정한다(응답 없으면 UNKNOWN). */
function diagnoseManualRows(input: OfferInput): OfferRow[] {
  const answers = input.manualAnswers ?? {};
  return MANUAL_ROW_IDS.map((id) => {
    const meta = MANUAL_ROW_META[id];
    const answer = answers[id];
    if (!answer || answer.verdict === "UNKNOWN") {
      return row(
        id,
        meta.label,
        "UNKNOWN",
        answer?.note?.trim() ? answer.note : "운영자 확인 필요",
        meta.askFor,
      );
    }
    if (answer.verdict === "FAIL") {
      return row(
        id,
        meta.label,
        "FAIL",
        answer.note?.trim() ? answer.note : "운영자가 미충족으로 판정",
        meta.failFix,
      );
    }
    return row(
      id,
      meta.label,
      "PASS",
      answer.note?.trim() ? answer.note : "운영자 확인 완료",
      null,
    );
  });
}

/**
 * 판정을 0~10 으로 환산한다 — **커버리지가 100% 일 때만**.
 *
 * PASS 1점 · PARTIAL 0.5점 · FAIL 0점, NA 는 분모에서 제외. UNKNOWN 이
 * 하나라도 있으면 null 을 돌려준다: 모르는 것을 0점으로 치면 "나쁜 오퍼"와
 * "아직 안 본 오퍼"가 같은 숫자가 되고, 그 숫자가 다시 판단에 쓰인다.
 */
function computeScore(rows: OfferRow[]): number | null {
  const applicable = rows.filter((r) => r.verdict !== "NA");
  if (applicable.length === 0) return null;
  if (applicable.some((r) => r.verdict === "UNKNOWN")) return null;

  const earned = applicable.reduce((sum, r) => {
    if (r.verdict === "PASS") return sum + 1;
    if (r.verdict === "PARTIAL") return sum + 0.5;
    return sum;
  }, 0);
  // 소수 첫째 자리까지 — 10행이면 0.5 단위가 그대로 보인다.
  return Math.round((earned / applicable.length) * 100) / 10;
}

/**
 * 10행을 판정한다 — 자동·반자동 7행 + 운영자 응답 3행.
 *
 * 점수는 커버리지 100% 일 때만 나온다(`computeScore` 참고).
 */
export function diagnoseOffer(input: OfferInput): OfferDiagnosis {
  const rows = [
    diagnoseResultClarity(input),
    diagnoseEvidence(input),
    diagnosePriceAdvantage(input),
    diagnoseBundleDiff(input),
    diagnosePurchaseFriction(input),
    diagnoseSellerFit(input),
    diagnoseEncoreHistory(input),
    ...diagnoseManualRows(input),
  ];

  const applicable = rows.filter((r) => r.verdict !== "NA");
  const decided = applicable.filter((r) => r.verdict !== "UNKNOWN");

  return {
    rows,
    coverage: { decided: decided.length, applicable: applicable.length },
    score: computeScore(rows),
  };
}
