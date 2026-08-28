import { describe, expect, it } from "vitest";
import {
  serializePipelineParams,
  parsePipelineParams,
  type PipelineUrlParams,
} from "../use-stage-filter";

// ---------------------------------------------------------------------------
// serializePipelineParams
// ---------------------------------------------------------------------------

describe("serializePipelineParams", () => {
  it("returns empty string for all-default params", () => {
    const result = serializePipelineParams({});
    expect(result).toBe("");
  });

  it("returns empty string when stage is ALL and viewMode is kanban", () => {
    const result = serializePipelineParams({
      stage: "ALL",
      viewMode: "kanban",
      savedView: "DEFAULT",
    });
    expect(result).toBe("");
  });

  it("serializes stage filter", () => {
    const result = serializePipelineParams({ stage: "SALES" });
    expect(result).toBe("?stage=SALES");
  });

  it("serializes team filter", () => {
    const result = serializePipelineParams({ team: "team-123" });
    expect(result).toBe("?team=team-123");
  });

  it("serializes search query", () => {
    const result = serializePipelineParams({ search: "코링코" });
    expect(result).toContain("search=");
  });

  it("serializes savedView when not DEFAULT", () => {
    const result = serializePipelineParams({ savedView: "URGENT" });
    expect(result).toBe("?savedView=URGENT");
  });

  it("serializes viewMode when not kanban", () => {
    const result = serializePipelineParams({ viewMode: "table" });
    expect(result).toBe("?viewMode=table");
  });

  it("serializes multiple params", () => {
    const result = serializePipelineParams({
      stage: "PROGRESS",
      team: "team-1",
      search: "test",
      savedView: "STAGNANT",
      viewMode: "table",
    });
    const params = new URLSearchParams(result.slice(1));
    expect(params.get("stage")).toBe("PROGRESS");
    expect(params.get("team")).toBe("team-1");
    expect(params.get("search")).toBe("test");
    expect(params.get("savedView")).toBe("STAGNANT");
    expect(params.get("viewMode")).toBe("table");
  });
});

// ---------------------------------------------------------------------------
// parsePipelineParams
// ---------------------------------------------------------------------------

describe("parsePipelineParams", () => {
  it("returns empty object for empty search string", () => {
    const result = parsePipelineParams("");
    expect(result).toEqual({});
  });

  it("parses valid stage filter", () => {
    const result = parsePipelineParams("?stage=SALES");
    expect(result.stage).toBe("SALES");
  });

  it("ignores invalid stage filter", () => {
    const result = parsePipelineParams("?stage=INVALID");
    expect(result.stage).toBeUndefined();
  });

  it("parses team filter", () => {
    const result = parsePipelineParams("?team=team-abc");
    expect(result.team).toBe("team-abc");
  });

  it("ignores empty team filter", () => {
    const result = parsePipelineParams("?team=");
    expect(result.team).toBeUndefined();
  });

  it("parses search query", () => {
    const result = parsePipelineParams("?search=hello");
    expect(result.search).toBe("hello");
  });

  it("ignores empty search query", () => {
    const result = parsePipelineParams("?search=");
    expect(result.search).toBeUndefined();
  });

  it("parses valid savedView", () => {
    const result = parsePipelineParams("?savedView=URGENT");
    expect(result.savedView).toBe("URGENT");
  });

  it("ignores invalid savedView", () => {
    const result = parsePipelineParams("?savedView=NONEXISTENT");
    expect(result.savedView).toBeUndefined();
  });

  it("parses valid viewMode", () => {
    const result = parsePipelineParams("?viewMode=table");
    expect(result.viewMode).toBe("table");
  });

  it("ignores invalid viewMode", () => {
    const result = parsePipelineParams("?viewMode=monthly");
    expect(result.viewMode).toBeUndefined();
  });

  it("parses multiple valid params", () => {
    const result = parsePipelineParams(
      "?stage=SETTLEMENT&team=t1&search=abc&savedView=STAGNANT&viewMode=table",
    );
    expect(result).toEqual({
      stage: "SETTLEMENT",
      team: "t1",
      search: "abc",
      savedView: "STAGNANT",
      viewMode: "table",
    });
  });

  it("ignores unknown params and only parses known ones", () => {
    const result = parsePipelineParams("?stage=SALES&unknown=foo&bar=baz");
    expect(result).toEqual({ stage: "SALES" });
  });
});

// ---------------------------------------------------------------------------
// Round-trip: serialize → parse
// ---------------------------------------------------------------------------

describe("serializePipelineParams → parsePipelineParams round-trip", () => {
  it("round-trips non-default params correctly", () => {
    const original: PipelineUrlParams = {
      stage: "PROGRESS",
      team: "team-x",
      search: "query",
      savedView: "MANUAL_MARGIN",
      viewMode: "table",
    };
    const serialized = serializePipelineParams(original);
    const parsed = parsePipelineParams(serialized);
    expect(parsed).toEqual(original);
  });

  it("round-trips default params (omitted from URL) correctly", () => {
    const original: PipelineUrlParams = {
      stage: "ALL",
      savedView: "DEFAULT",
      viewMode: "kanban",
    };
    const serialized = serializePipelineParams(original);
    // Defaults are omitted from URL
    expect(serialized).toBe("");
    // Parsing empty string returns empty object (defaults applied by hook)
    const parsed = parsePipelineParams(serialized);
    expect(parsed.stage).toBeUndefined();
    expect(parsed.savedView).toBeUndefined();
    expect(parsed.viewMode).toBeUndefined();
  });
});
