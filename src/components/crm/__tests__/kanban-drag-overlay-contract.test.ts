import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 칸반 드래그 오버레이 계약 (2026-07-23).
 *
 * dnd-kit `DragOverlay`는 `position: fixed`인데, 칸반 보드가 놓이는 유리 컨테이너
 * (`backdrop-blur`)는 backdrop-filter로 자손 fixed의 containing block을 뷰포트에서
 * 자기 자신으로 바꾼다. 그 자리에서 DragOverlay를 렌더하면 컨테이너의 뷰포트
 * 오프셋만큼 들린 카드가 커서에서 아래로 밀린다 — 영업 관리·판매 관리에서 실제로
 * 발생했고, 페이지마다 헤더 높이가 달라 밀림 정도도 달랐다.
 *
 * 해법은 `KanbanDragOverlay`(body 포털 + snapCenterToCursor) 하나로 수렴했다.
 * 이 테스트는 새 표면이 `@dnd-kit/core`의 `DragOverlay`를 직접 다시 쓰는 것을 막는다.
 */

const SRC = join(process.cwd(), "src");

/** DragOverlay를 직접 소비해도 되는 유일한 곳 — 공용 래퍼 자신. */
const OWNER = "src/components/crm/kanban-drag-overlay.tsx";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "node_modules" ? [] : walk(full);
    }
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe("칸반 드래그 오버레이 — DragOverlay 직접 사용 금지", () => {
  it("공용 래퍼 밖에서 @dnd-kit DragOverlay를 직접 쓰지 않는다", () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const rel = file.replace(process.cwd() + "/", "");
      if (rel === OWNER) continue;

      const source = readFileSync(file, "utf8");
      // import 라인 기준 검사 — 주석·문서 문자열의 언급은 잡지 않는다.
      const importsDragOverlay = /import\s*\{[^}]*\bDragOverlay\b[^}]*\}\s*from\s*["']@dnd-kit\/core["']/.test(
        source,
      );
      if (importsDragOverlay) {
        offenders.push(
          `${rel} — @dnd-kit/core의 DragOverlay를 직접 import한다. ` +
            `backdrop-blur 컨테이너 안에서는 fixed 좌표계가 깨져 카드가 커서에서 밀린다 — ` +
            `KanbanDragOverlay(src/components/crm/kanban-drag-overlay.tsx)를 써라.`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });
});
