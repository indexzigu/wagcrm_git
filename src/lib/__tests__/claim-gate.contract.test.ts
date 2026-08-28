import { describe, expect, it } from "vitest";
import {
  checkText,
  groupViolations,
  type BannedRuleInput,
  type DealClaimInput,
} from "@/lib/claims/claim-gate";
import {
  BANNED_PHRASE_SEED,
  SUPERSEDED_PHRASES,
} from "@/lib/claims/banned-phrase-seed";

/**
 * 클레임 게이트의 판정 계약을 고정한다(C1 스펙 M1).
 *
 * 이 게이트는 셀러에게 나가는 자료와 셀러 제출물의 법령 위반 소지를
 * 잡는 장치다 — 판정이 조용히 느슨해지면 벤더가 책임을 진다. 그래서
 * severity 완화·검출 축소는 코드가 아니라 **규칙의 변경**이며 오너 승인
 * 사안이다(commit-guard 계약 테스트와 같은 지위).
 */

const RULE_GLOBAL: BannedRuleInput = {
  id: "r-global",
  phrase: "부작용 없음",
  pattern: "부작용\\s*(이)?\\s*없",
  category: null,
  severity: "WARN",
  legalBasis: "표시광고법 §3",
  note: "안전성 단정",
};

const RULE_COSMETIC: BannedRuleInput = {
  id: "r-cosmetic",
  phrase: "아토피 치료",
  pattern: "아토피\\s*(치료|개선)",
  category: "COSMETIC",
  severity: "BLOCK",
  legalBasis: "화장품법 §13",
};

describe("claim-gate — 금지 표현 검출", () => {
  it("깨끗한 본문은 PASS", () => {
    const r = checkText("이번 공구는 3일간 진행합니다.", {
      rules: [RULE_GLOBAL, RULE_COSMETIC],
      category: "COSMETIC",
    });
    expect(r.verdict).toBe("PASS");
    expect(r.violations).toHaveLength(0);
  });

  it("공통 규칙(category=null)은 카테고리와 무관하게 적용된다", () => {
    for (const category of [null, "FOOD", "COSMETIC"]) {
      const r = checkText("부작용이 없어요", {
        rules: [RULE_GLOBAL],
        category,
      });
      expect(r.violations).toHaveLength(1);
      expect(r.violations[0].legalBasis).toBe("표시광고법 §3");
    }
  });

  it("카테고리 규칙은 일치할 때만 적용된다", () => {
    const text = "아토피 치료에 좋아요";
    expect(
      checkText(text, { rules: [RULE_COSMETIC], category: "COSMETIC" })
        .violations,
    ).toHaveLength(1);
    // 식품 딜에는 화장품 규칙이 걸리지 않는다(오탐 방지).
    expect(
      checkText(text, { rules: [RULE_COSMETIC], category: "FOOD" }).violations,
    ).toHaveLength(0);
    // 카테고리 미설정 딜에는 공통 규칙만 적용된다.
    expect(
      checkText(text, { rules: [RULE_COSMETIC], category: null }).violations,
    ).toHaveLength(0);
  });

  it("BLOCK 1건이면 종합 판정은 BLOCK, WARN만 있으면 WARN", () => {
    expect(
      checkText("아토피 개선 효과", {
        rules: [RULE_COSMETIC],
        category: "COSMETIC",
      }).verdict,
    ).toBe("BLOCK");
    expect(
      checkText("부작용이 없습니다", { rules: [RULE_GLOBAL] }).verdict,
    ).toBe("WARN");
  });

  it("span이 하이라이트 가능한 위치를 가리킨다", () => {
    const text = "저희 제품은 부작용이 없어요";
    const r = checkText(text, { rules: [RULE_GLOBAL] });
    const [start, end] = r.violations[0].span;
    expect(text.slice(start, end)).toBe(r.violations[0].matched);
    expect(r.violations[0].matched).toContain("부작용");
  });

  it("같은 규칙의 복수 출현을 모두 잡고 위치순으로 정렬한다", () => {
    const r = checkText("부작용이 없고, 정말 부작용 없어요", {
      rules: [RULE_GLOBAL],
    });
    expect(r.violations).toHaveLength(2);
    expect(r.violations[0].span[0]).toBeLessThan(r.violations[1].span[0]);
  });

  it("깨진 정규식이 사전에 있어도 게이트가 꺼지지 않고 리터럴로 폴백한다", () => {
    const broken: BannedRuleInput = {
      id: "r-broken",
      phrase: "무해",
      pattern: "([불완전", // 컴파일 불가
      category: null,
      severity: "WARN",
      legalBasis: "표시광고법 §3",
    };
    const r = checkText("이 제품은 무해합니다", { rules: [broken] });
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].matched).toBe("무해");
  });
});

describe("claim-gate — 딜 클레임", () => {
  const disclosure: DealClaimInput = {
    id: "c-disc",
    kind: "REQUIRED_DISCLOSURE",
    text: "유료 광고 포함",
  };
  const approved: DealClaimInput = {
    id: "c-ok",
    kind: "APPROVED_CLAIM",
    text: "국내산 원료 100%",
  };
  const banned: DealClaimInput = {
    id: "c-ban",
    kind: "BANNED_PHRASE",
    text: "리뉴얼 전 제품",
  };

  it("필수 고지가 없으면 누락으로 잡고 최소 WARN", () => {
    const r = checkText("좋은 제품이에요", { dealClaims: [disclosure] });
    expect(r.missingDisclosures).toEqual([
      { id: "c-disc", text: "유료 광고 포함" },
    ]);
    expect(r.verdict).toBe("WARN");
  });

  it("필수 고지가 있으면 공백 차이를 무시하고 통과시킨다", () => {
    const r = checkText("본 게시물은 유료   광고 포함 입니다", {
      dealClaims: [disclosure],
    });
    expect(r.missingDisclosures).toHaveLength(0);
    expect(r.verdict).toBe("PASS");
  });

  it("딜 전용 금지 표현은 BLOCK으로 판정한다", () => {
    const r = checkText("리뉴얼 전 제품 재고입니다", { dealClaims: [banned] });
    expect(r.verdict).toBe("BLOCK");
    expect(r.violations[0].origin).toBe("DEAL_CLAIM");
  });

  it("승인 소구점 사용을 리포트한다(강제는 아니다)", () => {
    const r = checkText("국내산 원료 100% 사용했습니다", {
      dealClaims: [approved],
    });
    expect(r.usedApprovedClaims).toHaveLength(1);
    // 승인 소구점 사용 자체는 위반이 아니다.
    expect(r.verdict).toBe("PASS");
  });
});

describe("groupViolations — 표시용 접기", () => {
  const rules: BannedRuleInput[] = [
    {
      id: "r-abs",
      phrase: "무조건",
      category: null,
      severity: "WARN",
      legalBasis: "표시광고법 §3",
      note: "실측 근거가 없으면 제거하세요.",
    },
    {
      id: "r-price",
      phrase: "최저가",
      category: null,
      severity: "WARN",
      legalBasis: "표시광고법 §3",
      note: null,
    },
  ];

  it("같은 규칙·같은 표현이 여러 곳에 걸리면 한 줄로 접고 횟수를 센다", () => {
    // 실제 콘텐츠 가이드가 낸 모양 — 체크리스트와 주의사항 양쪽에 같은 표현이 나온다.
    const guide = [
      "무조건 커 보인다 같은 표현은 쓰지 않습니다.",
      "타 채널가와 충돌하므로 최저가 표현도 피합니다.",
      "다시 강조하면 무조건·최저가 단정은 금지입니다.",
    ].join("\n");

    const { violations } = checkText(guide, { rules });
    // 원본은 매칭 위치마다 1건 — 하이라이트가 span 단위로 필요하므로 이 설계는 그대로.
    expect(violations).toHaveLength(4);

    const groups = groupViolations(violations);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => [g.matched, g.occurrences])).toEqual([
      ["무조건", 2],
      ["최저가", 2],
    ]);
    // 접힌 위치는 버리지 않는다(하이라이트·이동이 필요해지면 쓴다).
    expect(groups[0].spans).toHaveLength(2);
    expect(groups[0].note).toBe("실측 근거가 없으면 제거하세요.");
  });

  it("같은 규칙이라도 검출 표현이 다르면 따로 세운다", () => {
    // 운영자가 손봐야 하는 문장이 서로 다르므로 접으면 하나가 화면에서 사라진다.
    const patternRule: BannedRuleInput[] = [
      {
        id: "r-cure",
        phrase: "완치",
        pattern: "완치(?:시켜|\\s*사례)",
        category: null,
        severity: "BLOCK",
        legalBasis: "약사법",
        note: null,
      },
    ];
    const groups = groupViolations(
      checkText("완치시켜 준다는 후기, 완치 사례도 많다", {
        rules: patternRule,
      }).violations,
    );
    expect(groups.map((g) => g.matched)).toEqual(["완치시켜", "완치 사례"]);
  });

  it("본문 등장 순서를 보존한다", () => {
    const groups = groupViolations(
      checkText("최저가라서 무조건 사야 합니다", { rules }).violations,
    );
    expect(groups.map((g) => g.matched)).toEqual(["최저가", "무조건"]);
  });

  it("빈 목록은 빈 목록이다", () => {
    expect(groupViolations([])).toEqual([]);
  });
});

describe("banned-phrase-seed — 사전 무결성", () => {
  it("모든 pattern이 컴파일 가능한 정규식이다", () => {
    for (const rule of BANNED_PHRASE_SEED) {
      if (!rule.pattern) continue;
      expect(
        () => new RegExp(rule.pattern as string, "giu"),
        `깨진 정규식: ${rule.phrase}`,
      ).not.toThrow();
    }
  });

  it("모든 규칙이 법령 근거와 표시 문구를 갖는다", () => {
    for (const rule of BANNED_PHRASE_SEED) {
      expect(rule.legalBasis.trim().length, rule.phrase).toBeGreaterThan(0);
      expect(rule.phrase.trim().length).toBeGreaterThan(0);
    }
  });

  it("카테고리는 합의된 4종 또는 공통(null)만 쓴다", () => {
    const allowed = new Set([null, "FOOD", "SUPPLEMENT", "COSMETIC", "GENERAL"]);
    for (const rule of BANNED_PHRASE_SEED) {
      expect(allowed.has(rule.category ?? null), `${rule.phrase}`).toBe(true);
    }
  });

  it("초기 시드는 전 항목 WARN으로 출발한다 (오너 결정 2026-07-29, C1 §8-Q3)", () => {
    // 검수 후 BLOCK 승격은 의도적 변경이어야 한다 — 이 테스트가 깨지는 것이
    // 곧 '검수를 거쳤는가'를 묻는 지점이다. 무심코 올리지 말 것.
    for (const rule of BANNED_PHRASE_SEED) {
      expect(rule.severity, `${rule.phrase}`).toBe("WARN");
    }
  });

  it("실제 시드로 대표 위반 문장을 잡는다", () => {
    const rules = BANNED_PHRASE_SEED.map((r, i) => ({ ...r, id: `seed-${i}` }));

    const cosmetic = checkText("아토피 개선에 좋고 세포 재생 효과까지!", {
      rules,
      category: "COSMETIC",
    });
    expect(cosmetic.violations.length).toBeGreaterThanOrEqual(2);

    const food = checkText("혈압을 낮춰주는 국내 유일 제품", {
      rules,
      category: "FOOD",
    });
    // 질병명+효능(식품 규칙) + 유일성 주장(공통 규칙)
    expect(food.violations.length).toBeGreaterThanOrEqual(2);
    expect(food.violations.some((v) => v.legalBasis.includes("식품"))).toBe(
      true,
    );

    // 일상적인 공구 문안은 통과해야 한다(오탐 회귀 방지).
    const clean = checkText(
      "이번 주 금요일 저녁 8시에 오픈합니다. 수량이 한정되어 있어요.",
      { rules, category: "FOOD" },
    );
    expect(clean.verdict).toBe("PASS");
  });
});

/**
 * 활용형·조사 변형 검출 계약 (2026-07-30).
 *
 * **왜 필요한가:** 사전은 형태소 분석을 하지 않고 정규식으로 어미를 흡수한다
 * (`claim-gate.ts` 설계). 그래서 어미를 규칙마다 손으로 열거하면 **같은 취지의
 * 규칙끼리 검출력이 갈린다.** 실측 갭 2건:
 *
 * 1. SUPPLEMENT "질병 치료·예방 표방"의 옛 패턴
 *    `(치료|완치|예방)(에|해|합니다|됩니다|효과)` 가 "완치시켜 줍니다"를
 *    **위반 0건으로 통과**시켰다("시"가 접미 목록에 없어서). 같은 방식으로
 *    "완치되고"·"완치까지"·"완치 사례"·"치료하려면"이 전부 빠져나갔다.
 * 2. 질병명·치료 계열이 FOOD/COSMETIC 에만 있어 **건기식(SUPPLEMENT) 딜에서
 *    "당뇨에 좋아요"가 통과**했다 — 건강기능식품법이 더 엄격한데 사전이
 *    반대로 배치돼 있었다. → 질병 표방 3규칙을 공통(category=null)으로 이관.
 *
 * 아래 두 표가 이 계약을 고정한다. **오탐 표(CLEAN)를 함께 고정하는 게 핵심**
 * — 검출을 넓히다 법정 면책 문구("질병의 예방 및 치료를 위한 의약품이
 * 아닙니다")를 잡기 시작하면 운영자가 게이트를 무시하게 된다.
 */
describe("banned-phrase-seed — 활용형·카테고리 배치 계약", () => {
  const seedRules = () =>
    BANNED_PHRASE_SEED.map((r, i) => ({ ...r, id: `seed-${i}` }));

  /** 반드시 잡아야 하는 위반 — [본문, 딜 카테고리]. */
  const MUST_FLAG: [string, string | null][] = [
    // 갭 1 — 활용형(용언화)이 어미 열거를 빠져나간 실측 케이스
    ["이 제품은 관절 통증을 완치시켜 줍니다.", "SUPPLEMENT"],
    ["완치되고 나서도 계속 먹었어요.", "SUPPLEMENT"],
    ["완치까지 두 달 걸렸습니다.", "SUPPLEMENT"],
    ["완치 사례가 많아요.", "SUPPLEMENT"],
    ["염증을 치료해주는 성분이 들어 있어요.", "SUPPLEMENT"],
    ["치료하려면 이거 하나로 충분해요.", "SUPPLEMENT"],
    ["꾸준히 먹으면 치료됩니다.", "SUPPLEMENT"],
    ["감기를 예방합니다.", "SUPPLEMENT"],
    ["예방 효과가 뛰어나요.", "FOOD"],
    ["아픈 곳을 낫게 됩니다.", "FOOD"],
    // ⚠️ "OO에 효과가 있다" — 한국어 효능 표방의 가장 자연스러운 형태다.
    // 초판 EFFICACY 가 `에\s*(?:좋|도움|탁월)` 로 **에 뒤에 올 단어를 열거**해서
    // 이 형태를 전부 놓쳤다(구 패턴은 `치료(에|...)`로 잡던 것 = 검출 축소 회귀).
    // 위 활용형 표가 "예방 효과"(조사 없음)만 담아서 테스트에 안 걸렸다 —
    // 조사가 끼는 변형을 반드시 함께 고정할 것.
    ["치료에 효과가 있다는 후기가 많아요.", "SUPPLEMENT"],
    ["예방에 효과가 있어요.", "FOOD"],
    ["치료에는 효과가 확실합니다.", "SUPPLEMENT"],
    ["피부 재생에 효과적입니다.", "COSMETIC"],
    ["회복에 도움이 됩니다.", "COSMETIC"],
    // 갭 2 — 건기식·미분류 딜에 질병 표방 규칙이 적용되지 않던 케이스
    ["당뇨에 좋아요.", "SUPPLEMENT"],
    ["고혈압에는 이만한 게 없어요, 혈압을 낮춰줍니다.", "SUPPLEMENT"],
    ["치매 예방에 도움이 됩니다.", "SUPPLEMENT"],
    ["탈모 없애는 데 좋아요.", "SUPPLEMENT"],
    ["여드름이 사라져요.", "FOOD"],
    ["완치 효과 확실합니다.", "GENERAL"],
    ["당뇨까지 개선됐어요.", "GENERAL"],
    // 같은 결함이 있던 다른 규칙들
    ["국내에서 유일하게 인정받았습니다.", null],
    ["부작용이 전혀 없어요.", null],
    ["부작용 걱정 없이 드세요.", null],
    ["제일 저렴하게 준비했습니다.", null],
    ["면역력을 높여줍니다.", "SUPPLEMENT"],
    ["디톡스 효과가 좋아요.", "SUPPLEMENT"],
    ["처방받는 약이랑 비슷해요.", "FOOD"],
    ["체지방까지 감소했어요.", "FOOD"],
    ["피부가 재생돼요.", "COSMETIC"],
    ["손상된 피부를 회복시켜 줍니다.", "COSMETIC"],
    ["주름이 사라져요.", "COSMETIC"],
    ["세포를 활성화합니다.", "COSMETIC"],
  ];

  /**
   * 반드시 통과해야 하는 정당 문안 — **오탐 0이 C1 M1의 실측 성과다.**
   * 특히 법정 면책·주의 문구는 오히려 권장되는 표현이라 잡으면 안 된다.
   */
  const MUST_PASS: [string, string | null][] = [
    ["이번 주 금요일 저녁 8시에 오픈합니다. 수량이 한정되어 있어요.", "FOOD"],
    ["배송은 결제 후 2~3일 내에 출발합니다.", "SUPPLEMENT"],
    ["제품 구성은 30포 1박스이고, 하루 한 포 드시면 됩니다.", "SUPPLEMENT"],
    ["국내산 원료만 사용했고 HACCP 인증 시설에서 생산합니다.", "FOOD"],
    ["촉촉한 마무리감이 좋아서 저는 아침 저녁으로 씁니다.", "COSMETIC"],
    ["피부 진정과 보습에 신경 쓴 제품이에요.", "COSMETIC"],
    // 건기식 법정 면책 문구 — 명사 단독 `치료`·`예방`을 잡으면 여기서 터진다.
    ["본 제품은 질병의 예방 및 치료를 위한 의약품이 아닙니다.", "SUPPLEMENT"],
    ["치료 중이신 분은 전문가와 상담 후 섭취하세요.", "SUPPLEMENT"],
    ["병원 치료와 병행하실 분은 담당 의사와 상의해 주세요.", "FOOD"],
    ["질병 치료를 목적으로 하는 제품이 아닙니다.", "FOOD"],
    ["임신 중이거나 특정 질환 치료를 받고 계신 분은 주의하세요.", "SUPPLEMENT"],
    ["부작용이 나타나면 즉시 섭취를 중단하세요.", "SUPPLEMENT"],
    ["개인에 따라 효과는 다를 수 있습니다.", "SUPPLEMENT"],
    ["예방접종을 하신 직후에는 섭취를 피해 주세요.", "SUPPLEMENT"],
    ["화재 예방을 위해 직사광선을 피해 보관하세요.", null],
    ["혈압을 재는 습관을 들이면 좋습니다.", null],
  ];

  it.each(MUST_FLAG)("위반을 잡는다: %s (%s)", (text, category) => {
    const r = checkText(text, { rules: seedRules(), category });
    expect(r.violations.length, `놓침: ${text}`).toBeGreaterThan(0);
  });

  it.each(MUST_PASS)("정당 문안을 통과시킨다: %s (%s)", (text, category) => {
    const r = checkText(text, { rules: seedRules(), category });
    expect(
      r.violations.map((v) => v.matched),
      `오탐: ${text}`,
    ).toEqual([]);
  });

  it("질병 표방 규칙은 공통(category=null)이라 모든 카테고리에 적용된다", () => {
    // 갭 2의 회귀 방지 — 카테고리별로 검출이 갈리면 실패한다.
    for (const category of [
      null,
      "FOOD",
      "SUPPLEMENT",
      "COSMETIC",
      "GENERAL",
    ]) {
      for (const text of ["완치 사례가 많아요.", "당뇨에 좋아요."]) {
        expect(
          checkText(text, { rules: seedRules(), category }).violations.length,
          `[${category ?? "null"}] ${text}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("같은 표현을 두 규칙이 중복 지적하지 않는다 (지적 소음 방지)", () => {
    // 질병 표방을 공통으로 올릴 때 카테고리 규칙과 겹치면 한 문장에 같은
    // 지적이 2건 뜬다 — 운영자가 목록을 신뢰하지 않게 되는 지점이다.
    for (const [text, category] of [
      ["완치 사례가 많아요.", "SUPPLEMENT"],
      ["당뇨에 좋아요.", "FOOD"],
      ["탈모 없애는 데 좋아요.", "COSMETIC"],
    ] as [string, string][]) {
      expect(
        checkText(text, { rules: seedRules(), category }).violations,
        `${text} (${category})`,
      ).toHaveLength(1);
    }
  });

  it("이관으로 대체된 규칙은 시드에 남아 있지 않다", () => {
    // SUPERSEDED_PHRASES 는 프로덕션 정리(--deactivate-superseded)의 입력이다.
    // 시드에 같은 phrase가 되살아나면 비활성 대상과 주입 대상이 충돌한다.
    const live = new Set(BANNED_PHRASE_SEED.map((r) => r.phrase));
    for (const { phrase, supersededBy } of SUPERSEDED_PHRASES) {
      expect(live.has(phrase), `되살아난 이관 규칙: ${phrase}`).toBe(false);
      expect(live.has(supersededBy), `대체 규칙 없음: ${supersededBy}`).toBe(
        true,
      );
    }
  });

  it("phrase는 사전 전체에서 유일하다 (프로덕션 동기화 키)", () => {
    // scripts/seed-banned-phrases.ts --sync 가 phrase로 DB 행을 찾는다.
    // 중복되면 어느 행을 갱신할지 결정할 수 없다.
    const phrases = BANNED_PHRASE_SEED.map((r) => r.phrase);
    expect(new Set(phrases).size).toBe(phrases.length);
  });
});
