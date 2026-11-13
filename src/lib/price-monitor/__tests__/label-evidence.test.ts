import { describe, expect, it } from "vitest";
import {
  buildMatchEvidence,
  classifyLabelCause,
  evidenceSaidSame,
  parseMatchEvidence,
  summarizeLabelInsights,
} from "../label-evidence";

const QUERY = "비비랩 올리브레몬 듀얼 올레샷 2박스";
const IDS = ["비비랩", "뉴트리원"];
const ev = (productName: string, mall: string | null = "어떤몰", identities = IDS) =>
  buildMatchEvidence({ searchQuery: QUERY, identities, unit: "박스", candidate: { productName, mall } });

describe("buildMatchEvidence", () => {
  it("records where the brand was found, per-word hits and the candidate-only words", () => {
    const e = ev("[뉴트리원] 비비랩 올리브 레몬 밸런스샷 (1박스)");
    expect(e.brandMatch).toBe("match");
    expect(e.brandFoundIn).toBe("productName");
    expect(e.wordHits.map((h) => [h.word, h.hit])).toEqual([
      ["올리브레몬", "full"],
      ["듀얼", "none"],
      ["올레샷", "none"],
    ]);
    expect(e.extraWords).toEqual(["밸런스샷"]);
    expect(e.searchQuery).toBe(QUERY);
  });

  it("marks a brand found only in the seller name", () => {
    expect(ev("유기농 올리브 엔 레몬 듀얼샷 올레샷", "뉴트리원공식스토어").brandFoundIn).toBe("mall");
  });
});

describe("classifyLabelCause", () => {
  it("returns null when the owner agrees with the system", () => {
    expect(classifyLabelCause("SAME", ev("비비랩 올리브레몬 듀얼 올레샷"))).toBeNull();
    expect(classifyLabelCause("DIFFERENT", ev("다른회사 올레샷", "메디트리"))).toBeNull();
  });

  it("explains why a different product was listed", () => {
    // sibling line of the same brand sharing query words
    expect(classifyLabelCause("DIFFERENT", ev("비비랩 올리브레몬 듀얼 올레샷 스틱"))).toBe("SHARED_WORDS");
    // brand only in the seller name
    expect(classifyLabelCause("DIFFERENT", ev("올리브레몬 듀얼 올레샷 리필", "뉴트리원공식스토어"))).toBe("BRAND_VIA_MALL");
    // no identity names configured at all
    expect(classifyLabelCause("DIFFERENT", ev("올리브레몬 듀얼 올레샷", "메디트리", []))).toBe("NO_IDENTITY");
    // score carried by partial word pieces
    expect(classifyLabelCause("DIFFERENT", ev("비비랩 올리브 엔 레몬 듀얼 녹즙"))).toBe("PARTIAL_WORDS");
  });

  it("names a model-name match when the words alone would not have listed it", () => {
    const e = buildMatchEvidence({
      searchQuery: "종근당 락토핏 골드 파워",
      identities: ["종근당"],
      modelName: "PB-10000X",
      candidate: { productName: "종근당 골드 PB 10000X 리필", mall: "어떤몰" },
    });
    expect(e.modelBonus).toBe(true);
    expect(e.wordScore).toBeLessThan(40);
    expect(e.matchScore).toBeGreaterThanOrEqual(40);
    expect(classifyLabelCause("DIFFERENT", e)).toBe("MODEL_NAME");
  });

  it("explains why a same product was missed", () => {
    expect(classifyLabelCause("SAME", ev("유기농 올리브레몬 듀얼 올레샷", "어떤몰"))).toBe("BRAND_NOT_FOUND");
    expect(classifyLabelCause("SAME", ev("비비랩 레몬 오일 샷"))).toBe("WORDS_DIFFER");
  });

  it("system judgment matches the axis rule", () => {
    expect(evidenceSaidSame({ brandMatch: "missing", matchScore: 100 })).toBe(false);
    expect(evidenceSaidSame({ brandMatch: "unknown", matchScore: 40 })).toBe(true);
  });
});

describe("summarizeLabelInsights", () => {
  it("counts causes and the words that separated different products", () => {
    const sibling = JSON.stringify(ev("비비랩 올리브레몬 듀얼 올레샷 스틱"));
    const sibling2 = JSON.stringify(ev("비비랩 올리브레몬 듀얼 올레샷 스틱 밸런스"));
    const insights = summarizeLabelInsights([
      { label: "DIFFERENT", cause: "SHARED_WORDS", evidence: sibling },
      { label: "DIFFERENT", cause: "SHARED_WORDS", evidence: sibling2 },
      { label: "SAME", cause: null, evidence: sibling },
      { label: "DIFFERENT", cause: "unknown-cause", evidence: "{broken" },
      // the system already excluded this one; its words are not a judgment-fixing clue
      { label: "DIFFERENT", cause: null, evidence: JSON.stringify(ev("비비랩 올리브레몬 듀얼 올레샷 녹즙")) },
    ]);
    expect(insights.causes).toEqual([{ cause: "SHARED_WORDS", label: expect.any(String), count: 2 }]);
    expect(insights.differentWords).toEqual([
      { word: "스틱", count: 2 },
      { word: "밸런스", count: 1 },
    ]);
  });

  it("ignores unreadable or old-version evidence", () => {
    expect(parseMatchEvidence("{broken")).toBeNull();
    expect(parseMatchEvidence(JSON.stringify({ v: 0 }))).toBeNull();
  });
});
