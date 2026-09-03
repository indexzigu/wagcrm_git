import { z } from "zod";
import { AgentJobRouteSchema, type AgentJobRoute } from "./contracts";

const routerDecisionSchema = z
  .object({
    route: AgentJobRouteSchema,
    model: z.string(),
    reason: z.string(),
    mode: z.literal("shadow"),
  })
  .strict();

export type RouterDecision = {
  route: AgentJobRoute;
  model: string;
  reason: string;
};

export type RouterDecisionParseResult =
  | ({ status: "ACCEPTED" } & RouterDecision)
  | { status: "FAILED_SECURITY" };

/**
 * Parses only the exact stdout object emitted by local-llm-route.py decide.
 * Any malformed or unexpected decision is terminal security failure; this
 * boundary must not infer, retry, or substitute a route/model.
 */
export function parseRouterDecision(stdout: string): RouterDecisionParseResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch {
    return { status: "FAILED_SECURITY" };
  }

  const parsed = routerDecisionSchema.safeParse(decoded);
  if (!parsed.success) {
    return { status: "FAILED_SECURITY" };
  }

  return {
    status: "ACCEPTED",
    route: parsed.data.route,
    model: parsed.data.model,
    reason: parsed.data.reason,
  };
}
