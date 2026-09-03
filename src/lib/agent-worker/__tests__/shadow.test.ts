import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentJobPayload, AgentJobResult } from "../contracts";
import { evaluateResourceGate, type LocalResourceSnapshot } from "../resource-gate";
import type { RouterDecision } from "../router";
import {
  EMPTY_SHADOW_VALIDATORS,
  LOCAL_MODEL_REQUEST_OPTIONS,
  LOCAL_MODELS,
  SHADOW_TIMEOUT_MS,
  hasShadowValidator,
  runLocalShadow,
  shadowAuditFields,
  type LocalModelClient,
  type LocalModelRequest,
  type ShadowValidator,
} from "../shadow";

const SENTINELS = {
  prompt: "SENTINEL_SHADOW_PROMPT_7a1b",
  localOutput: "SENTINEL_LOCAL_RAW_OUTPUT_3c9d",
  userInput: "SENTINEL_USER_INPUT_e4f5",
  canonical: "SENTINEL_CANONICAL_SUMMARY_6b2c",
};

const payload: AgentJobPayload = {
  schemaVersion: 1,
  taskType: "routine",
  skill: "candidate-skill",
  operation: "search_deals",
  input: { query: SENTINELS.userInput },
  origin: { source: "hermes_slack", correlationId: "c-1", requesterDigest: "r", threadDigest: "t" },
};

const canonical: AgentJobResult = {
  schemaVersion: 1,
  jobId: "job-1",
  status: "SUCCEEDED",
  route: "local_shadow",
  modelUsed: "none",
  validationResult: "pass",
  resultSummary: SENTINELS.canonical,
  actionProposalId: null,
  evidenceRefs: [],
};

const decision = (model = "qwen3.5:9b"): RouterDecision => ({ route: "local_shadow", model, reason: "not_promoted" });

const healthySnapshot: LocalResourceSnapshot = {
  colimaRunning: false,
  memoryFreePercent: 20,
  swapUsedBytes: 512 * 1024 * 1024,
  swapIncreaseBytesInFiveMinutes: 256 * 1024 * 1024,
  dockerDbHealthy: true,
  anotherOllamaModelLoaded: false,
};

function fakeClient(output = SENTINELS.localOutput) {
  const calls: LocalModelRequest[] = [];
  const client: LocalModelClient = {
    generate: vi.fn(async (request: LocalModelRequest) => {
      calls.push(request);
      return { output };
    }),
  };
  return { client, calls };
}

function validator(result: "pass" | "fail" = "pass") {
  const seen: Array<{ localOutput: string; canonical: AgentJobResult }> = [];
  const impl: ShadowValidator = {
    buildPrompt: () => SENTINELS.prompt,
    validate: (input) => {
      seen.push(input);
      return result;
    },
  };
  return { impl, seen };
}

function deps(overrides: Partial<Parameters<typeof runLocalShadow>[0]["deps"]> = {}) {
  const { client } = fakeClient();
  return {
    client,
    validators: EMPTY_SHADOW_VALIDATORS,
    resourceSnapshot: async () => healthySnapshot,
    ...overrides,
  };
}

describe("local shadow gates (plan contract 7/8)", () => {
  it("pins the Ollama request contract: num_ctx 4096, keep_alive 0, json format, thinking off", () => {
    expect(LOCAL_MODEL_REQUEST_OPTIONS).toEqual({ num_ctx: 4096, keep_alive: 0, format: "json", think: false });
    expect(Object.isFrozen(LOCAL_MODEL_REQUEST_OPTIONS)).toBe(true);
  });

  it("accepts exactly qwen3.5:9b and glm4:9b and rejects gpt-oss:20b through the Task 4 resource gate", () => {
    expect([...LOCAL_MODELS]).toEqual(["qwen3.5:9b", "glm4:9b"]);
    expect(evaluateResourceGate(healthySnapshot, "qwen3.5:9b")).toEqual({ status: "ALLOW_LOCAL" });
    expect(evaluateResourceGate(healthySnapshot, "glm4:9b")).toEqual({ status: "ALLOW_LOCAL" });
    expect(evaluateResourceGate(healthySnapshot, "gpt-oss:20b")).toEqual({ status: "RESOURCE_DEFERRED", reason: "MODEL_UNSUPPORTED" });
  });

  it("skips the shadow for gpt-oss:20b even when a validator is registered and never calls the local model", async () => {
    const { client, calls } = fakeClient();
    const { impl } = validator();

    const outcome = await runLocalShadow({
      payload,
      decision: decision("gpt-oss:20b"),
      canonical,
      deps: deps({ client, validators: { "candidate-skill": impl } }),
    });

    expect(outcome).toEqual({ status: "skipped", reason: "resource_deferred:MODEL_UNSUPPORTED" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [{ ...healthySnapshot, colimaRunning: true }, "COLIMA_RUNNING"],
    [{ ...healthySnapshot, memoryFreePercent: 19.99 }, "MEMORY_LOW"],
    [{ ...healthySnapshot, swapUsedBytes: 512 * 1024 * 1024 + 1 }, "SWAP_USED_HIGH"],
    [{ ...healthySnapshot, swapIncreaseBytesInFiveMinutes: 256 * 1024 * 1024 + 1 }, "SWAP_INCREASE_HIGH"],
    [{ ...healthySnapshot, dockerDbHealthy: false }, "DOCKER_DB_UNHEALTHY"],
    [{ ...healthySnapshot, anotherOllamaModelLoaded: true }, "OLLAMA_MODEL_ALREADY_LOADED"],
    [{ ...healthySnapshot, memoryFreePercent: Number.NaN }, "invalid_resource_snapshot"],
  ] as const)("defers the shadow deterministically for contract-8 resource case %#: %s", async (snapshot, reason) => {
    const { client, calls } = fakeClient();
    const { impl } = validator();

    const outcome = await runLocalShadow({
      payload,
      decision: decision(),
      canonical,
      deps: deps({ client, validators: { "candidate-skill": impl }, resourceSnapshot: async () => snapshot }),
    });

    expect(outcome).toEqual({ status: "skipped", reason: `resource_deferred:${reason}` });
    expect(calls).toHaveLength(0);
  });

  it("treats a throwing resource probe as a deferral, never as permission to call the local model", async () => {
    const { client, calls } = fakeClient();
    const { impl } = validator();

    const outcome = await runLocalShadow({
      payload,
      decision: decision(),
      canonical,
      deps: deps({
        client,
        validators: { "candidate-skill": impl },
        resourceSnapshot: async () => {
          throw new Error("vm_stat unavailable");
        },
      }),
    });

    expect(outcome).toEqual({ status: "skipped", reason: "resource_deferred:invalid_resource_snapshot" });
    expect(calls).toHaveLength(0);
  });
});

describe("local shadow validator registry", () => {
  it("ships with no registered validator (mirrors the empty validator_skills registry)", () => {
    expect(Object.keys(EMPTY_SHADOW_VALIDATORS)).toEqual([]);
    expect(Object.isFrozen(EMPTY_SHADOW_VALIDATORS)).toBe(true);
    expect(hasShadowValidator(EMPTY_SHADOW_VALIDATORS, "candidate-skill")).toBe(false);
  });

  it("checks own properties only: prototype members are not validators", () => {
    const { impl } = validator();
    expect(hasShadowValidator({ "candidate-skill": impl }, "candidate-skill")).toBe(true);
    expect(hasShadowValidator({ "candidate-skill": impl }, "constructor")).toBe(false);
    expect(hasShadowValidator({ "candidate-skill": impl }, "toString")).toBe(false);
  });

  it("skips with validator_missing when the skill has no registered validator, without probing resources", async () => {
    const { client, calls } = fakeClient();
    const resourceSnapshot = vi.fn(async () => healthySnapshot);

    const outcome = await runLocalShadow({ payload, decision: decision(), canonical, deps: deps({ client, resourceSnapshot }) });

    expect(outcome).toEqual({ status: "skipped", reason: "validator_missing" });
    expect(calls).toHaveLength(0);
    expect(resourceSnapshot).not.toHaveBeenCalled();
  });
});

describe("local shadow execution", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls the local model once with the pinned options and passes the raw output only to the registered validator", async () => {
    const { client, calls } = fakeClient();
    const { impl, seen } = validator("pass");

    const outcome = await runLocalShadow({
      payload,
      decision: decision("glm4:9b"),
      canonical,
      deps: deps({ client, validators: { "candidate-skill": impl } }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ model: "glm4:9b", prompt: SENTINELS.prompt, options: LOCAL_MODEL_REQUEST_OPTIONS });
    expect(seen).toEqual([{ localOutput: SENTINELS.localOutput, canonical }]);
    expect(outcome).toEqual({ status: "validated", validationResult: "pass", correction: false });
  });

  it("records a validator failure as an external-model correction", async () => {
    const { client } = fakeClient();
    const { impl } = validator("fail");

    const outcome = await runLocalShadow({ payload, decision: decision(), canonical, deps: deps({ client, validators: { "candidate-skill": impl } }) });

    expect(outcome).toEqual({ status: "validated", validationResult: "fail", correction: true });
  });

  it("reduces a local model or validator failure to its error class only", async () => {
    const failing: LocalModelClient = {
      generate: async () => {
        const error = new Error(`connect ECONNREFUSED 127.0.0.1:11434 ${SENTINELS.localOutput}`);
        error.name = "OllamaUnavailableError";
        throw error;
      },
    };
    const { impl } = validator();
    const outcome = await runLocalShadow({ payload, decision: decision(), canonical, deps: deps({ client: failing, validators: { "candidate-skill": impl } }) });
    expect(outcome).toEqual({ status: "errored", errorClass: "OllamaUnavailableError" });

    const { client } = fakeClient();
    const throwing: ShadowValidator = {
      buildPrompt: () => SENTINELS.prompt,
      validate: () => {
        throw new TypeError(`bad json ${SENTINELS.localOutput}`);
      },
    };
    const validatorOutcome = await runLocalShadow({ payload, decision: decision(), canonical, deps: deps({ client, validators: { "candidate-skill": throwing } }) });
    expect(validatorOutcome).toEqual({ status: "errored", errorClass: "TypeError" });
  });

  it("never carries the prompt, local raw output, user input, or canonical summary in its outcome or audit fields", async () => {
    const { client } = fakeClient();
    const { impl } = validator("fail");

    const outcome = await runLocalShadow({ payload, decision: decision(), canonical, deps: deps({ client, validators: { "candidate-skill": impl } }) });
    const serialized = JSON.stringify([outcome, shadowAuditFields(outcome)]);

    for (const sentinel of Object.values(SENTINELS)) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("pins the shadow time budget inside the 300 s job runtime and ends a never-resolving client as ShadowTimeoutError", async () => {
    vi.useFakeTimers();
    expect(SHADOW_TIMEOUT_MS).toBe(90_000);
    expect(SHADOW_TIMEOUT_MS).toBeLessThan(300_000);
    let signalAborted = false;
    const hung: LocalModelClient = {
      generate: (_request, signal) =>
        new Promise(() => {
          signal.addEventListener("abort", () => {
            signalAborted = true;
          });
        }),
    };
    const { impl, seen } = validator();

    const pending = runLocalShadow({ payload, decision: decision(), canonical, deps: deps({ client: hung, validators: { "candidate-skill": impl } }) });
    await vi.advanceTimersByTimeAsync(SHADOW_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ status: "errored", errorClass: "ShadowTimeoutError" });
    expect(signalAborted).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("holds a single local slot: an overlapping shadow is skipped with LOCAL_BUSY and the slot is released afterwards", async () => {
    let release!: (value: { output: string }) => void;
    let inFlight = 0;
    let maxInFlight = 0;
    const client: LocalModelClient = {
      generate: () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) => {
          release = (value) => {
            inFlight -= 1;
            resolve(value);
          };
        });
      },
    };
    const generate = vi.spyOn(client, "generate");
    const { impl } = validator("pass");
    const shadowDeps = deps({ client, validators: { "candidate-skill": impl } });

    const first = runLocalShadow({ payload, decision: decision(), canonical, deps: shadowDeps });
    await Promise.resolve();
    const second = await runLocalShadow({ payload, decision: decision("glm4:9b"), canonical, deps: shadowDeps });
    expect(second).toEqual({ status: "skipped", reason: "resource_deferred:LOCAL_BUSY" });

    release({ output: SENTINELS.localOutput });
    await expect(first).resolves.toEqual({ status: "validated", validationResult: "pass", correction: false });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(maxInFlight).toBe(1);

    const third = runLocalShadow({ payload, decision: decision(), canonical, deps: shadowDeps });
    await Promise.resolve();
    release({ output: SENTINELS.localOutput });
    await expect(third).resolves.toEqual({ status: "validated", validationResult: "pass", correction: false });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("maps every outcome onto the frozen audit fields (validationResult, correction, escalationReason, errorClass)", () => {
    expect(shadowAuditFields({ status: "validated", validationResult: "pass", correction: false })).toEqual({
      validationResult: "pass",
      correction: false,
      escalationReason: null,
      errorClass: null,
    });
    expect(shadowAuditFields({ status: "validated", validationResult: "fail", correction: true })).toEqual({
      validationResult: "fail",
      correction: true,
      escalationReason: null,
      errorClass: null,
    });
    expect(shadowAuditFields({ status: "skipped", reason: "validator_missing" })).toEqual({
      validationResult: "not_validated",
      correction: false,
      escalationReason: "validator_missing",
      errorClass: null,
    });
    expect(shadowAuditFields({ status: "skipped", reason: "resource_deferred:MEMORY_LOW" })).toEqual({
      validationResult: "not_validated",
      correction: false,
      escalationReason: "resource_deferred:MEMORY_LOW",
      errorClass: null,
    });
    expect(shadowAuditFields({ status: "skipped", reason: "resource_deferred:LOCAL_BUSY" })).toEqual({
      validationResult: "not_validated",
      correction: false,
      escalationReason: "resource_deferred:LOCAL_BUSY",
      errorClass: null,
    });
    expect(shadowAuditFields({ status: "errored", errorClass: "OllamaUnavailableError" })).toEqual({
      validationResult: "not_validated",
      correction: false,
      escalationReason: "local_model_error",
      errorClass: "OllamaUnavailableError",
    });
  });
});
