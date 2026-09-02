import { Buffer } from "node:buffer";
import { chmodSync, lstatSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { resolveSocketFd, type PeerCredentialProvider } from "./peer-cred";

/**
 * Agent worker Unix-domain-socket server (plan contract 6).
 *
 * - socket parent 0700, socket 0600, owner = worker uid
 * - peer uid must equal the worker uid (native getpeereid); mismatch, provider
 *   failure, or an unresolvable fd destroys the connection before any frame is read
 * - one UTF-8 JSON object per line, at most 64 KiB per frame
 * - request-id correlation; exactly five methods
 * - no HTTP listener of any kind
 */
export const MAX_FRAME_BYTES = 64 * 1024;
export const AGENT_WORKER_METHODS = ["submit", "get", "wait", "cancel_unclaimed", "health"] as const;
export type AgentWorkerMethod = (typeof AGENT_WORKER_METHODS)[number];

export type RpcContext = { signal: AbortSignal };
export type AgentWorkerRpcHandlers = Record<AgentWorkerMethod, (params: unknown, context: RpcContext) => Promise<unknown>>;

/** Error whose `code` is allowed on the wire. Any other error becomes INTERNAL_ERROR. */
export class RpcError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "RpcError";
    this.code = code;
  }
}

export type SocketPathErrorCode =
  | "SOCKET_PARENT_MODE_INVALID"
  | "SOCKET_PARENT_OWNER_MISMATCH"
  | "SOCKET_PATH_NOT_SOCKET"
  | "SOCKET_OWNER_MISMATCH"
  | "SOCKET_MODE_INVALID"
  | "SOCKET_ALREADY_SERVED";

export class SocketPathError extends Error {
  readonly code: SocketPathErrorCode;
  constructor(code: SocketPathErrorCode) {
    super(code);
    this.name = "SocketPathError";
    this.code = code;
  }
}

export type AgentWorkerSocketServerOptions = {
  socketPath: string;
  peerCredentialProvider: PeerCredentialProvider;
  handlers: AgentWorkerRpcHandlers;
  /** Defaults to process.getuid(). */
  expectedUid?: number;
  /** Test seam for the libuv fd lookup. */
  resolveFd?: (socket: Socket) => number | null;
  /** Receives only an error class; never socket data. */
  onRejectedConnection?: (errorClass: string) => void;
  /** Receives only an error class for handler failures that are not RpcError. */
  onHandlerError?: (method: AgentWorkerMethod, errorClass: string) => void;
};

export type AgentWorkerSocketServer = {
  socketPath: string;
  close(): Promise<void>;
};

export function defaultAgentWorkerSocketPath(home = homedir()): string {
  return path.join(home, "Library", "Application Support", "WAG CRM", "agent-worker.sock");
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (typeof uid !== "number") {
    throw new Error("agent worker requires a POSIX uid");
  }
  return uid;
}

function probeListener(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

/**
 * Ensures the parent is a 0700 directory owned by `uid` and removes only a dead
 * socket file with matching owner and mode. Any other pre-existing state refuses start.
 */
export async function prepareSocketPath(socketPath: string, uid: number): Promise<void> {
  const parent = path.dirname(socketPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = statSync(parent);
  if (parentStat.uid !== uid) {
    throw new SocketPathError("SOCKET_PARENT_OWNER_MISMATCH");
  }
  if ((parentStat.mode & 0o777) !== 0o700) {
    throw new SocketPathError("SOCKET_PARENT_MODE_INVALID");
  }

  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!existing) return;

  if (!existing.isSocket()) throw new SocketPathError("SOCKET_PATH_NOT_SOCKET");
  if (existing.uid !== uid) throw new SocketPathError("SOCKET_OWNER_MISMATCH");
  if ((existing.mode & 0o777) !== 0o600) throw new SocketPathError("SOCKET_MODE_INVALID");
  if (await probeListener(socketPath)) throw new SocketPathError("SOCKET_ALREADY_SERVED");
  unlinkSync(socketPath);
}

type WireResponse =
  | { id: string | null; ok: true; result: unknown }
  | { id: string | null; ok: false; error: { code: string } };

function write(socket: Socket, response: WireResponse): void {
  if (socket.destroyed || !socket.writable) return;
  socket.write(`${JSON.stringify(response)}\n`);
}

function isMethod(value: unknown): value is AgentWorkerMethod {
  return typeof value === "string" && (AGENT_WORKER_METHODS as readonly string[]).includes(value);
}

function parseRequest(line: string): { id: string; method: string; params: unknown } | "MALFORMED_JSON" | "INVALID_REQUEST" {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    return "MALFORMED_JSON";
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    return "INVALID_REQUEST";
  }
  const { id, method, params } = decoded as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof id !== "string" || id.length === 0 || id.length > 128 || typeof method !== "string") {
    return "INVALID_REQUEST";
  }
  return { id, method, params: params === undefined ? {} : params };
}

function serveConnection(socket: Socket, options: AgentWorkerSocketServerOptions): void {
  const controller = new AbortController();
  socket.once("close", () => controller.abort());
  let buffer = Buffer.alloc(0);

  const fail = (code: "FRAME_TOO_LARGE" | "MALFORMED_JSON" | "INVALID_REQUEST") => {
    write(socket, { id: null, ok: false, error: { code } });
    socket.end();
    socket.destroySoon();
  };

  const dispatch = async (request: { id: string; method: string; params: unknown }) => {
    if (!isMethod(request.method)) {
      write(socket, { id: request.id, ok: false, error: { code: "UNKNOWN_METHOD" } });
      return;
    }
    try {
      const result = await options.handlers[request.method](request.params, { signal: controller.signal });
      write(socket, { id: request.id, ok: true, result });
    } catch (error) {
      if (error instanceof RpcError) {
        write(socket, { id: request.id, ok: false, error: { code: error.code } });
        return;
      }
      options.onHandlerError?.(request.method, error instanceof Error ? error.name : "UnknownError");
      write(socket, { id: request.id, ok: false, error: { code: "INTERNAL_ERROR" } });
    }
  };

  socket.on("data", (chunk: Buffer) => {
    if (socket.destroyed) return;
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) {
        if (buffer.length > MAX_FRAME_BYTES) fail("FRAME_TOO_LARGE");
        return;
      }
      const frame = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (frame.length > MAX_FRAME_BYTES) {
        fail("FRAME_TOO_LARGE");
        return;
      }
      const line = frame.toString("utf8").trim();
      if (line.length === 0) continue;
      const request = parseRequest(line);
      if (request === "MALFORMED_JSON" || request === "INVALID_REQUEST") {
        fail(request);
        return;
      }
      void dispatch(request);
    }
  });
  socket.on("error", () => socket.destroy());
}

function gateConnection(socket: Socket, options: AgentWorkerSocketServerOptions, expectedUid: number): void {
  const reject = (errorClass: string) => {
    socket.destroy();
    options.onRejectedConnection?.(errorClass);
  };
  const fd = (options.resolveFd ?? resolveSocketFd)(socket);
  if (fd === null) {
    reject("PEER_FD_INVALID");
    return;
  }
  let uid: number;
  try {
    uid = options.peerCredentialProvider(fd).uid;
  } catch {
    reject("PEER_CREDENTIAL_UNAVAILABLE");
    return;
  }
  if (uid !== expectedUid) {
    reject("PEER_UID_MISMATCH");
    return;
  }
  serveConnection(socket, options);
}

export async function startAgentWorkerSocketServer(
  options: AgentWorkerSocketServerOptions,
): Promise<AgentWorkerSocketServer> {
  const expectedUid = options.expectedUid ?? currentUid();
  await prepareSocketPath(options.socketPath, expectedUid);

  // Every accepted connection is tracked so close() can end idle clients: a bare
  // server.close() only stops accepting and would wait for Hermes to hang up
  // (Task 5 review MEDIUM-1).
  const connections = new Set<Socket>();
  const server: Server = createServer({ pauseOnConnect: true }, (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    gateConnection(socket, options, expectedUid);
    if (!socket.destroyed) socket.resume();
  });

  const previousUmask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } finally {
    process.umask(previousUmask);
  }
  chmodSync(options.socketPath, 0o600);

  return {
    socketPath: options.socketPath,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        for (const socket of connections) {
          socket.destroy();
        }
        connections.clear();
      }),
  };
}
