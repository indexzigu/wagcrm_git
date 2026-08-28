import { z } from "zod";
import type { SalesChannel } from "@/lib/crm-types";

export const SALES_CHANNELS: SalesChannel[] = [
  "UNSPECIFIED",
  "OWN_MALL",
  "OWN_MALL_NAVER",
  "OWN_MALL_KAKAO",
  "SELLER_MALL",
  "BRAND_MALL",
];

export const campaignFormSchema = z
  .object({
    dealId: z.string().min(1, "딜을 선택해주세요"),
    sellerId: z.string().min(1, "셀러를 선택해주세요"),
    salesChannel: z.enum(
      ["UNSPECIFIED", "OWN_MALL", "OWN_MALL_NAVER", "OWN_MALL_KAKAO", "SELLER_MALL", "BRAND_MALL"],
      { error: "판매채널을 선택해주세요" },
    ),
    startDate: z.string().min(1, "시작일을 입력해주세요"),
    endDate: z.string().min(1, "종료일을 입력해주세요"),
  })
  .refine(
    (data) => {
      if (!data.startDate || !data.endDate) return true;
      return data.endDate >= data.startDate;
    },
    {
      message: "종료일은 시작일 이후여야 합니다",
      path: ["endDate"],
    },
  );

export type CampaignFormInput = z.infer<typeof campaignFormSchema>;
