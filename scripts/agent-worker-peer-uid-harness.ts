/**
 * Test-only socket harness for scripts/agent-worker-peer-uid-check.sh.
 *
 * Starts ONLY the UDS server with the real native peer-credential addon and a
 * stub `health` handler — no database, no job loop. With
 * WAG_PEER_UID_HARNESS_RELAX_MODES=1 it widens its own temporary directory/socket
 * modes after listen so a second local user can reach the peer gate (the gate,
 * not the filesystem, must reject them). Never point this at the real socket path.
 */
import { chmodSync } from "node:fs";
import path from "node:path";
import { loadNativePeerCredentialProvider } from "../src/lib/agent-worker/peer-cred";
import { RpcError, startAgentWorkerSocketServer } from "../src/lib/agent-worker/socket-server";

function resolveSocketPath(): string {
  const candidate = process.env.WAG_AGENT_WORKER_SOCKET;
  if (!candidate || !candidate.startsWith("/tmp/wag-peer-uid.")) {
    throw new Error("harness requires WAG_AGENT_WORKER_SOCKET under /tmp/wag-peer-uid.*");
  }
  return candidate;
}
const socketPath: string = resolveSocketPath();

const log = (event: string, fields: Record<string, string> = {}) => {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
};

async function main(): Promise<void> {
  const provider = loadNativePeerCredentialProvider();
  const unsupported = async () => {
    throw new RpcError("HARNESS_STUB");
  };
  const server = await startAgentWorkerSocketServer({
    socketPath,
    peerCredentialProvider: provider,
    handlers: {
      submit: unsupported,
      get: unsupported,
      wait: unsupported,
      cancel_unclaimed: unsupported,
      health: async () => ({ ok: true, harness: true }),
    },
    onRejectedConnection: (errorClass) => log("rejected", { errorClass }),
  });
  if (process.env.WAG_PEER_UID_HARNESS_RELAX_MODES === "1") {
    chmodSync(path.dirname(path.dirname(socketPath)), 0o711);
    chmodSync(path.dirname(socketPath), 0o711);
    chmodSync(socketPath, 0o666);
    log("relaxed_modes");
  }
  log("ready", { socketPath });
  const stop = () => void server.close().then(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch((error: unknown) => {
  log("startup_failed", { errorClass: error instanceof Error ? error.name : "UnknownError" });
  process.exit(1);
});
