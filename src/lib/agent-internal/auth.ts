import { safeEqual } from "@/lib/cron-auth";
import { AGENT_INTERNAL_SECRET_HEADER } from "./api-contract";

/**
 * 봇 내부 창구(`/api/internal/agent/*`) 인증 — 봇 작업 실행기만 부를 수 있게 한다(오너 결정 2026-10-16 방식 A).
 *
 * 이 경로들은 세션 게이트(`src/lib/supabase/middleware.ts`)에서 정확 경로로 면제되므로 **이 검사가 유일한
 * 인증**이다(`api-route-auth-coverage.contract.test.ts` C2 가 강제한다). 세 겹을 모두 통과해야 한다:
 *  ① 비밀값 설정 — `AGENT_INTERNAL_API_SECRET` 이 없거나 `MIN_SECRET_CHARS` 보다 짧으면 **아무도** 못 지난다
 *     (fail-closed). 그래서 배포와 비밀값 붙여넣기의 순서가 어긋나도 창구는 닫힌 채로 있다.
 *  ② 터널 경유 거부 — 앱은 `127.0.0.1` 에만 바인드하고(`infra/selfhost/run-app.sh`) 바깥 요청은 Cloudflare
 *     터널로만 들어온다. 터널은 원 요청에 `cf-ray`·`cf-connecting-ip` 를 붙이고 바깥 사람은 그것을 **지울 수
 *     없다**. 봇 작업 실행기는 같은 맥에서 루프백으로 부르므로 이 헤더가 없다 — 하나라도 있으면 바깥에서 온
 *     요청이라 비밀값을 보기도 전에 거절한다(비밀값이 새도 바깥에서는 못 쓴다).
 *  ③ 받는 주소 — 요청의 Host 가 루프백(`127.0.0.1`·`localhost`·`[::1]`)이어야 한다. 터널은 Host 가 공개 도메인이어야
 *     라우팅되므로 바깥 사람은 이 조건을 만들 수 없다(②와 독립된 두 번째 신호 — 보안 리뷰 2026-10-16).
 *  ④ 비밀값 대조 — 전용 헤더(`AGENT_INTERNAL_SECRET_HEADER`)를 상수 시간으로 비교한다(`safeEqual`, 크론 인증과 같은 비교).
 *     앱 env 값은 앞뒤 공백을 걷고 잰다 — 붙여넣기 줄 끝 공백이 「창구가 닫혀 있다」로 오래 숨지 않게(워커 쪽도 같다).
 *
 * 어느 겹에서 걸리든 응답은 똑같은 404 다(`agentInternalNotFound`) — 창구가 있는지조차 드러내지 않는다.
 */
/** 비밀값 최소 길이 — 붙여넣기 실수(빈 줄·잘린 값)로 짧은 값이 들어가면 열지 않는다. 생성 명령은 64자를 만든다. */
export const MIN_SECRET_CHARS = 32;

/** Cloudflare 터널이 원 요청에 붙이는 헤더 — 있으면 바깥에서 온 요청이다. */
const TUNNEL_HEADERS = ["cf-ray", "cf-connecting-ip"] as const;

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Host 헤더(`host:port`)가 루프백인가. 없거나 읽을 수 없으면 아니다. */
function isLoopbackHost(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

export function verifyAgentInternalRequest(request: Request): boolean {
  const secret = process.env.AGENT_INTERNAL_API_SECRET?.trim();
  if (!secret || secret.length < MIN_SECRET_CHARS) return false;
  if (TUNNEL_HEADERS.some((name) => request.headers.has(name))) return false;
  if (!isLoopbackHost(request.headers.get("host"))) return false;
  const provided = request.headers.get(AGENT_INTERNAL_SECRET_HEADER);
  if (!provided) return false;
  return safeEqual(provided, secret);
}

/** 인증 실패 응답 — 없는 경로와 구별되지 않게 본문 없는 404. */
export function agentInternalNotFound(): Response {
  return new Response("Not Found", { status: 404 });
}
