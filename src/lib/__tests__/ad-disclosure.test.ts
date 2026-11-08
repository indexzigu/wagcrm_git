import { describe, expect, it } from "vitest";
import {
  AD_DISCLOSURE_LABEL,
  AD_DISCLOSURE_UNCHECKED_LABEL,
  adDisclosureHint,
  adDisclosureSummaryHint,
  autoCaptionFromNotes,
  checkAdDisclosure,
  summarizeAdDisclosure,
  visibleHeadEnd,
  type AdDisclosureKind,
} from "@/lib/claims/ad-disclosure";
import { AUTO_NOTE_PREFIX, nextAutoNote } from "@/lib/reference-enrich";

const kind = (caption: string | null, mediaType?: string | null): AdDisclosureKind =>
  checkAdDisclosure(caption, { mediaType }).kind;

// 접히는 자리 뒤로 밀어내는 채움 — 125자를 넘기는 평범한 문장(표기 낱말 없음).
const FILLER = "오늘 소개할 제품은 아침마다 쓰는 앰플이에요. ".repeat(6);

describe("checkAdDisclosure — 인정하는 한글 표기", () => {
  it.each([
    "#광고 겨울 보습 앰플 공구 오픈합니다",
    "#협찬 겨울 보습 앰플",
    "#유료광고 겨울 보습 앰플",
    "#유료광고포함 겨울 보습 앰플",
    "#광고포함 겨울 보습",
    "#광고#협찬 붙여 쓴 태그",
    "#광고_협찬 밑줄 태그",
    "#광고ad 섞어 쓴 태그",
    "#제품제공 받아서 써봤어요",
    "#제품협찬 받아서 써봤어요",
    "[광고] 겨울 보습 앰플",
    "(광고) 겨울 보습 앰플",
    "【광고】 겨울 보습 앰플",
    "광고/협찬 겨울 보습 앰플",
    "광고 · 협찬 겨울 보습 앰플",
    "본 게시물은 광고입니다",
    "본 게시물은 광고 입니다",
    "유료 광고 포함",
    "브랜드로부터 제품을 제공받아 작성했어요",
    "브랜드로부터 제품 제공 받았어요",
    "브랜드 협찬받아 작성했습니다",
    "소정의 원고료를 받았습니다",
    "브랜드로부터 경제적 대가를 받았습니다",
  ])("머리에 있으면 정상: %s", (caption) => {
    expect(kind(caption)).toBe("OK");
  });

  it("앞 공백·빈 줄은 무시하고 판정한다", () => {
    expect(kind("\n\n   #광고 겨울 앰플")).toBe("OK");
  });

  it("표기 원문 조각을 돌려준다", () => {
    expect(checkAdDisclosure("겨울 앰플 #협찬 진행").found).toBe("#협찬");
  });
});

describe("checkAdDisclosure — 표기로 인정하지 않는 말(경계 오탐)", () => {
  it.each([
    "광고에서 본 그 제품이에요",
    "#광고비 아끼는 법",
    "#광고주 미팅 다녀옴",
    "#광고문의 는 DM",
    "광고 문의는 DM 주세요",
    "#광고모델 지원",
    "#광고촬영 비하인드",
    "#협찬문의 환영",
    "협찬 문의 환영",
    "팔로워 할인제공 이벤트",
    "소정의 선물 드려요",
    "#제공 이벤트 참여",
    "#adventure 여행 기록",
    "#advertising 공부",
  ])("표기 없음으로 본다: %s", (caption) => {
    expect(kind(caption)).toBe("MISSING");
  });
});

describe("checkAdDisclosure — 제외 접미는 태그에 붙은 것만", () => {
  it.each(["#광고 주말 특가 오픈", "#광고 비타민C 앰플", "#협찬 판매 시작", "#협찬 모델 컷 공개"])(
    "띄어 쓴 다음 낱말은 막지 않는다: %s",
    (caption) => {
      expect(kind(caption)).toBe("OK");
    },
  );
});

describe("checkAdDisclosure — 위치", () => {
  it("앞 125자 안이면 정상, 뒤에만 있으면 LATE", () => {
    expect(kind(`${FILLER.slice(0, 100)} #광고`)).toBe("OK");
    expect(kind(`${FILLER} #광고`)).toBe("LATE");
  });

  it("끝 해시태그 무더기 속 표기는 LATE", () => {
    const tags = Array.from({ length: 30 }, (_, i) => `#태그${i}`).join(" ");
    expect(kind(`겨울 보습 앰플 공구 오픈!\n\n${FILLER}\n${tags} #광고`)).toBe("LATE");
  });

  it("사진·캐러셀은 둘째 줄까지, 셋째 줄은 LATE", () => {
    expect(kind("첫 줄 소개\n#광고 둘째 줄")).toBe("OK");
    expect(kind("첫 줄 소개\n둘째 줄\n#광고 셋째 줄")).toBe("LATE");
    expect(kind("첫 줄 소개\n#광고 둘째 줄", "carousel")).toBe("OK");
  });

  it("릴스·영상은 첫 줄만 보인다", () => {
    expect(kind("#광고 첫 줄\n둘째 줄", "reel")).toBe("OK");
    expect(kind("첫 줄 소개\n#광고 둘째 줄", "reel")).toBe("LATE");
    expect(kind("첫 줄 소개\n#광고 둘째 줄", "video")).toBe("LATE");
  });

  it("줄바꿈이 없으면 125자 상한만 본다", () => {
    const longLine = `${"가".repeat(124)} #광고`;
    expect(kind(longLine)).toBe("LATE");
  });

  it("여러 곳이면 가장 앞 것으로 판정한다", () => {
    expect(kind(`#광고 ${FILLER} #협찬`)).toBe("OK");
  });

  it("visibleHeadEnd — 줄 수·125자 중 앞선 쪽", () => {
    expect(visibleHeadEnd("가\n나\n다", null)).toBe(3);
    expect(visibleHeadEnd("가\n나\n다", "reel")).toBe(1);
    expect(visibleHeadEnd("가".repeat(300), null)).toBe(125);
    expect(visibleHeadEnd("가나다", null)).toBe(3);
  });
});

describe("checkAdDisclosure — 부인 표현", () => {
  it.each([
    "광고 아님 내 돈으로 샀어요 #광고",
    "협찬 아님!",
    "광고아니에요 진짜",
    "#광고 협찬 아닙니다",
    "광고 아닙니다 직접 샀어요",
    "광고 아닌 찐후기",
    "제품을 제공받지 않았습니다",
    "협찬 받지 않은 솔직 후기",
  ])(
    "광고·협찬 부인은 표기가 있어도 DENIAL: %s",
    (caption) => {
      expect(kind(caption)).toBe("DENIAL");
    },
  );

  it("「협찬 아니고 광고입니다」는 부인이 아니다", () => {
    expect(kind("협찬 아니고 광고입니다")).toBe("OK");
  });

  it("내돈내산은 머리에 한글 표기가 없을 때만 DENIAL", () => {
    expect(kind("#광고 내돈내산으로 써보고 좋아서 공구 열었어요")).toBe("OK");
    expect(kind("내돈내산 후기! 너무 좋아요")).toBe("DENIAL");
    expect(kind(`내돈 내산 ${FILLER} #광고`)).toBe("DENIAL");
  });
});

describe("checkAdDisclosure — 영문 표기", () => {
  it("영문만 있으면 ENGLISH_ONLY", () => {
    expect(kind("#ad winter ampoule")).toBe("ENGLISH_ONLY");
    expect(kind("#Sponsored 겨울 앰플")).toBe("ENGLISH_ONLY");
  });

  it("한글 표기가 뒤에 있으면 LATE 가 우선", () => {
    expect(kind(`#ad ${FILLER} #광고`)).toBe("LATE");
  });
});

describe("checkAdDisclosure — 결과 종류와 조치 여부", () => {
  it("빈 값·공백만은 판정불가(조치 아님)", () => {
    for (const c of [null, undefined, "", "   \n "]) {
      const r = checkAdDisclosure(c);
      expect(r.kind).toBe("NO_CAPTION");
      expect(r.needsAction).toBe(false);
    }
  });

  it("OK 는 조치 아님, 나머지 넷은 조치 대상", () => {
    expect(checkAdDisclosure("#광고 앰플").needsAction).toBe(false);
    expect(checkAdDisclosure("앰플").needsAction).toBe(true);
    expect(checkAdDisclosure("#ad 앰플").needsAction).toBe(true);
    expect(checkAdDisclosure("광고 아님").needsAction).toBe(true);
    expect(checkAdDisclosure(`${FILLER} #광고`).needsAction).toBe(true);
  });
});

describe("autoCaptionFromNotes — 점검 입력은 자동수집 캡션만", () => {
  it("자동수집 접두가 있으면 캡션(좋아요 꼬리 제거)", () => {
    expect(autoCaptionFromNotes(`${AUTO_NOTE_PREFIX}#광고 앰플 · 좋아요 12`)).toBe("#광고 앰플");
  });

  it("오너 수기 메모·빈 값은 null(점검하지 않는다)", () => {
    expect(autoCaptionFromNotes("셀러에게 재촬영 요청함")).toBeNull();
    expect(autoCaptionFromNotes(null)).toBeNull();
    expect(autoCaptionFromNotes("")).toBeNull();
  });

  it("줄바꿈을 보존한다", () => {
    expect(autoCaptionFromNotes(`${AUTO_NOTE_PREFIX}첫 줄\n#광고`)).toBe("첫 줄\n#광고");
  });
});

describe("summarizeAdDisclosure · 화면 문구", () => {
  it("조치 대상 수와 판정불가 수를 센다", () => {
    const s = summarizeAdDisclosure([
      checkAdDisclosure("#광고 a"),
      checkAdDisclosure("a"),
      checkAdDisclosure("광고 아님"),
      checkAdDisclosure(null),
    ]);
    expect(s).toEqual({ flagged: 2, unchecked: 1, checked: 3 });
  });

  it("배지 낱말은 붙여 쓴 한 낱말", () => {
    expect(AD_DISCLOSURE_LABEL).toBe("광고표기미흡");
    expect(AD_DISCLOSURE_LABEL).not.toMatch(/\s/);
  });

  it("설명창은 사유별 문구 + 찾은 표기 + 기준", () => {
    const late = adDisclosureHint(checkAdDisclosure(`${FILLER} #협찬`));
    expect(late).toContain("더 보기");
    expect(late).toContain("#협찬");
    expect(late).toContain("(최근 수집한 본문 기준)");
    expect(late).not.toContain(" · ");
    expect(adDisclosureHint(checkAdDisclosure("앰플"))).toContain("찾지 못했습니다");
    expect(adDisclosureHint(checkAdDisclosure("#ad 앰플"))).toContain("영문");
    expect(adDisclosureHint(checkAdDisclosure("내돈내산"))).toContain("내돈내산");
  });

  it("조치 대상이 아니면 설명창 문구가 없다", () => {
    expect(adDisclosureHint(checkAdDisclosure("#광고 a"))).toBeNull();
    expect(adDisclosureHint(checkAdDisclosure(null))).toBeNull();
  });
});

describe("nextAutoNote — 수집기의 자동수집 메모 갱신 규칙", () => {
  it("비어 있으면 새로 쓴다", () => {
    expect(nextAutoNote(null, "#광고 앰플", 3)).toBe(`${AUTO_NOTE_PREFIX}#광고 앰플 · 좋아요 3`);
    expect(nextAutoNote("", "#광고 앰플", null)).toBe(`${AUTO_NOTE_PREFIX}#광고 앰플`);
  });

  it("자동수집 메모는 최신 캡션으로 갱신한다(셀러가 고친 뒤 재판정)", () => {
    expect(nextAutoNote(`${AUTO_NOTE_PREFIX}앰플 · 좋아요 3`, "#광고 앰플", 3)).toBe(
      `${AUTO_NOTE_PREFIX}#광고 앰플 · 좋아요 3`,
    );
  });

  it("캡션이 같으면 쓰지 않는다 — 좋아요만 달라도(null)", () => {
    expect(nextAutoNote(`${AUTO_NOTE_PREFIX}#광고 앰플 · 좋아요 3`, "#광고 앰플", 3)).toBeNull();
    expect(nextAutoNote(`${AUTO_NOTE_PREFIX}#광고 앰플 · 좋아요 3`, "#광고 앰플", 90)).toBeNull();
    expect(nextAutoNote(`${AUTO_NOTE_PREFIX}#광고 앰플`, "#광고 앰플", 90)).toBeNull();
  });

  it("앞부분만 같은 다른 캡션은 갱신한다", () => {
    expect(nextAutoNote(`${AUTO_NOTE_PREFIX}#광고 앰플 · 좋아요 3`, "#광고 앰플 2탄", 3)).toBe(
      `${AUTO_NOTE_PREFIX}#광고 앰플 2탄 · 좋아요 3`,
    );
  });

  it("오너 수기 메모는 절대 덮지 않는다", () => {
    expect(nextAutoNote("재촬영 요청함", "#광고 앰플", 3)).toBeNull();
  });

  it("캡션이 비면 쓰지 않는다(기존 메모 보존)", () => {
    expect(nextAutoNote(`${AUTO_NOTE_PREFIX}앰플`, "", 3)).toBeNull();
    expect(nextAutoNote(null, null, 3)).toBeNull();
    expect(nextAutoNote(null, "   ", 3)).toBeNull();
  });
});

describe("adDisclosureSummaryHint — 머리 설명창", () => {
  it("미흡·미수집 건수와 법률 판단 아님 고지를 담는다", () => {
    const hint = adDisclosureSummaryHint({ flagged: 2, unchecked: 1, checked: 5 });
    expect(hint).toContain("5건 중 2건");
    expect(hint).toContain("수집하지 못한 등록 게시물 1건");
    expect(hint).toContain("법률 판단이 아닙니다");
  });

  it("미수집만 있으면 미흡 문장을 넣지 않는다", () => {
    const hint = adDisclosureSummaryHint({ flagged: 0, unchecked: 3, checked: 0 });
    expect(hint).not.toContain("부족합니다");
    expect(hint).toContain("3건");
  });

  it("미점검 낱말도 붙여 쓴 한 낱말", () => {
    expect(AD_DISCLOSURE_UNCHECKED_LABEL).not.toMatch(/\s/);
  });
});
