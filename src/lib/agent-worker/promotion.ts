/**
 * Promotion evaluator (plan Task 7).
 *
 * Pure function over audit samples of one skill's `local_shadow`/`local` runs.
 * It mirrors `local-llm-route.py evaluate` exactly (schema_version 1 thresholds)
 * and only ever recommends: nothing here reads or writes the routing config —
 * promotion stays an owner action.
 */
export const PROMOTION_THRESHOLDS = Object.freeze({
  minimumSamples: 100,
  minimumPassRate: 0.98,
  maximumCorrectionRate: 0.02,
  minimumConsecutivePasses: 20,
  validatorRequired: true,
} as const);

export type PromotionSample = {
  validationResult: "pass" | "fail" | "not_validated";
  correction: boolean;
};

export type PromotionUnmet = "samples" | "pass_rate" | "correction_rate" | "consecutive_passes" | "validator";

export type PromotionEvaluation = {
  action: "recommend_promotion" | "keep_unpromoted";
  unmet: PromotionUnmet[];
};

function trailingPasses(samples: readonly PromotionSample[]): number {
  let count = 0;
  for (let index = samples.length - 1; index >= 0 && samples[index].validationResult === "pass"; index -= 1) {
    count += 1;
  }
  return count;
}

/** `samples` must be in chronological order; the last 20 are the consecutive-pass window. */
export function evaluatePromotion(
  samples: readonly PromotionSample[],
  input: { validatorRegistered: boolean },
): PromotionEvaluation {
  const total = samples.length;
  const passed = samples.filter((sample) => sample.validationResult === "pass").length;
  const corrected = samples.filter((sample) => sample.correction).length;
  const unmet: PromotionUnmet[] = [];

  if (total < PROMOTION_THRESHOLDS.minimumSamples) unmet.push("samples");
  if (total === 0 || passed / total < PROMOTION_THRESHOLDS.minimumPassRate) unmet.push("pass_rate");
  if (total === 0 || corrected / total > PROMOTION_THRESHOLDS.maximumCorrectionRate) unmet.push("correction_rate");
  if (trailingPasses(samples) < PROMOTION_THRESHOLDS.minimumConsecutivePasses) unmet.push("consecutive_passes");
  if (
    PROMOTION_THRESHOLDS.validatorRequired &&
    (!input.validatorRegistered || samples.some((sample) => sample.validationResult === "not_validated"))
  ) {
    unmet.push("validator");
  }

  return { action: unmet.length === 0 ? "recommend_promotion" : "keep_unpromoted", unmet };
}
