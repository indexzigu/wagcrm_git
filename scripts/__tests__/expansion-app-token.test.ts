import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";

const SCRIPT = resolve(__dirname, "../../infra/selfhost/expansion-app-token.mjs");

let dir: string;
let keyPath: string;
let publicKey: string;
let server: Server;
let api: string;
type Reply = { status: number; body: unknown };
let reply: Reply;
let seen: { url?: string; auth?: string; body?: string } = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "exp-app-token-"));
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  keyPath = join(dir, "app.pem");
  writeFileSync(keyPath, pair.privateKey.export({ type: "pkcs1", format: "pem" }));
  publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen = { url: req.url, auth: req.headers.authorization, body: b };
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  seen = {};
  reply = {
    status: 201,
    body: { token: "ghs_" + "a".repeat(36), permissions: { contents: "write", pull_requests: "write", metadata: "read" } },
  };
});

// 서버가 같은 프로세스에 있으므로 동기 spawnSync 는 쓸 수 없다(이벤트 루프가 멈춰 응답을 못 한다).
const run = (args: string[], env: Record<string, string> = {}) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH ?? "", EXPANSION_GITHUB_API: api, ...env },
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => res({ status, stdout, stderr }));
  });

describe("expansion-app-token.mjs", () => {
  it("앱 키로 서명한 JWT 로 설치 토큰을 요청하고 토큰만 stdout 에 낸다", async () => {
    const r = await run(["5832880", "183673676", keyPath]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`ghs_${"a".repeat(36)}\n`);
    expect(r.stderr).toBe("");
    expect(seen.url).toBe("/app/installations/183673676/access_tokens");
    const jwt = (seen.auth ?? "").replace(/^Bearer /, "");
    const [h, p, sig] = jwt.split(".");
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(claims.iss).toBe("5832880");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  });

  it("토큰을 저장소 1개·권한 3개로 좁혀 요청한다", async () => {
    await run(["1", "2", keyPath]);
    expect(JSON.parse(seen.body ?? "{}")).toEqual({
      repositories: ["wagcrm_git"],
      permissions: { contents: "write", pull_requests: "write", metadata: "read" },
    });
  });

  it("요청보다 넓은 권한이 붙어 오면 토큰을 내지 않는다", async () => {
    reply.body = { token: "ghs_" + "b".repeat(36), permissions: { contents: "write", administration: "write" } };
    const r = await run(["1", "2", keyPath]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/요청하지 않은 권한이 붙었다: administration=write/);
  });

  it("HTTP 오류면 상태와 메시지만 stderr 에 남기고 실패한다", async () => {
    reply = { status: 401, body: { message: "Bad credentials" } };
    const r = await run(["1", "2", keyPath]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/HTTP 401 Bad credentials/);
  });

  it("응답에 토큰이 없으면 실패", async () => {
    reply.body = { permissions: {} };
    const r = await run(["1", "2", keyPath]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/응답에 토큰이 없다/);
  });

  it("키를 못 읽으면 실패하고 요청을 보내지 않는다", async () => {
    const r = await run(["1", "2", join(dir, "missing.pem")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/개인키를 읽을 수 없다 \(ENOENT\)/);
    expect(seen.url).toBeUndefined();
  });

  it("인자가 숫자 ID 가 아니면 사용법 오류(2)", async () => {
    expect((await run(["abc", "2", keyPath])).status).toBe(2);
    expect((await run(["1", "2"])).status).toBe(2);
  });

  it("API 주소는 127.0.0.1 테스트 주소 외에는 바꿀 수 없다", async () => {
    const r = await run(["1", "2", keyPath], { EXPANSION_GITHUB_API: "https://evil.example.com" });
    expect(r.status).toBe(2);
    expect(seen.url).toBeUndefined();
  });
});
