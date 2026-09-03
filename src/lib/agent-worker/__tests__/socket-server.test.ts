import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_FRAME_BYTES,
  RpcError,
  SocketPathError,
  startAgentWorkerSocketServer,
  type AgentWorkerRpcHandlers,
  type AgentWorkerSocketServer,
} from "../socket-server";
import type { PeerCredentialProvider } from "../peer-cred";

const uid = process.getuid?.() ?? -1;
const gid = process.getgid?.() ?? -1;
const sameUid: PeerCredentialProvider = () => ({ uid, gid });

type Frame = Record<string, unknown>;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function tempSocketPath(): { directory: string; socketPath: string } {
  const directory = mkdtempSync(join(tmpdir(), "wag-uds-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "w", "s.sock");
  if (socketPath.length > 100) {
    throw new Error(`socket path too long for macOS sun_path: ${socketPath}`);
  }
  return { directory, socketPath };
}

/**
 * Leaves a genuinely dead socket file behind: a child process listens, then is
 * SIGKILLed so it cannot unlink the path (an in-process server.close() would).
 * The child's umask decides the socket file's mode (no chmod anywhere — the repo's
 * gh-stub guard forbids permission changes in tests, and none is needed here).
 */
function leaveDeadSocket(socketPath: string, umask: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "-e",
      `process.umask(${umask}); require("node:net").createServer().listen(process.argv[1], () => process.stdout.write("ok"))`,
      socketPath,
    ]);
    child.stdout.on("data", () => {
      child.kill("SIGKILL");
    });
    child.on("error", reject);
    child.on("exit", () => resolve());
  });
}

/** Creates the socket parent under a temporary umask so its mode is umask-derived. */
function makeParentWithUmask(socketPath: string, umask: number): void {
  const previous = process.umask(umask);
  try {
    mkdirSync(join(socketPath, ".."), { recursive: true });
  } finally {
    process.umask(previous);
  }
}

function handlers(overrides: Partial<AgentWorkerRpcHandlers> = {}): AgentWorkerRpcHandlers {
  return {
    submit: vi.fn(async () => ({ jobId: "job-1", created: true, status: "QUEUED" })),
    get: vi.fn(async () => ({ jobId: "job-1", status: "QUEUED" })),
    wait: vi.fn(async () => ({ jobId: "job-1", status: "RUNNING", settled: false })),
    cancel_unclaimed: vi.fn(async () => {
      throw new RpcError("CANCEL_UNSUPPORTED_BY_QUEUE_CONTRACT");
    }),
    health: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

async function startServer(
  socketPath: string,
  options: {
    provider?: PeerCredentialProvider;
    handlers?: AgentWorkerRpcHandlers;
    resolveFd?: (socket: Socket) => number | null;
    onRejectedConnection?: (errorClass: string) => void;
  } = {},
): Promise<AgentWorkerSocketServer> {
  const server = await startAgentWorkerSocketServer({
    socketPath,
    peerCredentialProvider: options.provider ?? sameUid,
    handlers: options.handlers ?? handlers(),
    resolveFd: options.resolveFd,
    onRejectedConnection: options.onRejectedConnection,
  });
  cleanups.push(() => server.close());
  return server;
}

type Exchange = { responses: Frame[]; closed: boolean; rawBytes: number };

function exchange(socketPath: string, lines: string[], settleMs = 150): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath);
    let buffer = "";
    let rawBytes = 0;
    const responses: Frame[] = [];
    let closed = false;
    const finish = () => resolve({ responses, closed, rawBytes });
    let connected = false;
    // After connect, EPIPE/ECONNRESET only mean the server destroyed the peer —
    // the following "close" event reports that; only a failed connect is fatal.
    client.on("error", (error) => {
      if (!connected) reject(error);
    });
    client.on("data", (chunk) => {
      rawBytes += chunk.length;
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.length > 0) responses.push(JSON.parse(line) as Frame);
        index = buffer.indexOf("\n");
      }
    });
    client.on("close", () => {
      closed = true;
      finish();
    });
    client.on("connect", () => {
      connected = true;
      for (const line of lines) client.write(`${line}\n`);
      setTimeout(() => {
        if (!closed) {
          client.destroy();
          resolve({ responses, closed: false, rawBytes });
        }
      }, settleMs);
    });
  });
}

const healthFrame = JSON.stringify({ id: "req-health", method: "health", params: {} });

describe("agent worker UDS server — peer/mode gate", () => {
  it("destroys a connection whose peer uid differs before any frame is processed", async () => {
    const { socketPath } = tempSocketPath();
    const rejected = vi.fn();
    const rpc = handlers();
    await startServer(socketPath, {
      provider: () => ({ uid: uid + 1, gid }),
      handlers: rpc,
      onRejectedConnection: rejected,
    });

    const result = await exchange(socketPath, [healthFrame]);

    expect(result.closed).toBe(true);
    expect(result.rawBytes).toBe(0);
    expect(rpc.health).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledWith("PEER_UID_MISMATCH");
  });

  it("destroys the connection when the credential provider throws", async () => {
    const { socketPath } = tempSocketPath();
    const rejected = vi.fn();
    const rpc = handlers();
    await startServer(socketPath, {
      provider: () => {
        throw new Error("getpeereid failed: raw libc text must not leak");
      },
      handlers: rpc,
      onRejectedConnection: rejected,
    });

    const result = await exchange(socketPath, [healthFrame]);

    expect(result.closed).toBe(true);
    expect(result.rawBytes).toBe(0);
    expect(rpc.health).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledWith("PEER_CREDENTIAL_UNAVAILABLE");
  });

  it("destroys the connection when the socket fd cannot be resolved", async () => {
    const { socketPath } = tempSocketPath();
    const rejected = vi.fn();
    const provider = vi.fn(sameUid);
    const rpc = handlers();
    await startServer(socketPath, {
      provider,
      handlers: rpc,
      resolveFd: () => null,
      onRejectedConnection: rejected,
    });

    const result = await exchange(socketPath, [healthFrame]);

    expect(result.closed).toBe(true);
    expect(result.rawBytes).toBe(0);
    expect(provider).not.toHaveBeenCalled();
    expect(rpc.health).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledWith("PEER_FD_INVALID");
  });

  it("creates a 0700 parent and a 0600 socket file", async () => {
    const { socketPath } = tempSocketPath();
    await startServer(socketPath);

    expect(statSync(join(socketPath, "..")).mode & 0o777).toBe(0o700);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it("refuses to start when the existing parent directory mode is not 0700", async () => {
    const { socketPath } = tempSocketPath();
    makeParentWithUmask(socketPath, 0o022); // -> 0755
    expect(statSync(join(socketPath, "..")).mode & 0o777).toBe(0o755);

    await expect(startServer(socketPath)).rejects.toMatchObject({
      name: "SocketPathError",
      code: "SOCKET_PARENT_MODE_INVALID",
    });
    expect(existsSync(socketPath)).toBe(false);
  });

  it("refuses to start over an existing socket whose mode is not 0600", async () => {
    const { socketPath } = tempSocketPath();
    makeParentWithUmask(socketPath, 0o077); // -> 0700
    await leaveDeadSocket(socketPath, 0o022); // -> 0755 socket file
    expect(statSync(socketPath).mode & 0o777).not.toBe(0o600);

    await expect(startServer(socketPath)).rejects.toMatchObject({
      name: "SocketPathError",
      code: "SOCKET_MODE_INVALID",
    });
    expect(existsSync(socketPath)).toBe(true);
  });

  it("refuses to start when another process is already serving the socket", async () => {
    const { socketPath } = tempSocketPath();
    await startServer(socketPath);

    const error = await startAgentWorkerSocketServer({
      socketPath,
      peerCredentialProvider: sameUid,
      handlers: handlers(),
    }).then(
      (server) => server.close().then(() => null),
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SocketPathError);
    expect((error as SocketPathError).code).toBe("SOCKET_ALREADY_SERVED");
  });

  it("replaces a dead same-owner 0600 socket file and starts", async () => {
    const { socketPath } = tempSocketPath();
    makeParentWithUmask(socketPath, 0o077); // -> 0700
    await leaveDeadSocket(socketPath, 0o177); // -> 0600 socket file
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);

    await startServer(socketPath);
    const result = await exchange(socketPath, [healthFrame]);

    expect(result.responses).toEqual([{ id: "req-health", ok: true, result: { ok: true } }]);
  });
});

describe("agent worker UDS server — framing and dispatch", () => {
  it("rejects a frame larger than 64 KiB and closes the connection", async () => {
    const { socketPath } = tempSocketPath();
    const rpc = handlers();
    await startServer(socketPath, { handlers: rpc });
    const oversized = JSON.stringify({ id: "big", method: "health", params: { pad: "x".repeat(MAX_FRAME_BYTES) } });

    const result = await exchange(socketPath, [oversized]);

    expect(result.responses).toEqual([{ id: null, ok: false, error: { code: "FRAME_TOO_LARGE" } }]);
    expect(result.closed).toBe(true);
    expect(rpc.health).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and closes the connection", async () => {
    const { socketPath } = tempSocketPath();
    await startServer(socketPath);

    const result = await exchange(socketPath, ["{not json"]);

    expect(result.responses).toEqual([{ id: null, ok: false, error: { code: "MALFORMED_JSON" } }]);
    expect(result.closed).toBe(true);
  });

  it("rejects a request without a string id and closes the connection", async () => {
    const { socketPath } = tempSocketPath();
    await startServer(socketPath);

    const result = await exchange(socketPath, [JSON.stringify({ method: "health" })]);

    expect(result.responses).toEqual([{ id: null, ok: false, error: { code: "INVALID_REQUEST" } }]);
    expect(result.closed).toBe(true);
  });

  it("answers an unknown method with UNKNOWN_METHOD and keeps serving the connection", async () => {
    const { socketPath } = tempSocketPath();
    await startServer(socketPath);

    const result = await exchange(socketPath, [
      JSON.stringify({ id: "a", method: "shutdown", params: {} }),
      healthFrame,
    ]);

    expect(result.responses).toEqual([
      { id: "a", ok: false, error: { code: "UNKNOWN_METHOD" } },
      { id: "req-health", ok: true, result: { ok: true } },
    ]);
  });

  it("correlates concurrent responses by request id", async () => {
    const { socketPath } = tempSocketPath();
    const rpc = handlers({
      wait: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { jobId: "job-1", status: "RUNNING", settled: false };
      }),
    });
    await startServer(socketPath, { handlers: rpc });

    const result = await exchange(socketPath, [
      JSON.stringify({ id: "slow", method: "wait", params: { jobId: "job-1" } }),
      JSON.stringify({ id: "fast", method: "get", params: { jobId: "job-1" } }),
    ]);

    expect(result.responses.map((frame) => frame.id)).toEqual(["fast", "slow"]);
    expect(rpc.wait).toHaveBeenCalledWith({ jobId: "job-1" }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("maps RpcError codes onto the wire and hides other error messages", async () => {
    const { socketPath } = tempSocketPath();
    const rpc = handlers({
      get: vi.fn(async () => {
        throw new Error("database password=hunter2 must not be on the wire");
      }),
    });
    await startServer(socketPath, { handlers: rpc });

    const result = await exchange(socketPath, [
      JSON.stringify({ id: "c", method: "cancel_unclaimed", params: { jobId: "job-1" } }),
      JSON.stringify({ id: "g", method: "get", params: { jobId: "job-1" } }),
    ]);

    expect(result.responses).toEqual([
      { id: "c", ok: false, error: { code: "CANCEL_UNSUPPORTED_BY_QUEUE_CONTRACT" } },
      { id: "g", ok: false, error: { code: "INTERNAL_ERROR" } },
    ]);
    expect(JSON.stringify(result.responses)).not.toContain("hunter2");
  });

  it("aborts an in-flight wait when the client disconnects", async () => {
    const { socketPath } = tempSocketPath();
    let observedSignal: AbortSignal | undefined;
    const rpc = handlers({
      wait: vi.fn(async (_params: unknown, context: { signal: AbortSignal }) => {
        observedSignal = context.signal;
        await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve()));
        return { jobId: "job-1", status: "RUNNING", settled: false };
      }),
    });
    await startServer(socketPath, { handlers: rpc });

    await exchange(socketPath, [JSON.stringify({ id: "w", method: "wait", params: { jobId: "job-1" } })], 30);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(observedSignal?.aborted).toBe(true);
  });
});

describe("agent worker UDS server — shutdown", () => {
  it("close() ends idle client connections instead of waiting for them (bounded shutdown)", async () => {
    const { socketPath } = tempSocketPath();
    const server = await startAgentWorkerSocketServer({
      socketPath,
      peerCredentialProvider: sameUid,
      handlers: handlers(),
    });
    const idle = connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      idle.once("connect", () => resolve());
      idle.once("error", reject);
    });
    const idleClosed = new Promise<void>((resolve) => idle.once("close", () => resolve()));

    const startedAt = Date.now();
    await server.close();
    await idleClosed;

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(existsSync(socketPath)).toBe(false);
  });
});
