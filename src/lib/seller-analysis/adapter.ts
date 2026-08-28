// 저장된 SellerAiProfile.aiTags(JSONB) → 카드용 파생값 계산 (클라이언트/서버 공용, 순수).
// aiTags = { ...gemini분석(category/tags/audience 등), metrics(SellerMetrics), interaction_id }.
// computeSubScores·computeCategoryProfile 둘 다 unknown 입력을 방어적으로 정규화하므로 손상/누락에도 throw하지 않는다.
import { computeSubScores, SellerScores } from "./scores";
import { computeCategoryProfile, CategoryAffinity } from "./categoryProfile";
import { computeRiskFlags, RiskFlag, ProfileMeta } from "./riskFlags";
import type { PostPreview } from "./types";

export interface SellerAiView {
  scores: SellerScores;
  affinities: CategoryAffinity[];
  riskFlags: RiskFlag[];
  /** T3 피드 프리뷰 (구버전 레코드는 빈 배열) */
  postsPreview: PostPreview[];
  profileMeta: Partial<ProfileMeta> | null;
}

export function deriveSellerAiView(aiTags: unknown): SellerAiView {
  const tags = aiTags && typeof aiTags === "object" ? (aiTags as Record<string, unknown>) : {};
  const metrics = tags.metrics;
  const profileMeta =
    tags.profileMeta && typeof tags.profileMeta === "object"
      ? (tags.profileMeta as Partial<ProfileMeta>)
      : null;
  const postsPreview = Array.isArray(tags.postsPreview) ? (tags.postsPreview as PostPreview[]) : [];
  return {
    scores: computeSubScores(metrics),
    affinities: computeCategoryProfile(aiTags),
    riskFlags: computeRiskFlags(metrics, profileMeta, postsPreview),
    postsPreview,
    profileMeta,
  };
}
