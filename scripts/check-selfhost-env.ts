// 셀프호스트 프로덕션 `.env` 점검기 (T-067) — 선언 표는 `selfhost-env-contract.ts`.
//
// **왜 별도 스크립트인가 — 실행 위치가 이 점검의 본질이다.** 기존 `scripts/check-env.ts` 는
// `npm run release:check` 안에서만 돌고, 그것이 도는 곳은 **개발 머신과 CI** 다. 어느 쪽도
// `infra/selfhost/.env` 를 읽지 않는다 — 그래서 목록만 넓혀서는 프로덕션 공란이 영원히
// 안 걸린다(설계 §2). 같은 교훈을 `encryption-key-audit` 가 먼저 배웠다("검사 대상은 앱이
// 쓰는 키 × 앱이 붙은 DB 쌍이라 개발 머신·CI 로는 원리적으로 못 본다", P6).
//
// ⛔ **크론으로 옮기지 말 것.** `applyDbInstagramToken()` 처럼 런타임에 `process.env` 를
// 덮어쓰는 경로가 있어서, 돌고 있는 프로세스를 들여다보면 **파일이 비어 있어도 초록**이
// 나온다(거짓 성공). 그래서 이 스크립트는 `process.env` 가 아니라 **파일**을 읽는다.
//
// ⛔ **값을 출력하지 않는다(P0).** 파싱한 값은 「비었는가」 판정에만 쓰이고 어떤 경로로도
// 화면·로그에 나가지 않는다. 출력에 등장하는 것은 키 이름과 사유 문구뿐이다.
//
// 사용: `npm run env:check:selfhost [경로]` (기본 `infra/selfhost/.env`)
//  종료코드 0 = 통과(경고는 있을 수 있다) · 1 = required 공란 · 2 = 파일 없음/읽기 실패
import { readFileSync } from "node:fs";
import { evaluateSelfhostEnv } from "./selfhost-env-contract";

const DEFAULT_PATH = "infra/selfhost/.env";

/**
 * `KEY=VALUE` 줄을 키→값 맵으로 만든다. 주석·빈 줄·`export ` 접두를 걷어내고 감싼 따옴표를
 * 벗긴다. ⚠️ 여러 줄 값은 지원하지 않는다 — 이 파일에 그런 값이 없고, 지원하려다 파서가
 * 틀리면 **없는 키를 있다고 보고**해 점검이 거꾸로 위험해진다.
 */
export function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const body = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function main() {
  const path = process.argv[2] ?? DEFAULT_PATH;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // ⚠️ 파일 부재를 「통과」로 접지 말 것 — 이 점검기는 프로덕션 체크아웃에서만 의미가
    // 있고, 없는 곳에서 조용히 0 을 내면 배포 가드가 죽은 채 초록을 찍는다.
    console.error(`[env:selfhost] 중단: ${path} 를 읽을 수 없습니다.`);
    process.exit(2);
  }

  const result = evaluateSelfhostEnv(parseEnvFile(raw));

  for (const w of result.warnings) console.warn(`[env:selfhost] 경고 ${w.key}: ${w.message}`);
  for (const e of result.errors) console.error(`[env:selfhost] 오류 ${e.key}: ${e.message}`);

  if (!result.ok) {
    console.error(
      `[env:selfhost] 필수 항목 ${result.errors.length}건이 비어 있어 중단합니다 — ${path} 를 확인하세요.`,
    );
    process.exit(1);
  }
  console.log(
    `[env:selfhost] 통과 (경고 ${result.warnings.length}건)`,
  );
}

// 테스트가 `parseEnvFile` 만 가져다 쓸 수 있도록, 직접 실행일 때만 main 을 돈다.
if (process.argv[1] && process.argv[1].includes("check-selfhost-env")) main();
