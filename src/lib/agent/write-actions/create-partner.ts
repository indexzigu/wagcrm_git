import { z } from "zod";
import type { Prisma } from "@prisma/client";
import {
  MAX_PARTNER_CONTACTS,
  newPartnerInputSchema,
  partnerContactInputSchema,
} from "@/lib/agent-worker/contracts";
import { recordActivityCreate } from "@/lib/activity-log";
import { MASTER_DATA_INVALIDATION_TAGS } from "@/lib/cache-tags";
import { type WriteActionDefinition, type WriteActionResult } from "./types";

const createPartnerArgsSchema = z
  .object({
    partner: newPartnerInputSchema,
    contacts: z.array(partnerContactInputSchema).max(MAX_PARTNER_CONTACTS).optional(),
  })
  .strict();

export type CreatePartnerArgs = z.infer<typeof createPartnerArgsSchema>;

type NewPartnerArgs = z.infer<typeof newPartnerInputSchema>;
type PartnerContactArgs = z.infer<typeof partnerContactInputSchema>;

/**
 * 거래처 1행(+담당자)을 **호출부가 연 tx 안에서** 만든다. `create_partner` 와 거래처를 동봉한
 * `create_deal`(`./create-deal.ts`)이 같은 함수를 부른다 — 두 곳에 따로 적으면 한쪽만 칸이
 * 늘어난다. 정본 `PartnerService.createPartner` 는 tx 를 받지 않아 재사용하지 않는다
 * (change_deal_status 와 같은 이유).
 */
export async function createPartnerRow(
  partner: NewPartnerArgs,
  contacts: readonly PartnerContactArgs[],
  actor: string,
  tx: Prisma.TransactionClient
): Promise<{ id: string; name: string }> {
  const created = await tx.partner.create({
    data: {
      name: partner.name,
      type: partner.type,
      businessNumber: partner.businessNumber ?? null,
      ceoName: partner.ceoName ?? null,
      representativeEmail: partner.representativeEmail ?? null,
      address: partner.address ?? null,
      notes: partner.notes ?? null,
      ...(contacts.length > 0
        ? {
            contacts: {
              create: contacts.map((contact) => ({
                name: contact.name,
                role: contact.role ?? null,
                email: contact.email ?? null,
                phoneNumber: contact.phoneNumber ?? null,
              })),
            },
          }
        : {}),
    },
    select: { id: true, name: true },
  });

  await recordActivityCreate("PARTNER", created.id, actor, tx);
  return created;
}

/** 거래처를 만든다(WRITE 4종째). 정본이 라우트 둘로 나눠 하는 일을 한 트랜잭션으로 묶는다. */
async function handleCreatePartner(
  args: CreatePartnerArgs,
  actor: string,
  tx: Prisma.TransactionClient
): Promise<WriteActionResult> {
  const contacts = args.contacts ?? [];
  const partner = await createPartnerRow(args.partner, contacts, actor, tx);

  return {
    refType: "PARTNER",
    refId: partner.id,
    summary:
      `거래처 "${partner.name}"(${args.partner.type}) 등록` +
      (contacts.length > 0 ? `, 담당자 ${contacts.length}명` : ""),
  };
}

export const createPartnerAction: WriteActionDefinition<CreatePartnerArgs> = {
  argsSchema: createPartnerArgsSchema,
  handler: handleCreatePartner,
  // 정본 라우트 `POST /api/partners` 의 `revalidateMasterDataCaches()` 와 **같은 집합**.
  // 집합을 여기서 새로 고르지 말 것 — 정본과 갈리는 순간 두 경로의 화면이 달라진다.
  effects: () => ({ revalidate: MASTER_DATA_INVALIDATION_TAGS, calendarCampaignId: null }),
};
