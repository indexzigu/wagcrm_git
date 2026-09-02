/**
 * WAG Agent Worker entrypoint (plan Task 5).
 *
 * Runs the durable AgentJob loop and the local Unix-domain-socket RPC for the
 * Hermes `wag-worker` profile. Startup fails closed when:
 *  - DATABASE_URL is missing (the worker-role connection is supplied by the
 *    service wrapper, never by Hermes requests), or
 *  - the native peer-credential addon is not built (no mode-only degradation).
 *
 * No HTTP listener. SIGTERM/SIGINT release only the leases this process owns.
 */
import { hostname } from "node:os";
import path from "node:path";
import { AgentJobRepository } from "../src/repositories/agentJobRepository";
import { createAuditLogger, createFileAuditSink, errorClassOf } from "../src/lib/agent-worker/audit";
import { executeAgentJob, runRouterDecision } from "../src/lib/agent-worker/executor";
import { loadNativePeerCredentialProvider } from "../src/lib/agent-worker/peer-cred";
import { createRpcHandlers } from "../src/lib/agent-worker/rpc-handlers";
import { defaultAgentWorkerSocketPath, startAgentWorkerSocketServer } from "../src/lib/agent-worker/socket-server";
import { createWorkerLoop } from "../src/lib/agent-worker/worker-loop";

const log = (event: string, fields: Record<string, string | number | boolean> = {}) => {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
};

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim().length === 0) {
    throw new Error("DATABASE_URL is required (worker-role connection from the service wrapper)");
  }

  // Fail closed: the peer-UID gate needs the native bridge. No fallback exists.
  const peerCredentialProvider = loadNativePeerCredentialProvider(process.env.WAG_AGENT_WORKER_PEER_CRED_ADDON);

  const socketPath = process.env.WAG_AGENT_WORKER_SOCKET ?? defaultAgentWorkerSocketPath();
  const auditPath = path.join(path.dirname(socketPath), "agent-worker-audit.jsonl");
  const workerId = `${hostname()}-${process.pid}`;
  const startedAt = new Date();

  const audit = createAuditLogger(createFileAuditSink(auditPath));
  let fatal: (errorClass: string) => void = () => undefined;
  const loop = createWorkerLoop({
    repository: AgentJobRepository,
    execute: (job, signal) =>
      executeAgentJob(
        job,
        {
          decideRoute: (payload) =>
            runRouterDecision(payload, {
              scriptPath: process.env.WAG_AGENT_ROUTER_SCRIPT,
              pythonPath: process.env.WAG_AGENT_ROUTER_PYTHON,
            }),
        },
        signal,
      ),
    audit,
    workerId,
    onLoopError: (errorClass) => log("loop_error", { errorClass }),
    onFatal: (errorClass) => fatal(errorClass),
  });
  const handlers = createRpcHandlers({
    queue: AgentJobRepository,
    workerId,
    startedAt,
    activeJobs: () => loop.activeCount(),
  });
  const server = await startAgentWorkerSocketServer({
    socketPath,
    peerCredentialProvider,
    handlers,
    onRejectedConnection: (errorClass) => audit.recordConnectionRejected(errorClass),
    onHandlerError: (method, errorClass) => log("rpc_error", { method, errorClass }),
  });
  loop.start();
  log("started", { workerId, socketPath });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutdown_begin", { signal });
    try {
      await loop.shutdown();
      await server.close();
      log("shutdown_complete", { signal });
      process.exitCode = 0;
    } catch (error) {
      log("shutdown_error", { errorClass: errorClassOf(error) });
      process.exitCode = 1;
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  // Fail closed but deliberately: an audit-sink failure or any unhandled rejection
  // ends with lease release + socket close and exit code 1, never a crash mid-job.
  fatal = (errorClass) => {
    process.stderr.write(`agent-worker fatal: ${errorClass}\n`);
    void shutdown(`FATAL:${errorClass}`).finally(() => {
      process.exitCode = 1;
    });
  };
  process.on("unhandledRejection", (reason) => fatal(errorClassOf(reason)));
  process.on("uncaughtException", (error) => fatal(errorClassOf(error)));
}

main().catch((error: unknown) => {
  log("startup_failed", { errorClass: errorClassOf(error) });
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
