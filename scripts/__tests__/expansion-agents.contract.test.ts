import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DIR = resolve(__dirname, "../../.claude/agents/expansion");

const AGENTS = [
  { file: "scout.md", model: "sonnet", effort: "high" },
  { file: "planner.md", model: "opus", effort: "high" },
  { file: "verifier.md", model: "sonnet", effort: "medium" },
] as const;

const read = (f: string) => readFileSync(resolve(DIR, f), "utf8");
const split = (src: string) => {
  const m = src.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("frontmatter missing");
  return { front: m[1], body: m[2] };
};
const field = (front: string, key: string) =>
  front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1].trim();

describe("expansion agent definitions", () => {
  for (const a of AGENTS) {
    describe(a.file, () => {
      const { front, body } = split(read(a.file));
      it("frontmatter model/effort", () => {
        expect(field(front, "name")).toBe(`expansion-${a.file.replace(".md", "")}`);
        expect(field(front, "model")).toBe(a.model);
        expect(field(front, "effort")).toBe(a.effort);
        expect(field(front, "description")).toBeTruthy();
      });
      it("DB 접근은 읽기 전용 래퍼뿐", () => {
        expect(body).toContain("절대 경로");
        expect(body).toContain("$HOME/selfhost/");
        expect(body).toContain("시스템 임시 디렉터리");
        expect(body).toContain("`~/Projects/` 아래(레포 체크아웃·워크트리)와 상대 경로, 그 밖의 모든 경로는 거부하고");
        expect(body).not.toContain("infra/selfhost/expansion-readonly-sql.sh");
        expect(read(a.file)).not.toMatch(/DATABASE_URL/);
        expect(read(a.file)).not.toMatch(/prisma\./);
      });
      it("사업 수치 패턴 없음", () => {
        expect(read(a.file)).not.toMatch(/\d\s*억/);
        expect(read(a.file)).not.toMatch(/\d\s*만\s*원/);
        expect(read(a.file)).not.toMatch(/\d\s*만원/);
      });
      it("금지 사항을 담는다", () => {
        for (const needle of [
          "운영 DB 쓰기",
          "외부 코드",
          "이미지 모델",
          "PROJECT_MASTER.md",
          "티켓 보드",
          "슬랙",
          "push",
          "머지",
        ]) {
          expect(body, needle).toContain(needle);
        }
        expect(body).toContain("GROWTH_FLYWHEEL_PLAN.md");
      });
    });
  }
  it("scout 는 대량 조사를 gemini-runner 에 맡긴다", () => {
    expect(split(read("scout.md")).body).toContain("gemini-runner");
  });
  it("verifier 는 deployed.sha 로 배포 여부를 판정한다", () => {
    expect(split(read("verifier.md")).body).toContain("deployed.sha");
  });
});
