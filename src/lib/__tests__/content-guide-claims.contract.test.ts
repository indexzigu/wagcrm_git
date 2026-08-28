import { describe, expect, it } from "vitest";
import {
  buildClaimBlock,
  buildContentGuidePrompt,
  buildPreviousStructureBlock,
  buildProofCard,
  explainProofCardAbsence,
  buildSellerChannelBlock,
  parseGuideCut,
  PROOF_CARD_HEADER,
  type GuideClaims,
  type GuideDealContext,
  type GuideSellerChannel,
} from "@/lib/content-guide";

/**
 * 콘텐츠 가이드 × C1 클레임 게이트 연결의 계약 (C3 M1).
 *
 * 왜 이 테스트가 있나: C1 레지스트리를 다섯 PR에 걸쳐 만들었는데 **생성물은
 * 게이트 밖으로 나가고 있었다**(코드에 claim 참조 0건). 그 구멍을 막은 것이
 * C3 M1 이고, 아래 계약이 다시 열리는 것을 방지한다.
 *
 * 고정하는 것:
 * - 승인 소구점·금지 표현·필수 고지가 **프롬프트에 실제로 들어간다**
 * - 근거는 **DB 값 그대로** 들어간다(모델 재작성 금지 — §5·§8)
 * - `NEEDS_SOURCE` 도 승인분이면 소구점으로는 쓸 수 있다(근거 카드는 M2 소관)
 * - 승인 0건이어도 **생성은 막지 않되** 단정 자제 지시가 들어간다(§9-Q3)
 * - 클레임 구획이 **참고 자료보다 앞**에 온다 — 뒤 구획 표현에 휩쓸리지 않게
 */

const DEAL: GuideDealContext = {
  dealName: "테스트 공구 상품",
  brandName: "테스트브랜드",
  partnerCompanyName: null,
  sourcingMemo: null,
  sellingPrice: 14000,
  listPrice: 20000,
  discountRate: 30,
  unit: "박스",
  unitQuantity: 2,
  searchKeyword: null,
  modelName: null,
};

const CLAIMS: GuideClaims = {
  approved: [
    {
      text: "국내산 원료만 사용",
      evidence: "시험성적서 2026-001",
      evidenceType: "MEASURED",
    },
    {
      text: "한 포에 담은 하루 분량",
      evidence: null,
      evidenceType: "NEEDS_SOURCE",
    },
  ],
  banned: ["리뉴얼 전 재고"],
  disclosures: ["유료 광고 표기 필수"],
};

describe("buildClaimBlock", () => {
  it("승인 소구점·금지 표현·필수 고지를 모두 담는다", () => {
    const block = buildClaimBlock(CLAIMS);
    expect(block).toContain("국내산 원료만 사용");
    expect(block).toContain("한 포에 담은 하루 분량");
    expect(block).toContain("리뉴얼 전 재고");
    expect(block).toContain("유료 광고 표기 필수");
  });

  it("근거를 DB 값 그대로 넣는다 — 모델이 재작성하지 못하게", () => {
    const block = buildClaimBlock(CLAIMS);
    expect(block).toContain("근거: 시험성적서 2026-001");
  });

  it("근거가 없는 승인 소구점도 표현으로는 쓸 수 있다", () => {
    const block = buildClaimBlock(CLAIMS);
    // 근거 괄호 없이 표현만 등장
    expect(block).toContain("- 한 포에 담은 하루 분량");
    expect(block).not.toContain("한 포에 담은 하루 분량 (근거:");
  });

  it("승인 0건이면 생성을 막지 않고 단정 자제를 지시한다 (오너 결정 §9-Q3)", () => {
    const block = buildClaimBlock({
      approved: [],
      banned: [],
      disclosures: [],
    });
    expect(block).toContain("승인된 소구점이 등록되지 않았습니다");
    expect(block).toContain("단정");
  });

  it("빈 목록의 소제목은 만들지 않는다 — 프롬프트 노이즈 방지", () => {
    const block = buildClaimBlock({
      approved: CLAIMS.approved,
      banned: [],
      disclosures: [],
    });
    expect(block).not.toContain("[금지 표현");
    expect(block).not.toContain("[필수 고지");
  });

  it("공백뿐인 근거는 근거로 취급하지 않는다", () => {
    const block = buildClaimBlock({
      approved: [{ text: "표현", evidence: "   ", evidenceType: "MEASURED" }],
      banned: [],
      disclosures: [],
    });
    expect(block).not.toContain("근거:");
  });
});

describe("buildContentGuidePrompt × 클레임", () => {
  it("클레임을 넘기면 user 프롬프트에 제약 구획이 들어간다", () => {
    const { user } = buildContentGuidePrompt("CONTENT_GUIDE", DEAL, [], [], CLAIMS);
    expect(user).toContain("딜 표현 제약");
    expect(user).toContain("국내산 원료만 사용");
  });

  it("클레임을 안 넘기면 제약 구획이 없다 (기존 동작 보존)", () => {
    const { user } = buildContentGuidePrompt("CONTENT_GUIDE", DEAL, [], []);
    expect(user).not.toContain("딜 표현 제약");
  });

  it("제약 구획이 참고 자료보다 앞에 온다", () => {
    const refs = [
      {
        name: "ref1",
        url: "https://example.com/1",
        caption: "참고 캡션",
        likes: 10,
      },
    ];
    const { user } = buildContentGuidePrompt("CONTENT_GUIDE", DEAL, refs, [], CLAIMS);
    const claimAt = user.indexOf("딜 표현 제약");
    const refAt = user.indexOf("참고 캡션");
    expect(claimAt).toBeGreaterThan(-1);
    expect(refAt).toBeGreaterThan(-1);
    // 제약을 먼저 읽어야 뒤 구획의 표현에 휩쓸리지 않는다
    expect(claimAt).toBeLessThan(refAt);
  });

  it("system 프롬프트가 제약을 다른 지시보다 우선하라고 못박는다", () => {
    const { system } = buildContentGuidePrompt("CONTENT_GUIDE", DEAL, [], [], CLAIMS);
    expect(system).toContain("다른 모든 지시보다 우선");
    expect(system).toContain("목록에 없는 효과를 만들어 쓰지 마십시오");
  });

  /**
   * 실사고 2026-08-02: 릴스는 컷 프레임이 섰는데 **인스타 피드만 시안이 비었다.**
   * 모델이 이미지 채널을 `첫 장: …` 콜론 표기로 내보내 `parseGuideCut` 이 컷으로
   * 읽지 못한 것이 원인이었다(프롬프트가 "시간 대신 자리를 쓴다"고만 하고 형식을
   * 다시 못박지 않았다). 형식 지시가 프롬프트에서 빠지면 같은 침묵형 실패가 난다 —
   * 화면은 오류 없이 그냥 프레임이 없는 채로 정상처럼 보인다.
   */
  it("이미지·글 채널에도 컷 형식과 예시를 못박는다", () => {
    const { system } = buildContentGuidePrompt("CONTENT_GUIDE", DEAL, [], []);
    expect(system).toContain("이미지·글 채널도 똑같이");
    expect(system).toContain("C1 · 자리 | 피사체 | 하는 일");
    // 예시가 실제로 파싱되는 형식이어야 지시가 자기모순이 아니다.
    const example = system
      .split("\n")
      .find((line) => line.includes("첫 장 |"))
      ?.match(/`- (C1 · 첫 장 \|[^`]+)`/)?.[1];
    expect(example, "이미지 채널 예시 컷을 찾지 못했다").toBeTruthy();
    expect(parseGuideCut(example!)?.slot).toBe("첫 장");
  });
});

describe("buildProofCard — 근거 카드 조립 (C3 M2)", () => {
  it("근거가 붙은 승인 소구점을 근거·라벨과 함께 담는다", () => {
    const card = buildProofCard(CLAIMS)!;
    expect(card).toContain(PROOF_CARD_HEADER);
    expect(card).toContain("국내산 원료만 사용 → 시험성적서 2026-001 [실측]");
  });

  it("NEEDS_SOURCE 는 제외한다 — 인용할 수 없는 것을 근거로 보이게 하지 않는다", () => {
    const card = buildProofCard(CLAIMS)!;
    expect(card).not.toContain("한 포에 담은 하루 분량");
  });

  it("근거 문구를 그대로 넣는다 — 모델 재작성 경로를 만들지 않는다", () => {
    const card = buildProofCard({
      approved: [
        {
          text: "표현",
          evidence: "식약처 인증 제2026-1234호 (2026-03-01)",
          evidenceType: "MEASURED",
        },
      ],
      banned: [],
      disclosures: [],
    })!;
    expect(card).toContain("식약처 인증 제2026-1234호 (2026-03-01)");
  });

  it("USER_PROVIDED 는 '브랜드 제공'으로 라벨링한다", () => {
    const card = buildProofCard({
      approved: [
        {
          text: "표현",
          evidence: "브랜드 공문 2026-05-01",
          evidenceType: "USER_PROVIDED",
        },
      ],
      banned: [],
      disclosures: [],
    })!;
    expect(card).toContain("[브랜드 제공]");
  });

  it("인용 범위 안내를 반드시 붙인다", () => {
    const card = buildProofCard(CLAIMS)!;
    expect(card).toContain("이 범위를 넘지 않도록");
  });

  it("쓸 수 있는 근거가 없으면 null — 섹션 자체를 만들지 않는다", () => {
    expect(
      buildProofCard({
        approved: [
          { text: "표현", evidence: null, evidenceType: "NEEDS_SOURCE" },
        ],
        banned: [],
        disclosures: [],
      }),
    ).toBeNull();
    expect(
      buildProofCard({ approved: [], banned: [], disclosures: [] }),
    ).toBeNull();
  });

  it("evidenceType 이 MEASURED 라도 근거 문구가 비면 제외한다", () => {
    expect(
      buildProofCard({
        approved: [{ text: "표현", evidence: "   ", evidenceType: "MEASURED" }],
        banned: [],
        disclosures: [],
      }),
    ).toBeNull();
  });

  it("모르는 evidenceType 은 원문을 라벨로 쓴다 (렌더가 깨지지 않게)", () => {
    const card = buildProofCard({
      approved: [
        { text: "표현", evidence: "근거", evidenceType: "FUTURE_TYPE" },
      ],
      banned: [],
      disclosures: [],
    })!;
    expect(card).toContain("[FUTURE_TYPE]");
  });

  it("근거 카드를 프롬프트에 요구하지 않는다 — 모델이 만드는 섹션이 아니다", () => {
    const { system } = buildContentGuidePrompt("CONTENT_GUIDE", DEAL, [], [], CLAIMS);
    expect(system).not.toContain(PROOF_CARD_HEADER);
  });
});

describe("buildSellerChannelBlock — 채널별 앵글 (C3 M5)", () => {
  const IG: GuideSellerChannel = {
    snsType: "INSTAGRAM",
    followers: 128400,
    category: "Beauty",
  };
  const YT: GuideSellerChannel = {
    snsType: "YOUTUBE",
    followers: 84200,
    category: "Living",
  };

  it("채널·팔로워·카테고리를 읽는 말로 담는다", () => {
    const block = buildSellerChannelBlock([IG])!;
    expect(block).toContain("인스타그램");
    expect(block).toContain("128,400명");
    expect(block).toContain("Beauty");
  });

  it("여러 채널을 모두 담는다", () => {
    const block = buildSellerChannelBlock([IG, YT])!;
    expect(block).toContain("인스타그램");
    expect(block).toContain("유튜브");
  });

  it("셀러가 없으면 null — 없는 셀러를 가정해 좁히면 틀린다", () => {
    expect(buildSellerChannelBlock([])).toBeNull();
  });

  it("팔로워 0(미집계)은 표기하지 않는다", () => {
    const block = buildSellerChannelBlock([
      { snsType: "INSTAGRAM", followers: 0, category: null },
    ])!;
    expect(block).not.toContain("팔로워");
    expect(block).toContain("인스타그램");
  });

  it("모르는 채널 타입은 원문을 쓴다 (렌더가 깨지지 않게)", () => {
    const block = buildSellerChannelBlock([
      { snsType: "THREADS", followers: 100, category: null },
    ])!;
    expect(block).toContain("THREADS");
  });
});

describe("buildContentGuidePrompt × 셀러 채널", () => {
  const IG: GuideSellerChannel = {
    snsType: "INSTAGRAM",
    followers: 1000,
    category: null,
  };

  it("셀러를 넘기면 채널 구획이 프롬프트에 들어간다", () => {
    const { user } = buildContentGuidePrompt("CONTENT_GUIDE", DEAL, [], [], CLAIMS, [IG]);
    expect(user).toContain("이 딜에 붙은 셀러 채널");
    expect(user).toContain("인스타그램");
  });

  it("셀러를 안 넘기면 채널 구획이 없다 (기존 동작 보존)", () => {
    const { user } = buildContentGuidePrompt("CONTENT_GUIDE", DEAL, [], [], CLAIMS);
    expect(user).not.toContain("이 딜에 붙은 셀러 채널");
  });

  it("채널 구획이 클레임 제약보다 앞에 온다", () => {
    const { user } = buildContentGuidePrompt("CONTENT_GUIDE", DEAL, [], [], CLAIMS, [IG]);
    const sellerAt = user.indexOf("이 딜에 붙은 셀러 채널");
    const claimAt = user.indexOf("딜 표현 제약");
    expect(sellerAt).toBeGreaterThan(-1);
    expect(sellerAt).toBeLessThan(claimAt);
  });

  it("붙은 채널만 다루라고 지시한다 — 버려지는 자료를 만들지 않게", () => {
    const { system } = buildContentGuidePrompt("CONTENT_GUIDE", DEAL, [], [], CLAIMS, [IG]);
    expect(system).toContain("거기 있는 채널만");
    expect(system).toContain("버려집니다");
  });

  it("길이별 분화와 '기획 골격만' 제약을 지시한다 (촬영 대본 완성 금지)", () => {
    const { system } = buildContentGuidePrompt("CONTENT_GUIDE", DEAL, [], [], CLAIMS, [IG]);
    expect(system).toContain("15~30초");
    expect(system).toContain("기획 골격");
    // 숏폼 완전 자동 제작은 비목표다(business_model.md §6)
    expect(system).toContain("실제 촬영·편집은 셀러가 합니다");
  });
});

/**
 * 컷 기획 수준 계약 (오너 지적 2026-08-02).
 *
 * 형식(컷 파이프·눈에 보이는 것만)만 강제하고 기획 수준을 지정하지 않으면 모델은
 * 가장 안전한 제품 소개서 순서(착용→디테일→활용→혜택)로 수렴한다 — 실제로 그렇게
 * 나왔다. 이 지시들이 빠지면 그 수렴이 재발하므로 존재를 고정한다.
 */
describe("컷 기획 수준 — 기초 구성 금지·자막 유도", () => {
  it("제품 소개서 순서를 명시적으로 금지하고 검증된 장치를 요구한다", () => {
    const { system } = buildContentGuidePrompt("CONTENT_GUIDE", DEAL, [], [], CLAIMS);
    expect(system).toContain("제품 소개서 순서로 컷을 짜면 실패작");
    expect(system).toContain("3초 반전");
    // 장치 사용을 자기 신고하게 한다 — 이 줄이 없으면 기초 구성으로 간주.
    expect(system).toContain("장치: ");
  });

  it("장치 목록은 메뉴가 아니라 예시다 — 고정 메뉴는 새 템플릿이 된다 (오너 방향 2026-08-02)", () => {
    // 닫힌 목록("최소 1개 골라")로 쓰면 모델이 5개를 돌려쓰고, 그 목록이
    // "착용→디테일→활용→혜택"의 다음 버전이 된다. 열림 표시가 사라지면 재발이다.
    const { system } = buildContentGuidePrompt("CONTENT_GUIDE", DEAL, [], [], CLAIMS);
    expect(system).toContain("예시일 뿐");
    expect(system).toContain("목록에 없는 구조");
    // 심사 대상은 장치 이름이 아니라 상품 특성과 결합된 이유다.
    expect(system).toContain("이 상품의 어떤 특성 때문인지");
    expect(system).not.toContain("최소 1개 골라");
  });

  it("타깃 명시와 구매 트리거 정합을 요구한다", () => {
    const { system } = buildContentGuidePrompt("CONTENT_GUIDE", DEAL, [], [], CLAIMS);
    expect(system).toContain("타깃:");
    expect(system).toContain("FOMO");
  });

  it("촬영·편집 전문용어를 금지한다 — 읽는 셀러의 95%가 비전공자다 (오너 2026-08-02)", () => {
    // 시안 이미지가 지시를 전달하는 주 매체이고, 텍스트는 비전공자가 휴대폰으로
    // 바로 따라 할 수 있는 일상어여야 한다. 용어를 쓰면 그 줄은 전달되지 않는다.
    const { system } = buildContentGuidePrompt("CONTENT_GUIDE", DEAL, [], [], CLAIMS);
    expect(system).toContain("영상·디자인 비전공자");
    for (const jargon of ["클로즈업", "인서트 컷", "풀샷", "트랜지션", "앵글"]) {
      expect(system).toContain(jargon); // 금지 목록에 이름이 실제로 올라 있는가
    }
    expect(system).toContain("일상어로 바꿔 쓰십시오");
  });

  it("핵심 카피를 캡션이 아니라 화면 자막으로 유도한다", () => {
    const { system } = buildContentGuidePrompt("CONTENT_GUIDE", DEAL, [], [], CLAIMS);
    expect(system).toContain("캡션이 아니라 화면 자막");
    expect(system).toContain("자막: C1");
    // 캡션의 남은 역할이 명시돼야 한다 — 안 그러면 캡션에도 카피가 중복된다.
    expect(system).toContain("#광고·해시태그·구매 안내만");
  });

  it("종전 '캡션 첫 3줄' 유도는 남아 있지 않다 — 자막 유도와 상충한다", () => {
    const { system } = buildContentGuidePrompt("CONTENT_GUIDE", DEAL, [], [], CLAIMS);
    expect(system).not.toContain("캡션 첫 3줄");
  });
});

/**
 * 콘텐츠 전략 층 계약 (오너 확정 2026-08-02).
 *
 * 전략: 콘텐츠가 파는 것은 상품이 아니라 소비자의 **경험적 정체성**이다 —
 * 시각적 감성 자극 × 힙한 브랜드 스토리 × 진입장벽 낮은 감각적 경험의 조합으로
 * "나를 잘 돌보는 감각적인 사람"이라는 자기 인식과 효능감을 설계한다.
 */
describe("콘텐츠 전략 — 경험적 정체성 디자인", () => {
  it("전략 블록이 세 요소와 함께 존재한다", () => {
    const { system } = buildContentGuidePrompt("CONTENT_GUIDE", DEAL, [], [], CLAIMS);
    expect(system).toContain("경험적 정체성 디자인");
    expect(system).toContain("시각적 감성 자극");
    expect(system).toContain("브랜드 스토리");
    expect(system).toContain("진입장벽 낮은 감각적 경험");
  });

  it("정체성은 자유, 효능은 게이트 — 전략이 클레임 게이트를 열지 않는다", () => {
    // 효능감(자기 인식)과 효능(성능 주장)의 경계가 프롬프트에 명시돼야 한다.
    // 이 줄이 빠지면 "효능감을 느끼게 하라"가 효능 단정의 면허로 읽힌다.
    const { system } = buildContentGuidePrompt("CONTENT_GUIDE", DEAL, [], [], CLAIMS);
    expect(system).toContain("효능·효과는 여전히 클레임 게이트 안에서만");
  });

  it("훅·자막까지 정체성 언어로 관통한다", () => {
    const { system } = buildContentGuidePrompt("CONTENT_GUIDE", DEAL, [], [], CLAIMS);
    expect(system).toContain("그 상품을 쓰는 사람의 모습");
    expect(system).toContain("정체성의 언어");
  });

  it("'착각'이라는 단어는 쓰지 않는다 — PUBLIC 레포 소스다", () => {
    // 오너 원문("기분좋은 착각")의 의도는 열망적 정체성 설계이고 그 내용은 위
    // 블록에 담겼다. 그러나 "소비자가 착각하게 만들어라"로 읽히는 문구가 공개
    // 소스에 박히면 브랜드 역풍 소재가 된다(P0 공개 레포 판단, 2026-08-02).
    const { system } = buildContentGuidePrompt("CONTENT_GUIDE", DEAL, [], [], CLAIMS);
    expect(system).not.toContain("착각");
  });
});

/**
 * N차 재생성 변주 계약 (오너 방향 2026-08-02).
 *
 * 배경: 발행 콘텐츠는 전량 수집되지 않아 발행 이력 기반 변주는 불가능한 환경이다.
 * 우리가 아는 유일한 이력은 직전 저장 초안이고, 재생성은 최소한 그것과 구조가
 * 달라야 한다("N차마다 동일 포맷 제작은 콘텐츠 방향성에 맞지 않다").
 */
describe("직전 초안 구조 반복 금지", () => {
  const PREV_BODY = [
    "## 포맷 추천",
    "### 인스타그램 릴스 15~30초",
    "- C1 · 0~3초 | 조명 아래서 반지를 돌린다 | 시선",
    "- C2 · 3~10초 | 무채색 착장에 착용한다 | 변화",
    "- 장치: 3초 반전 — 착용 전후 대비가 한눈에 보이는 상품이라",
  ].join("\n");

  it("직전 초안에서 컷 자리·피사체와 장치 줄만 추출한다 — 문장 앵커 차단", () => {
    const block = buildPreviousStructureBlock(PREV_BODY)!;
    expect(block).toContain("C1 · 0~3초 | 조명 아래서 반지를 돌린다");
    expect(block).toContain("장치: 3초 반전");
    // '하는 일' 칸(카피)은 넣지 않는다 — 피하라고 준 자료가 표현 앵커가 된다.
    expect(block).not.toContain("시선");
  });

  it("컷 없는 초안(카톡 전용 등)이면 구획을 만들지 않는다", () => {
    expect(buildPreviousStructureBlock("## 주의사항\n- 단정 금지")).toBeNull();
  });

  it("직전 초안을 주면 반복 금지 구획이 참고 자료보다 앞에 온다", () => {
    const { user } = buildContentGuidePrompt(
      "CONTENT_GUIDE",
      DEAL,
      [{ name: "ref", caption: "캡션", likes: 10, url: "https://x/1" }],
      [],
      CLAIMS,
      [],
      PREV_BODY,
    );
    const prevAt = user.indexOf("직전 초안의 컷 구조(반복 금지)");
    const refAt = user.indexOf("참고 자료");
    expect(prevAt).toBeGreaterThan(-1);
    expect(prevAt).toBeLessThan(refAt);
  });

  it("직전 초안이 없으면 구획도 없다", () => {
    const { user } = buildContentGuidePrompt("CONTENT_GUIDE", DEAL, [], [], CLAIMS);
    expect(user).not.toContain("반복 금지");
  });

  it("system 이 반복 금지 구획의 처리 방법을 지시한다", () => {
    const { system } = buildContentGuidePrompt("CONTENT_GUIDE", DEAL, [], [], CLAIMS);
    expect(system).toContain("같은 장치·같은 컷 전개를 반복하지 마십시오");
  });
});

/**
 * 근거 카드 **부재 사유** 계약 (C3 §5 마지막 요구, 2026-07-30 추가).
 *
 * §5 는 "근거가 0건이면 섹션을 **생략하고**, 그 사실을 운영자에게 알린다"고 적었다.
 * 생략은 `buildProofCard` 가 하고 있었지만 **알리는 쪽이 비어 있었다** — 라우트가
 * `proofCardIncluded: false` 를 실어 보내는데 화면은 그 값을 M4 저장용 메타로만 쓰고
 * 표시하지 않았다(라우트는 정보를 주는데 화면이 버리는 패턴 — 게이트 위반 표시에서도
 * 한 번 있었던 같은 종류의 누락).
 *
 * ⚠️ **이 판정을 화면에서 재추론하지 않는 것이 계약의 핵심이다.** 화면이
 * `proofCardIncluded` + `approvedClaimCount` 두 값으로 이유를 유추하면
 * `buildProofCard` 의 실제 조건(근거 문자열이 공백만인 경우도 제외)과 조용히
 * 갈라진다. 그래서 같은 입력을 받는 순수 함수로 두고, 아래 테스트가 **두 함수가
 * 어긋날 수 없음**을 고정한다.
 */
describe("explainProofCardAbsence — 근거 카드 부재 사유 (C3 §5)", () => {
  it("카드가 붙으면 사유가 없다(null)", () => {
    expect(buildProofCard(CLAIMS)).not.toBeNull();
    expect(explainProofCardAbsence(CLAIMS)).toBeNull();
  });

  it("승인 소구점이 0건이면 NO_APPROVED_CLAIMS — 운영자가 할 일은 **승인**이다", () => {
    const empty: GuideClaims = { approved: [], banned: [], disclosures: [] };
    expect(explainProofCardAbsence(empty)).toBe("NO_APPROVED_CLAIMS");
  });

  it("승인은 있는데 전부 NEEDS_SOURCE 면 NO_EVIDENCE — 할 일은 **근거 입력**이다", () => {
    // 두 경우를 구분하는 이유가 이것이다: 조치가 다르다.
    expect(
      explainProofCardAbsence({
        approved: [
          { text: "국내산 원료만 사용", evidence: null, evidenceType: "NEEDS_SOURCE" },
        ],
        banned: [],
        disclosures: [],
      }),
    ).toBe("NO_EVIDENCE");
  });

  it("근거 라벨은 있는데 근거 문자열이 공백만이어도 NO_EVIDENCE", () => {
    // 화면이 `evidenceType` 만 보고 유추하면 여기서 갈라진다 —
    // `buildProofCard` 는 공백 근거도 제외하기 때문이다.
    expect(
      explainProofCardAbsence({
        approved: [
          { text: "국내산 원료만 사용", evidence: "   ", evidenceType: "MEASURED" },
        ],
        banned: [],
        disclosures: [],
      }),
    ).toBe("NO_EVIDENCE");
  });

  it("⚠️ buildProofCard 와 절대 어긋나지 않는다 — 같은 입력, 반대 판정", () => {
    // 이 단언이 계약의 본체다. 한쪽 조건만 고치면 여기서 깨진다.
    const cases: GuideClaims[] = [
      CLAIMS,
      { approved: [], banned: [], disclosures: [] },
      {
        approved: [{ text: "A", evidence: null, evidenceType: "NEEDS_SOURCE" }],
        banned: [],
        disclosures: [],
      },
      {
        approved: [{ text: "A", evidence: "", evidenceType: "USER_PROVIDED" }],
        banned: [],
        disclosures: [],
      },
      {
        approved: [
          { text: "A", evidence: null, evidenceType: "NEEDS_SOURCE" },
          { text: "B", evidence: "인증번호 X-1", evidenceType: "USER_PROVIDED" },
        ],
        banned: [],
        disclosures: [],
      },
    ];
    for (const claims of cases) {
      const hasCard = buildProofCard(claims) !== null;
      const reason = explainProofCardAbsence(claims);
      expect(hasCard, JSON.stringify(claims)).toBe(reason === null);
    }
  });
});
