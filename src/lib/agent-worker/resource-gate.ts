export type LocalResourceSnapshot = {
  colimaRunning: boolean;
  memoryFreePercent: number;
  swapUsedBytes: number;
  swapIncreaseBytesInFiveMinutes: number;
  dockerDbHealthy: boolean;
  anotherOllamaModelLoaded: boolean;
};

export type ResourceGateResult =
  | { status: "ALLOW_LOCAL" }
  | {
      status: "RESOURCE_DEFERRED";
      reason:
        | "invalid_resource_snapshot"
        | "COLIMA_RUNNING"
        | "MEMORY_LOW"
        | "SWAP_USED_HIGH"
        | "SWAP_INCREASE_HIGH"
        | "DOCKER_DB_UNHEALTHY"
        | "OLLAMA_MODEL_ALREADY_LOADED"
        | "MODEL_UNSUPPORTED";
    };

const MIN_FREE_MEMORY_PERCENT = 20;
const MAX_SWAP_USED_BYTES = 512 * 1024 * 1024;
const MAX_SWAP_INCREASE_BYTES = 256 * 1024 * 1024;

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isValidResourceSnapshot(snapshot: LocalResourceSnapshot): boolean {
  return [
    snapshot.memoryFreePercent,
    snapshot.swapUsedBytes,
    snapshot.swapIncreaseBytesInFiveMinutes,
  ].every(isFiniteNonNegative);
}

export function evaluateResourceGate(
  snapshot: LocalResourceSnapshot,
  localModel: string,
): ResourceGateResult {
  if (!isValidResourceSnapshot(snapshot)) {
    return { status: "RESOURCE_DEFERRED", reason: "invalid_resource_snapshot" };
  }
  if (localModel !== "qwen3.5:9b" && localModel !== "glm4:9b") {
    return { status: "RESOURCE_DEFERRED", reason: "MODEL_UNSUPPORTED" };
  }
  if (snapshot.colimaRunning) {
    return { status: "RESOURCE_DEFERRED", reason: "COLIMA_RUNNING" };
  }
  if (snapshot.memoryFreePercent < MIN_FREE_MEMORY_PERCENT) {
    return { status: "RESOURCE_DEFERRED", reason: "MEMORY_LOW" };
  }
  if (snapshot.swapUsedBytes > MAX_SWAP_USED_BYTES) {
    return { status: "RESOURCE_DEFERRED", reason: "SWAP_USED_HIGH" };
  }
  if (snapshot.swapIncreaseBytesInFiveMinutes > MAX_SWAP_INCREASE_BYTES) {
    return { status: "RESOURCE_DEFERRED", reason: "SWAP_INCREASE_HIGH" };
  }
  if (!snapshot.dockerDbHealthy) {
    return { status: "RESOURCE_DEFERRED", reason: "DOCKER_DB_UNHEALTHY" };
  }
  if (snapshot.anotherOllamaModelLoaded) {
    return { status: "RESOURCE_DEFERRED", reason: "OLLAMA_MODEL_ALREADY_LOADED" };
  }
  return { status: "ALLOW_LOCAL" };
}
