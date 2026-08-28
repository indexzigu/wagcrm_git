import { describe, expect, it } from "vitest";
import {
  findDuplicateAsset,
  planKakaoInboxItems,
  prepareInboxItems,
  splitUrlText,
} from "@/lib/reference-inbox";
import { extractContentUrls } from "@/lib/reference-url";

describe("splitUrlText", () => {
  it("줄바꿈으로 여러 URL을 분해한다", () => {
    const text = "https://a.com/1\nhttps://b.com/2\nhttps://c.com/3";
    expect(splitUrlText(text)).toEqual([
      "https://a.com/1",
      "https://b.com/2",
      "https://c.com/3",
    ]);
  });

  it("쉼표·공백·탭·빈 줄을 관대하게 처리한다", () => {
    const text = "  https://a.com/1 ,\n\n\thttps://b.com/2  \n  ";
    expect(splitUrlText(text)).toEqual(["https://a.com/1", "https://b.com/2"]);
  });

  it("빈 문자열은 빈 배열을 반환한다", () => {
    expect(splitUrlText("")).toEqual([]);
    expect(splitUrlText("   \n  \t ")).toEqual([]);
  });
});

describe("prepareInboxItems", () => {
  it("유효한 URL을 정규화해 생성 후보로 만든다", () => {
    const plan = prepareInboxItems(["https://www.instagram.com/reel/ABC123/"], []);
    expect(plan.invalid).toBe(0);
    expect(plan.skipped).toBe(0);
    expect(plan.toCreate).toHaveLength(1);
    // 인스타 호스트는 트래킹 쿼리 제거 + 표시명은 host/경로2세그먼트
    expect(plan.toCreate[0].normalizedUrl).toBe(
      "https://www.instagram.com/reel/ABC123/",
    );
    expect(plan.toCreate[0].linkName).toBe("instagram.com/reel/ABC123");
    expect(plan.toCreate[0].rawUrl).toBe("https://www.instagram.com/reel/ABC123/");
  });

  it("인스타 공유 트래킹 쿼리를 제거해 정규화한다", () => {
    const plan = prepareInboxItems(
      ["https://www.instagram.com/reel/ABC123/?igsh=xyz&utm_source=ig_web"],
      [],
    );
    expect(plan.toCreate).toHaveLength(1);
    expect(plan.toCreate[0].normalizedUrl).toBe(
      "https://www.instagram.com/reel/ABC123/",
    );
  });

  it("무효 URL(비 http/https·파싱불가)은 invalid로 집계한다", () => {
    const plan = prepareInboxItems(
      ["instagram://user?x=1", "not a url", "ftp://files.example.com/a"],
      [],
    );
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.invalid).toBe(3);
    expect(plan.skipped).toBe(0);
  });

  it("이미 존재하는 normalizedUrl은 skipped로 집계한다", () => {
    const plan = prepareInboxItems(
      ["https://youtube.com/watch?v=abc"],
      ["https://youtube.com/watch?v=abc"],
    );
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.skipped).toBe(1);
    expect(plan.invalid).toBe(0);
  });

  it("같은 배치 안의 중복(정규화 후 동일)은 한 번만 생성하고 나머지는 skipped", () => {
    const plan = prepareInboxItems(
      [
        "https://www.instagram.com/reel/DUP/?igsh=1",
        "https://www.instagram.com/reel/DUP/?utm_source=2",
        "https://www.instagram.com/reel/DUP/",
      ],
      [],
    );
    expect(plan.toCreate).toHaveLength(1);
    expect(plan.skipped).toBe(2);
    expect(plan.invalid).toBe(0);
  });

  it("무효·중복·신규가 섞인 입력의 부분성공 집계가 정확하다", () => {
    const plan = prepareInboxItems(
      [
        "https://a.com/new1", // 신규
        "bad-url", // 무효
        "https://existing.com/x", // 기존 존재 → skip
        "https://a.com/new1", // 배치 내 중복 → skip
        "https://b.com/new2", // 신규
      ],
      ["https://existing.com/x"],
    );
    expect(plan.toCreate.map((i) => i.normalizedUrl)).toEqual([
      "https://a.com/new1",
      "https://b.com/new2",
    ]);
    expect(plan.invalid).toBe(1);
    expect(plan.skipped).toBe(2);
  });

  it("빈 입력은 빈 계획을 반환한다", () => {
    const plan = prepareInboxItems([], []);
    expect(plan.toCreate).toEqual([]);
    expect(plan.invalid).toBe(0);
    expect(plan.skipped).toBe(0);
  });
});

describe("findDuplicateAsset", () => {
  it("같은 externalUrl을 가진 Asset이 있으면 그 Asset을 반환한다", () => {
    const assets = [
      { id: "1", externalUrl: "https://a.com/x" },
      { id: "2", externalUrl: "https://b.com/y" },
    ];
    const found = findDuplicateAsset(assets, "https://b.com/y");
    expect(found).not.toBeNull();
    expect(found?.id).toBe("2");
  });

  it("일치하는 externalUrl이 없으면 null을 반환한다", () => {
    const assets = [{ id: "1", externalUrl: "https://a.com/x" }];
    expect(findDuplicateAsset(assets, "https://z.com/none")).toBeNull();
  });

  it("externalUrl이 null인 Asset은 매칭하지 않는다", () => {
    const assets = [
      { id: "1", externalUrl: null },
      { id: "2", externalUrl: "https://a.com/x" },
    ];
    // normalizedUrl이 빈 문자열이어도 null과 매칭되면 안 된다
    expect(findDuplicateAsset(assets, "")).toBeNull();
    expect(findDuplicateAsset(assets, "https://a.com/x")?.id).toBe("2");
  });

  it("빈 Asset 목록은 null을 반환한다", () => {
    expect(findDuplicateAsset([], "https://a.com/x")).toBeNull();
  });
});

describe("planKakaoInboxItems", () => {
  // planKakaoInboxItems는 이미 추출된 콘텐츠 URL 배열을 받는다(재추출 안 함).
  // 호출부(queueKakaoReferenceUrls)와 동일하게 extractContentUrls로 청크를 먼저 분해해 넘긴다.
  it("콘텐츠 URL만 인박스 항목으로 계획하고 잡담·배송 링크는 제외한다", () => {
    const text =
      "[10:00] 사장: https://www.instagram.com/reel/DEF456/\n" +
      "[10:01] 직원: 택배 https://tracker.example.com/track/1";
    const plan = planKakaoInboxItems(extractContentUrls(text), []);
    expect(plan).toEqual([
      {
        normalizedUrl: "https://www.instagram.com/reel/DEF456/",
        rawUrl: "https://www.instagram.com/reel/DEF456/",
        linkName: "instagram.com/reel/DEF456",
      },
    ]);
  });

  it("URL이 없는 청크는 빈 계획을 반환한다", () => {
    expect(
      planKakaoInboxItems(extractContentUrls("[10:00] 사장: 오늘 회의 몇 시죠?"), []),
    ).toEqual([]);
  });

  it("빈 URL 배열은 빈 계획을 반환한다", () => {
    expect(planKakaoInboxItems([], [])).toEqual([]);
  });

  it("여러 메시지에서 여러 콘텐츠 URL을 뽑는다", () => {
    const text =
      "[10:00] a: https://www.instagram.com/p/ABC/\n" +
      "[10:05] b: https://youtu.be/xyz789";
    const plan = planKakaoInboxItems(extractContentUrls(text), []);
    expect(plan.map((p) => p.normalizedUrl)).toEqual([
      "https://www.instagram.com/p/ABC/",
      "https://youtu.be/xyz789",
    ]);
  });

  it("트래킹 쿼리를 제거한 정규화값으로 계획한다", () => {
    const text = "https://www.instagram.com/reel/DEF456/?igsh=abc123&utm_source=share";
    const plan = planKakaoInboxItems(extractContentUrls(text), []);
    expect(plan).toHaveLength(1);
    expect(plan[0].normalizedUrl).toBe("https://www.instagram.com/reel/DEF456/");
  });

  it("이미 존재하는(PENDING·DISMISSED) normalizedUrl은 제외한다", () => {
    const text =
      "https://www.instagram.com/reel/DEF456/\nhttps://youtu.be/xyz789";
    const plan = planKakaoInboxItems(extractContentUrls(text), [
      "https://www.instagram.com/reel/DEF456/",
    ]);
    expect(plan.map((p) => p.normalizedUrl)).toEqual(["https://youtu.be/xyz789"]);
  });

  it("같은 청크 안의 중복 URL은 한 번만 계획한다", () => {
    const text =
      "https://youtu.be/xyz789 이거랑 다시 https://youtu.be/xyz789";
    const plan = planKakaoInboxItems(extractContentUrls(text), []);
    expect(plan.map((p) => p.normalizedUrl)).toEqual(["https://youtu.be/xyz789"]);
  });
});
