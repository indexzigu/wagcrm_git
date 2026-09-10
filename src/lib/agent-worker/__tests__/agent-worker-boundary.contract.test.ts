import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentJobOperationSchema } from "../contracts";

const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const WORKER_SOURCES = [
  "scripts/agent-worker.ts",
  "src/lib/agent-worker/socket-server.ts",
  "src/lib/agent-worker/rpc-handlers.ts",
  "src/lib/agent-worker/executor.ts",
  "src/lib/agent-worker/worker-loop.ts",
  "src/lib/agent-worker/audit.ts",
  "src/lib/agent-worker/peer-cred.ts",
  "src/lib/agent-worker/shadow.ts",
  "src/lib/agent-worker/promotion.ts",
];

describe("agent worker boundary contract", () => {
  it("opens no HTTP listener anywhere in the worker", () => {
    for (const file of WORKER_SOURCES) {
      const source = read(file);
      expect(source, file).not.toMatch(/from\s+["'](node:)?https?["']/);
      expect(source, file).not.toMatch(/require\(["'](node:)?https?["']\)/);
      expect(source, file).not.toMatch(/from\s+["']express["']/);
      expect(source, file).not.toMatch(/from\s+["']next\/server["']/);
    }
  });

  it("executor imports the WRITE_ACTIONS allowlist but no approval or execution function", () => {
    const source = read("src/lib/agent-worker/executor.ts");
    expect(source).toMatch(/WRITE_ACTIONS/);
    expect(source).not.toMatch(/executeWriteAction/);
    expect(source).not.toMatch(/resolveWriteActionEffects/);
    expect(source).not.toMatch(/write-action-effects/);
    expect(source).not.toMatch(/applyWriteActionEffects/);
    expect(source).not.toMatch(/isAutoApprovable/);
    expect(source).not.toMatch(/action-proposals\/\[id\]/);
    expect(source).not.toMatch(/"APPROVED"|"EXECUTED"/);
  });

  // ⚠️ 이 테스트의 이름은 한때 "only the frozen five" 였는데, 정작 세던 것은 **다섯 개가
  // 있는가**뿐이었다("only"도, 개수도 검사하지 않았다). 그래서 2026-09-10 에 여섯 번째
  // (`search_partners`)가 들어와도 초록으로 남았고, 이름만 사실과 어긋났다.
  // 이제 목록을 계약에서 가져와 **양방향**으로 센다: 계약에 있는 것은 전부 등록돼 있어야
  // 하고, 등록된 것은 전부 계약에 있어야 한다. 개수는 계약이 정하므로 여기 적지 않는다.
  it("registers exactly the operations the contract declares, and no others", () => {
    const executor = read("src/lib/agent-worker/executor.ts");
    const registry = executor.slice(executor.indexOf("export const OPERATION_REGISTRY"));
    const body = registry.slice(0, registry.indexOf("\n};"));

    const declared = AgentJobOperationSchema.options;
    for (const operation of declared) {
      expect(body, operation).toContain(`${operation}:`);
    }
    const registered = [...body.matchAll(/^\s{2}([a-z_]+):/gm)].map((match) => match[1]);
    expect(new Set(registered)).toEqual(new Set(declared));
  });

  it("uses only the frozen five socket methods", () => {
    const server = read("src/lib/agent-worker/socket-server.ts");
    expect(server).toMatch(/\["submit",\s*"get",\s*"wait",\s*"cancel_unclaimed",\s*"health"\]/);
  });

  it("keeps the native build out of every web-deploy lifecycle script", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.scripts["agent-worker:build-native"]).toMatch(/node-gyp/);
    for (const name of ["postinstall", "prebuild", "build", "build:demo", "prepare", "release:check", "start"]) {
      const script = pkg.scripts[name] ?? "";
      expect(script, name).not.toMatch(/node-gyp|build-native/);
    }
    expect(pkg.devDependencies["node-addon-api"]).toBe("8.8.0");
  });

  it("git-ignores the addon build output", () => {
    expect(read(".gitignore")).toMatch(/^\/src\/lib\/agent-worker\/native\/peer-cred\/build\/$/m);
  });

  it("the worker entrypoint verifies its database role before it starts working", () => {
    // T-117: the launcher can only compare connection strings, so the identity guard
    // is the only thing that actually answers "which role am I". It has to run before
    // the loop claims a job — a guard that fires afterwards has already let writes
    // through. Asserting the call site (not just the import) keeps the module from
    // becoming dead code that every test still passes without.
    const entry = read("scripts/agent-worker.ts");
    expect(entry).toMatch(/import \{ assertAgentWorkerDbIdentity \} from "\.\.\/src\/lib\/agent-worker\/db-identity"/);
    const guardAt = entry.indexOf("assertAgentWorkerDbIdentity(");
    const loopStartAt = entry.indexOf("loop.start()");
    expect(guardAt, "entrypoint never calls the identity guard").toBeGreaterThan(-1);
    expect(loopStartAt).toBeGreaterThan(-1);
    expect(guardAt, "identity guard runs after the loop starts claiming jobs").toBeLessThan(loopStartAt);
    expect(entry, "the guard result must be awaited or a rejection cannot stop startup").toMatch(
      /await assertAgentWorkerDbIdentity\(/,
    );
  });

  it("the worker entrypoint fails closed without the native peer-credential addon", () => {
    const entry = read("scripts/agent-worker.ts");
    expect(entry).toMatch(/loadNativePeerCredentialProvider/);
    expect(entry).not.toMatch(/catch[\s\S]{0,200}(mode-only|fallback)/i);
  });
});
