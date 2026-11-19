// 확장 회차 전용 GitHub 신원 — GitHub App(wag-expansion-bot) 설치 토큰을 발급해 stdout 에 한 줄로 낸다.
// 사용: node expansion-app-token.mjs <app-id> <installation-id> <개인키-경로>
// 종료코드: 0 발급 · 1 발급 실패 · 2 사용법 오류. 토큰은 stdout 에만 쓴다 — stderr·로그에는 절대 쓰지 않는다.
//
// 왜: 회차가 오너 계정 자격으로 push·PR 을 하면 GitHub 쪽에서 회차를 따로 막을 방법이 없다. 앱 신원은
//   저장소 규칙(ruleset `expansion-bot-exp-only`: exp/** 밖 브랜치 생성·갱신·삭제는 관리자만)에 걸려
//   exp/* push 와 PR 생성만 할 수 있고 main 에는 반영하지 못한다.
// 토큰은 요청 시점에 저장소 1개·권한 3개로 좁혀 받는다 — 앱 설정 쪽 권한이 나중에 넓어져도 회차 토큰은 넓어지지 않는다.
// 수명은 GitHub 이 1시간으로 정한다 — 래퍼는 회차 직전에 발급하고 회차 시간 상한을 그 이하로 묶는다.
// API 주소는 상수다. 테스트만 127.0.0.1 주소로 바꿀 수 있다(다른 호스트로 키 서명 JWT 를 보내지 않게).

import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";

const REPO_NAME = "wagcrm_git";
const PERMISSIONS = { contents: "write", pull_requests: "write", metadata: "read" };
const DEFAULT_API = "https://api.github.com";

const die = (code, msg) => {
  process.stderr.write(`expansion-app-token: ${msg}\n`);
  process.exit(code);
};

const [appId, installationId, keyPath] = process.argv.slice(2);
if (!/^\d+$/.test(appId ?? "") || !/^\d+$/.test(installationId ?? "") || !keyPath) {
  die(2, "usage: expansion-app-token.mjs <app-id> <installation-id> <key-path>");
}

const api = process.env.EXPANSION_GITHUB_API ?? DEFAULT_API;
if (api !== DEFAULT_API && !/^http:\/\/127\.0\.0\.1:\d+$/.test(api)) die(2, "EXPANSION_GITHUB_API 는 테스트용 127.0.0.1 주소만 허용");

let key;
try {
  key = readFileSync(keyPath);
} catch (e) {
  die(1, `개인키를 읽을 수 없다 (${e.code ?? "unknown"})`);
}

const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
// iat 을 60초 당기는 것은 GitHub 권장(시계 오차 흡수). exp 는 최대 10분.
const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: appId })}`;
let jwt;
try {
  jwt = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url")}`;
} catch {
  die(1, "개인키로 서명하지 못했다 (키 형식 확인)");
}

let res;
try {
  res = await fetch(`${api}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "wag-expansion-loop",
    },
    body: JSON.stringify({ repositories: [REPO_NAME], permissions: PERMISSIONS }),
    signal: AbortSignal.timeout(20000),
  });
} catch (e) {
  die(1, `요청 실패 (${e.name ?? "error"})`);
}

let body;
try {
  body = await res.json();
} catch {
  die(1, `응답이 JSON 이 아니다 (HTTP ${res.status})`);
}
if (res.status !== 201) die(1, `HTTP ${res.status} ${String(body?.message ?? "").slice(0, 120)}`);
// 길이 하한은 형식 검증이 아니라 빈 값·잘린 값 거르기다(실제 설치 토큰은 40자 이상).
if (typeof body?.token !== "string" || body.token.length < 20 || /\s/.test(body.token)) die(1, "응답에 토큰이 없다");
// GitHub 이 요청보다 넓게 줬으면(있어선 안 되지만) 쓰지 않는다 — 권한도 저장소 범위도 요청과 같아야 한다.
const granted = body.permissions;
if (!granted || typeof granted !== "object" || Object.keys(granted).length === 0) die(1, "응답에 권한 목록이 없다");
for (const [k, v] of Object.entries(granted)) {
  if (PERMISSIONS[k] !== v) die(1, `요청하지 않은 권한이 붙었다: ${k}=${v}`);
}
const repos = Array.isArray(body.repositories) ? body.repositories.map((r) => r?.name) : [];
if (body.repository_selection !== "selected" || repos.length !== 1 || repos[0] !== REPO_NAME) {
  die(1, `저장소 범위가 요청과 다르다 (${body.repository_selection ?? "?"}: ${repos.join(",") || "-"})`);
}
process.stdout.write(`${body.token}\n`);
