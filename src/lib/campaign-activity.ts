import { getPrisma } from "./prisma";

type CampaignActivityInput = {
  campaignId: string;
  action: string;
  label: string;
  details?: string | null;
  actor?: string;
};

export async function recordCampaignActivity(input: CampaignActivityInput) {
  return getPrisma().campaignActivity.create({
    data: {
      campaignId: input.campaignId,
      action: input.action,
      label: input.label,
      details: input.details ?? null,
      actor: input.actor ?? "SYSTEM",
    },
  });
}

export function describeChangedFields(changes: string[]) {
  if (changes.length === 0) return null;
  return changes.join(", ");
}
