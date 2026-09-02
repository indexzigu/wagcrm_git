import type { AgentJobPayload, AgentJobResult } from "./contracts";
import { evaluateResourceGate, type LocalResourceSnapshot, type ResourceGateResult } from "./resource-gate";
import type { RouterDecision } from "./router";

/**
 * Local shadow instrumentation (plan Task 7, contracts 7/8).
 *
 * `local_shadow` never produces a user-facing result. After the deterministic
 * operation succeeded, the local model is asked the same question and its raw
 * output goes to exactly one place: the validator registered for the skill.
 * Only the validator's verdict (`pass`/`fail`) leaves this module; the prompt,
 * the raw local output, and the canonical result are never returned or logged.
 *
 * Two independent gates keep local calls at zero today:
 *  - the router only returns `local_shadow` for a skill in `candidate_skills`
 *    that also has `--validator` set and is in `validator_skills` (both empty), and
 *  - this module only calls the model when the worker has a validator registered
 *    for the skill (`EMPTY_SHADOW_VALIDATORS` today).
 */
export const LOCAL_MODELS = ["qwen3.5:9b", "glm4:9b"] as const;
export type LocalModel = (typeof LOCAL_MODELS)[number];

/** Ollama request contract fixed by contract 8 and the local-llm operations card. */
export const LOCAL_MODEL_REQUEST_OPTIONS = Object.freeze({
  num_ctx: 4096,
  keep_alive: 0,
  format: "json",
  think: false,
} as const);

export type LocalModelRequest = {
  model: LocalModel;
  prompt: string;
  options: typeof LOCAL_MODEL_REQUEST_OPTIONS;
};

/** Injected transport to the single local model; the worker never constructs one itself. */
export interface LocalModelClient {
  generate(request: LocalModelRequest, signal: AbortSignal): Promise<{ output: string }>;
}

export type ShadowValidationResult = "pass" | "fail";

/**
 * A validator owns both sides of the comparison for one skill: how the local
 * model is asked, and whether its output matches the canonical result.
 */
export interface ShadowValidator {
  buildPrompt(payload: AgentJobPayload): string;
  validate(input: { localOutput: string; canonical: AgentJobResult }): ShadowValidationResult;
}

export type ShadowValidatorRegistry = Readonly<Record<string, ShadowValidator>>;

/** Mirrors the empty `validator_skills` registry: no skill may be shadowed yet. */
export const EMPTY_SHADOW_VALIDATORS: ShadowValidatorRegistry = Object.freeze({});

export type ShadowDeps = {
  client: LocalModelClient;
  validators: ShadowValidatorRegistry;
  resourceSnapshot: () => Promise<LocalResourceSnapshot>;
};

type DeferredReason = Extract<ResourceGateResult, { status: "RESOURCE_DEFERRED" }>["reason"];

export type ShadowOutcome =
  | { status: "skipped"; reason: "validator_missing" | `resource_deferred:${DeferredReason}` }
  | { status: "validated"; validationResult: ShadowValidationResult; correction: boolean }
  | { status: "errored"; errorClass: string };

/** Audit-facing projection: exactly the fields `AGENT_WORKER_AUDIT_FIELDS` already defines. */
export type ShadowAuditFields = {
  validationResult: ShadowValidationResult | "not_validated";
  correction: boolean;
  escalationReason: string | null;
  errorClass: string | null;
};

export function hasShadowValidator(validators: ShadowValidatorRegistry, skill: string): boolean {
  return Object.hasOwn(validators, skill);
}

function isLocalModel(model: string): model is LocalModel {
  return (LOCAL_MODELS as readonly string[]).includes(model);
}

function errorClassOf(error: unknown): string {
  return error instanceof Error && error.name.trim().length > 0 ? error.name.slice(0, 128) : "UnknownError";
}

export async function runLocalShadow(input: {
  payload: AgentJobPayload;
  decision: RouterDecision;
  canonical: AgentJobResult;
  deps: ShadowDeps;
  signal?: AbortSignal;
}): Promise<ShadowOutcome> {
  const { payload, decision, canonical, deps } = input;
  if (!hasShadowValidator(deps.validators, payload.skill)) {
    return { status: "skipped", reason: "validator_missing" };
  }

  let snapshot: LocalResourceSnapshot;
  try {
    snapshot = await deps.resourceSnapshot();
  } catch {
    // An unreadable probe is a deferral, never permission (fail closed like the gate itself).
    return { status: "skipped", reason: "resource_deferred:invalid_resource_snapshot" };
  }
  const gate = evaluateResourceGate(snapshot, decision.model);
  if (gate.status !== "ALLOW_LOCAL" || !isLocalModel(decision.model)) {
    const reason = gate.status === "ALLOW_LOCAL" ? "MODEL_UNSUPPORTED" : gate.reason;
    return { status: "skipped", reason: `resource_deferred:${reason}` };
  }

  const validator = deps.validators[payload.skill];
  try {
    const { output } = await deps.client.generate(
      { model: decision.model, prompt: validator.buildPrompt(payload), options: LOCAL_MODEL_REQUEST_OPTIONS },
      input.signal ?? new AbortController().signal,
    );
    const validationResult = validator.validate({ localOutput: output, canonical });
    return { status: "validated", validationResult, correction: validationResult === "fail" };
  } catch (error) {
    return { status: "errored", errorClass: errorClassOf(error) };
  }
}

export function shadowAuditFields(outcome: ShadowOutcome): ShadowAuditFields {
  switch (outcome.status) {
    case "validated":
      return { validationResult: outcome.validationResult, correction: outcome.correction, escalationReason: null, errorClass: null };
    case "skipped":
      return { validationResult: "not_validated", correction: false, escalationReason: outcome.reason, errorClass: null };
    case "errored":
      return { validationResult: "not_validated", correction: false, escalationReason: "local_model_error", errorClass: outcome.errorClass };
  }
}
