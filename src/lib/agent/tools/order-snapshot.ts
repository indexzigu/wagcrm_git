import { z } from "zod";
import { naverOrderSnapshotRepository } from "@/repositories/naverOrderSnapshotRepository";
import type { AgentTool, ToolResult } from "./types";
import { missingParam, notFound, ok, queryFailed } from "./types";
// Data 타입(+구성 타입)은 런타임-프리 모듈로 이동됐다(청사진 §2-1/§3-1, 번들 안전).
// 기존 import 경로(`./order-snapshot`) 호환을 위해 여기서 type re-export한다 —
// 런타임 코드는 변경 없음(diff는 타입 이동뿐).
import type { OrderSnapshotDay, GetOrderSnapshotData } from "./data-types";

export type { OrderSnapshotDay, GetOrderSnapshotData };

const DATE_KEY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// m2: 조회 범위 상한 — endDate가 startDate보다 앞서거나 366일을 초과하는 범위 조회를
// zod refine에서 막는다. 위반 시 MISSING_PARAM 계열 에러로 되묻기를 유도한다 (agent-loop가
// MISSING_PARAM을 받으면 조기종료하고 사용자에게 되묻는다).
const MAX_RANGE_DAYS = 366;

const inputSchema = z
  .object({
    startDate: z
      .string()
      .regex(DATE_KEY_REGEX, "YYYY-MM-DD 형식이어야 합니다")
      .describe("조회 시작일 (YYYY-MM-DD, 필수)"),
    endDate: z
      .string()
      .regex(DATE_KEY_REGEX, "YYYY-MM-DD 형식이어야 합니다")
      .describe("조회 종료일 (YYYY-MM-DD, 필수)"),
  })
  .refine(
    (data) => {
      if (!DATE_KEY_REGEX.test(data.startDate) || !DATE_KEY_REGEX.test(data.endDate)) {
        // 형식 오류는 각 필드의 regex 에러로 이미 걸러지므로 범위 체크는 건너뛴다.
        return true;
      }
      return new Date(data.endDate).getTime() >= new Date(data.startDate).getTime();
    },
    {
      message: "endDate는 startDate보다 앞설 수 없습니다.",
      path: ["endDate"],
    }
  )
  .refine(
    (data) => {
      if (!DATE_KEY_REGEX.test(data.startDate) || !DATE_KEY_REGEX.test(data.endDate)) {
        return true;
      }
      const diffMs = new Date(data.endDate).getTime() - new Date(data.startDate).getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      return diffDays <= MAX_RANGE_DAYS;
    },
    {
      message: `조회 기간은 최대 ${MAX_RANGE_DAYS}일까지만 가능합니다.`,
      path: ["endDate"],
    }
  );

export type GetOrderSnapshotInput = z.infer<typeof inputSchema>;

async function execute(input: GetOrderSnapshotInput): Promise<ToolResult<GetOrderSnapshotData>> {
  const { startDate, endDate } = input;

  if (!startDate || !endDate) {
    return missingParam("startDate와 endDate(YYYY-MM-DD)가 모두 필요합니다.", { startDate, endDate });
  }
  if (!DATE_KEY_REGEX.test(startDate) || !DATE_KEY_REGEX.test(endDate)) {
    return missingParam("startDate/endDate는 YYYY-MM-DD 형식이어야 합니다.", { startDate, endDate });
  }

  try {
    // 이 툴은 일별 카운트만 소비한다 — orders 블롭을 싣는 findRange 대신 카운트 전용
    // 경량 조회를 쓴다(관성 전컬럼 fetch가 행당 수십~수백 KB egress를 유발했다).
    const rows = await naverOrderSnapshotRepository.findRangeCounts(startDate, endDate);

    if (rows.length === 0) {
      return notFound(
        `${startDate}~${endDate} 기간의 주문 스냅샷이 없습니다.`,
        ["NaverOrderSnapshot"],
        { startDate, endDate }
      );
    }

    const days: OrderSnapshotDay[] = rows.map((r: any) => ({
      snapshotDate: r.snapshotDate,
      ordersCount: r.ordersCount,
      newOrdersCount: r.newOrdersCount,
      preparingCount: r.preparingCount,
      deliveringCount: r.deliveringCount,
      lastCallTime: r.lastCallTime.toISOString(),
    }));

    const totals = days.reduce(
      (acc, d) => ({
        ordersCount: acc.ordersCount + d.ordersCount,
        newOrdersCount: acc.newOrdersCount + d.newOrdersCount,
        preparingCount: acc.preparingCount + d.preparingCount,
        deliveringCount: acc.deliveringCount + d.deliveringCount,
      }),
      { ordersCount: 0, newOrdersCount: 0, preparingCount: 0, deliveringCount: 0 }
    );

    return ok({ days, totals }, ["NaverOrderSnapshot"], { startDate, endDate });
  } catch (err) {
    return queryFailed(
      err instanceof Error ? err.message : "주문 스냅샷 조회 중 오류가 발생했습니다.",
      ["NaverOrderSnapshot"],
      { startDate, endDate }
    );
  }
}

export const getOrderSnapshotTool: AgentTool<GetOrderSnapshotInput, GetOrderSnapshotData> = {
  name: "get_order_snapshot",
  description:
    "네이버 주문 일별 스냅샷을 기간(startDate~endDate, YYYY-MM-DD 필수)으로 조회합니다. 주문건수/신규주문/발송준비/배송중 건수를 일자별과 합계로 반환합니다.",
  inputSchema,
  execute,
};
