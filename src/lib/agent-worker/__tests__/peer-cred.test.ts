import { describe, expect, it } from "vitest";
import { createServer, connect, type Socket } from "node:net";
import { existsSync, mkdtempSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PeerCredentialAddonError,
  defaultPeerCredAddonPath,
  loadNativePeerCredentialProvider,
  resolveSocketFd,
} from "../peer-cred";

function fakeSocket(handle: unknown): Socket {
  return { _handle: handle } as unknown as Socket;
}

describe("resolveSocketFd", () => {
  it("returns the handle fd only when it is a finite non-negative integer", () => {
    expect(resolveSocketFd(fakeSocket({ fd: 14 }))).toBe(14);
    expect(resolveSocketFd(fakeSocket({ fd: 0 }))).toBe(0);
    expect(resolveSocketFd(fakeSocket({ fd: -1 }))).toBeNull();
    expect(resolveSocketFd(fakeSocket({ fd: 1.5 }))).toBeNull();
    expect(resolveSocketFd(fakeSocket({ fd: Number.NaN }))).toBeNull();
    expect(resolveSocketFd(fakeSocket({ fd: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(resolveSocketFd(fakeSocket({ fd: "14" }))).toBeNull();
    expect(resolveSocketFd(fakeSocket({}))).toBeNull();
    expect(resolveSocketFd(fakeSocket(null))).toBeNull();
    expect(resolveSocketFd(fakeSocket(undefined))).toBeNull();
  });
});

describe("loadNativePeerCredentialProvider", () => {
  it("fails closed when the addon is missing", () => {
    expect(() => loadNativePeerCredentialProvider("/nonexistent/peer_cred.node")).toThrow(
      PeerCredentialAddonError,
    );
  });
});

const addonPath = defaultPeerCredAddonPath();

describe.skipIf(!existsSync(addonPath))("native peer-cred addon (same UID)", () => {
  it("reports the connecting peer uid equal to the worker uid over a real Unix socket", async () => {
    const provider = loadNativePeerCredentialProvider(addonPath);
    const directory = mkdtempSync(join(tmpdir(), "wag-pc-"));
    const socketPath = join(directory, "s.sock");
    try {
      const credentials = await new Promise<{ uid: number; gid: number }>((resolve, reject) => {
        const server = createServer((socket) => {
          try {
            const fd = resolveSocketFd(socket);
            if (fd === null) throw new Error("fd not exposed");
            resolve(provider(fd));
          } catch (error) {
            reject(error);
          } finally {
            socket.destroy();
            server.close();
          }
        });
        server.on("error", reject);
        server.listen(socketPath, () => {
          const client = connect(socketPath);
          client.on("error", reject);
        });
      });
      expect(credentials.uid).toBe(process.getuid?.());
      expect(credentials.gid).toBe(process.getgid?.());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("throws instead of returning a default uid for invalid or non-socket descriptors", () => {
    const provider = loadNativePeerCredentialProvider(addonPath);
    expect(() => provider(-1)).toThrow();
    expect(() => provider(Number.NaN)).toThrow();
    expect(() => provider(1.5)).toThrow();
    const fileFd = openSync(__filename, "r");
    try {
      expect(() => provider(fileFd)).toThrow();
    } finally {
      closeSync(fileFd);
    }
  });
});
