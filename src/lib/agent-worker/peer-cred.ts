import { createRequire } from "node:module";
import path from "node:path";
import type { Socket } from "node:net";

/**
 * Peer-credential bridge for the agent worker UDS (task-5 brief addendum, 2026-09-02).
 *
 * Node 24 exposes no peer-UID API for Unix sockets, so the worker loads a
 * project-local native addon (`native/peer-cred`, `getpeereid(2)` through
 * node-addon-api). The addon is built only by `npm run agent-worker:build-native`;
 * the web deploy never builds or loads it. The worker refuses to start without it —
 * there is no filesystem-mode-only fallback.
 */
export type PeerCredentials = { uid: number; gid: number };
export type PeerCredentialProvider = (fd: number) => PeerCredentials;

export const PEER_CRED_ADDON_RELATIVE_PATH = path.join(
  "src",
  "lib",
  "agent-worker",
  "native",
  "peer-cred",
  "build",
  "Release",
  "peer_cred.node",
);

export class PeerCredentialAddonError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PeerCredentialAddonError";
  }
}

export function defaultPeerCredAddonPath(repositoryRoot = process.cwd()): string {
  return path.join(repositoryRoot, PEER_CRED_ADDON_RELATIVE_PATH);
}

/** Reads the libuv handle fd; anything but a finite non-negative integer is "no fd". */
export function resolveSocketFd(socket: Socket): number | null {
  const handle = (socket as unknown as { _handle?: { fd?: unknown } | null })._handle;
  const fd = handle?.fd;
  if (typeof fd !== "number" || !Number.isInteger(fd) || fd < 0) {
    return null;
  }
  return fd;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function loadNativePeerCredentialProvider(
  addonPath = defaultPeerCredAddonPath(),
): PeerCredentialProvider {
  const nativeRequire = createRequire(addonPath);
  let addon: unknown;
  try {
    addon = nativeRequire(addonPath);
  } catch (error) {
    throw new PeerCredentialAddonError(
      `peer-cred native addon is not available at ${addonPath}; run "npm run agent-worker:build-native"`,
      { cause: error },
    );
  }
  const getPeerCredentials = (addon as { getPeerCredentials?: unknown }).getPeerCredentials;
  if (typeof getPeerCredentials !== "function") {
    throw new PeerCredentialAddonError("peer-cred native addon does not export getPeerCredentials");
  }

  return (fd: number): PeerCredentials => {
    const raw = (getPeerCredentials as (fd: number) => unknown)(fd);
    const uid = (raw as { uid?: unknown } | null)?.uid;
    const gid = (raw as { gid?: unknown } | null)?.gid;
    if (!isNonNegativeInteger(uid) || !isNonNegativeInteger(gid)) {
      throw new PeerCredentialAddonError("peer-cred native addon returned invalid credentials");
    }
    return { uid, gid };
  };
}
