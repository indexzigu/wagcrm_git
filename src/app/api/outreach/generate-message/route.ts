import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { GoogleGenAI } from "@google/genai";
import { GEMINI_PRIMARY_MODEL, GEMINI_THINK_LOW } from "@/lib/gemini-model";
import { withGeminiKeyRotation } from "@/lib/agent/gemini-client";

// ⚠️ 키를 모듈 상수로 박으면 그 계정이 월 상한에 걸리는 순간 이 기능이 멈춘다
// (2026-07-30 실측). 호출마다 로테이션된 키로 클라이언트를 만든다.
const clientFor = (apiKey: string) => new GoogleGenAI({ apiKey });
const prisma = getPrisma();

export async function POST(req: Request) {
  try {
    const { dealId, sellerId } = await req.json();

    if (!dealId || !sellerId) {
      return NextResponse.json({ error: "dealId and sellerId are required" }, { status: 400 });
    }

    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
    });

    const seller = await prisma.seller.findUnique({
      where: { id: sellerId },
    });

    if (!deal || !seller) {
      return NextResponse.json({ error: "Deal or Seller not found" }, { status: 404 });
    }

    const systemInstruction = `당신은 10년차 탑티어 이커머스 영업(MD) 전문가입니다.
인플루언서(셀러)에게 상품 공구를 제안하는 연락 메시지 초안을 작성해주세요.
- 셀러의 성향(카테고리, 소개글)을 반영하여 친근하고 매력적인 도입부 작성.
- 상품(딜)의 특장점과 매력을 명확히 전달.
- 과도하게 길지 않게, 모바일에서도 읽기 편하게 작성 (줄바꿈 적절히).
- 이메일이나 DM으로 바로 복사해서 보낼 수 있는 형태여야 합니다.
- 빈칸(예: [담당자 이름], [날짜]) 없이 구체적으로 제안하는 형태로 작성하되, 필요시 [  ] 형태로 남겨두어 사용자가 채울 수 있게 합니다.
- 정중하면서도 영업력 있는 톤앤매너 유지.`;

    const promptText = `
[셀러 정보]
- 이름(채널명): ${seller.name}
- 카테고리: ${seller.category || "정보 없음"}
- 프로필 소개글: ${seller.profileBio || "정보 없음"}

[딜(상품) 정보]
- 상품명: ${deal.dealName}
- 브랜드명: ${deal.brandName || "정보 없음"}
- 판매가: ${deal.sellingPrice || "미정"}
- 제안 마진/조건: ${deal.baseMarginPolicy || "협의"}
- 추가 소싱 메모/특장점: ${deal.sourcingMemo || "정보 없음"}

위 정보를 바탕으로 셀러에게 보낼 제안 메시지 초안을 작성해주세요.
`;

    const response = await withGeminiKeyRotation((apiKey) =>
      clientFor(apiKey).models.generateContent({
        model: GEMINI_PRIMARY_MODEL,
        contents: [
          {
            role: "user",
            parts: [{ text: promptText }],
          },
        ],
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.7,
          // 설득 문구 작성은 약간의 추론이 품질을 좌우 — think:low(재배치).
          thinkingConfig: { thinkingLevel: GEMINI_THINK_LOW },
        },
      })
    );

    const outputText = response.text || "";

    return NextResponse.json({ message: outputText });
  } catch (error) {
    console.error("[generate-message] Error:", error);
    return NextResponse.json({ error: "메시지 생성 중 오류가 발생했습니다." }, { status: 500 });
  }
}
