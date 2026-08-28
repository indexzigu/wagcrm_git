/**
 * Phase 3 픽스처 경로 상수 (청사진 §4 실측 검증 완료 픽스처 4종).
 * 픽스처는 리포지토리 밖(wagcrm_bizplan/4_handoff)에 있으므로, 파일이 없는 CI 환경에서는
 * describe.skipIf로 건너뛴다 — 로컬/사내 환경에서는 실파일로 회귀 검증한다.
 */
import { existsSync } from "node:fs";
import path from "node:path";

const FIXTURE_ROOT =
  "/Users/z9/Projects/wagcrm_bizplan/4_handoff/pricesheet_samples";

export const FIXTURES = {
  nutrione: path.join(FIXTURE_ROOT, "nutrione_simulator.xlsx"),
  hisonic: path.join(FIXTURE_ROOT, "hisonic_s_pricesheet.xlsx"),
  coringco: path.join(FIXTURE_ROOT, "coringco.xlsx"),
  igojin: path.join(FIXTURE_ROOT, "igojin_climber_proposal.pptx"),
};

export function fixturesAvailable(): boolean {
  return Object.values(FIXTURES).every((p) => existsSync(p));
}
