import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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

  it("uses only the frozen five operations and five methods", () => {
    const executor = read("src/lib/agent-worker/executor.ts");
    for (const operation of [
      "search_deals",
      "get_pipeline_status",
      "get_order_snapshot",
      "get_campaign_financials",
      "create_action_proposal",
    ]) {
      expect(executor).toContain(`${operation}:`);
    }
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

  it("the worker entrypoint fails closed without the native peer-credential addon", () => {
    const entry = read("scripts/agent-worker.ts");
    expect(entry).toMatch(/loadNativePeerCredentialProvider/);
    expect(entry).not.toMatch(/catch[\s\S]{0,200}(mode-only|fallback)/i);
  });
});
