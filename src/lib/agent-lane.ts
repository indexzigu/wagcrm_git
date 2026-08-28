// B4-1 에이전트 접근 레인 (라우트 레벨).
// 미들웨어의 x-agent-key 레인과 동일한 3중 가드를 재사용해, 라우트가 자체 getUser()
// 검사를 하는 경우에도 비프로덕션 배포에서만 synthetic 식별자를 부여한다.
// 프로덕션: AGENT_BYPASS_TOKEN env 미설정(1차) + VERCEL_ENV 가드(2차)로 항상 null.
export function getAgentLaneUserId(request: Request): string | null {
  const enabled =
    process.env.VERCEL_ENV !== "production" &&
    !!process.env.AGENT_BYPASS_TOKEN &&
    request.headers.get("x-agent-key") === process.env.AGENT_BYPASS_TOKEN;
  return enabled ? "agent-preview" : null;
}
