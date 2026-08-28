/**
 * knowledge/index.json의 loadOrder를 따라 에이전트 런타임 지식을 결합해 시스템 프롬프트를 만든다.
 *
 * 중요 (청사진 R5): 사람용 문서인 `.knowledge/`(OKF, 점으로 시작)와 에이전트 런타임 지식인
 * `knowledge/`(점 없음)는 완전히 다른 디렉터리다. 절대 `.knowledge/`를 로드하지 않는다 —
 * 경로를 하드코딩하고 테스트로 회귀를 막는다.
 */

import { promises as fs } from "fs";
import path from "path";

// 프로젝트 루트 기준 knowledge/ 디렉터리. `.knowledge/`가 아님에 주의 (R5).
const KNOWLEDGE_ROOT = path.resolve(process.cwd(), "knowledge");
const KNOWLEDGE_INDEX_PATH = path.join(KNOWLEDGE_ROOT, "index.json");

export type KnowledgeIndex = {
  type: string;
  title: string;
  description: string;
  version: string;
  createdAt: string;
  loadOrder: string[];
  files: Array<{ path: string; type: string; description: string }>;
};

type ModuleCache = {
  index: KnowledgeIndex;
  combinedContent: string;
  systemPrompt: string;
};

let cache: ModuleCache | null = null;

/**
 * 경로 탈출(path traversal) 방지: loadOrder의 각 항목이 KNOWLEDGE_ROOT 하위에만 위치하도록 강제한다.
 * `.knowledge/`처럼 상위 디렉터리로 빠지는 경로("..", 절대경로 등)는 거부한다.
 */
function resolveWithinKnowledgeRoot(relativePath: string): string {
  const resolved = path.resolve(KNOWLEDGE_ROOT, relativePath);
  const normalizedRoot = KNOWLEDGE_ROOT + path.sep;
  if (!resolved.startsWith(normalizedRoot)) {
    throw new Error(
      `knowledge-loader: 경로가 knowledge/ 루트를 벗어납니다 (R5 위반 의심): ${relativePath}`
    );
  }
  return resolved;
}

async function loadIndex(): Promise<KnowledgeIndex> {
  const raw = await fs.readFile(KNOWLEDGE_INDEX_PATH, "utf-8");
  return JSON.parse(raw) as KnowledgeIndex;
}

async function loadModuleFile(relativePath: string): Promise<string> {
  const fullPath = resolveWithinKnowledgeRoot(relativePath);
  return fs.readFile(fullPath, "utf-8");
}

const SYSTEM_PROMPT_PREAMBLE = `당신은 wag-crm(인플루언서 공동구매 중개 CRM)의 대화형 조회 에이전트입니다.
아래 지식(엔티티 관계, 용어 사전, 정산 규칙, 승인 규칙, 금지 표현)을 근거로 사용자의 조회 질문에 답합니다.

## 핵심 원칙
1. 도구(function calling)로 조회한 데이터만 근거로 답하십시오. 도구 없이 숫자를 지어내지 마십시오.
2. 정산 금액은 반드시 예정(pending)/확정(confirmed)/지급완료(paid) 상태를 분리해 표기하십시오.
   입금(deposit)과 지급(payout)은 다른 이벤트이며, 세금계산서 발행 여부와 실제 입금/지급 여부도 별개입니다.
3. 필요한 파라미터(기간, 캠페인ID 등)가 없으면 임의로 가정하지 말고 사용자에게 되물으십시오.
4. 도구가 데이터를 찾지 못했거나(NOT_FOUND) 조회에 실패했으면(QUERY_FAILED) 수치를 생성하지 말고 실패 사실을 그대로 전달하십시오.
5. 미래 실적이나 매출을 단정적으로 예측하지 마십시오. 과거 데이터 기반 추정이면 근거와 불확실성을 함께 밝히십시오.
6. 아래 금지 표현 목록에 해당하는 표현은 절대 사용하지 마십시오.

## 참고 지식
`;

/**
 * 상대 날짜("이번 달", "지난달", "오늘") 해석용 현재 날짜 블록 (Asia/Seoul 기준 — Vercel
 * 서버는 UTC라 서버 로컬 시간을 쓰면 KST 자정~09시 사이 월 경계가 어긋난다).
 *
 * 배경(실사용 버그): 프롬프트에 오늘 날짜가 없어 LLM이 "이번달 정산 현황"에도 연/월을
 * 되물었다 — 원칙 3(파라미터 없으면 되묻기)이 상대 날짜에 과잉 발동. 이 블록이 환산 기준을
 * 제공하고, 상대 날짜는 되묻지 말라고 명시한다. 순수 함수(now 주입 가능)로 분리해 테스트한다.
 */
export function buildDateContext(now: Date = new Date()): string {
  const ymd = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }); // YYYY-MM-DD
  const weekday = now.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", weekday: "long" });
  const thisMonth = ymd.slice(0, 7);
  const [y, m] = thisMonth.split("-").map((v) => parseInt(v, 10));
  const lastMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;

  return `## 현재 날짜 (Asia/Seoul)
오늘은 ${ymd}(${weekday})입니다. "이번 달"=${thisMonth}, "지난달"=${lastMonth}, "올해"=${y}.
상대 날짜 표현(이번 달/지난달/올해/오늘 등)은 위 기준으로 직접 환산해 도구 파라미터를 채우십시오 —
이 경우는 원칙 3의 "필요한 파라미터가 없는" 상황이 아니므로 연/월을 사용자에게 되묻지 마십시오.`;
}

/**
 * knowledge/index.json의 loadOrder 순서로 모듈 파일들을 읽어 결합한 뒤,
 * 시스템 프롬프트 프리앰블과 합쳐 반환한다. 모듈 캐시로 파일 I/O를 1회로 제한한다.
 * 현재 날짜 블록은 캐시 밖에서 매 호출 덧붙인다 — 장수 인스턴스가 날짜를 캐시에 박제하면
 * 자정을 넘긴 뒤 어제 날짜로 답하게 되기 때문.
 */
export async function buildSystemPrompt(options: { forceReload?: boolean } = {}): Promise<string> {
  if (cache && !options.forceReload) {
    return `${cache.systemPrompt}\n\n${buildDateContext()}`;
  }

  const index = await loadIndex();

  const sections = await Promise.all(
    index.loadOrder.map(async (relativePath) => {
      const content = await loadModuleFile(relativePath);
      return `### ${relativePath}\n\n${content.trim()}\n`;
    })
  );

  const combinedContent = sections.join("\n");
  const systemPrompt = `${SYSTEM_PROMPT_PREAMBLE}\n${combinedContent}`;

  cache = { index, combinedContent, systemPrompt };
  return `${systemPrompt}\n\n${buildDateContext()}`;
}

/** 테스트/재적재 용도로 모듈 캐시를 비운다. */
export function clearKnowledgeCache(): void {
  cache = null;
}

/** 현재 로드된 index.json의 loadOrder를 반환한다 (테스트 검증용). */
export async function getLoadOrder(): Promise<string[]> {
  const index = await loadIndex();
  return index.loadOrder;
}

export { KNOWLEDGE_ROOT };
