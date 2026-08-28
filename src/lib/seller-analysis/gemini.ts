import { GoogleGenAI } from '@google/genai';
import { LosslessSellerData } from './types';
import { SellerMetrics, isValidComment } from './metrics';
import { GEMINI_PRIMARY_MODEL, GEMINI_THINK_LOW_INTERACTION } from '@/lib/gemini-model';
import { withGeminiKeyRotation } from '@/lib/agent/gemini-client';

// ⚠️ 모듈 최상위에 `new GoogleGenAI({apiKey})` 를 상수로 두면 키가 하나로 박혀
// 그 계정이 월 상한에 걸리는 순간 이 기능이 통째로 멈춘다(2026-07-30 실측).
// 호출마다 로테이션된 키로 클라이언트를 만든다 — SDK 인스턴스는 얇은 래퍼라
// 요청당 생성 비용이 무시할 만하다.
const clientFor = (apiKey: string) => new GoogleGenAI({ apiKey });

// JSON Schema for Structured Output
const analysisSchema = {
  type: "OBJECT",
  properties: {
    category: { type: "STRING", enum: ["뷰티", "패션", "리빙", "식품", "육아", "다이어트", "건강", "스포츠", "일상", "교육"], description: "The single most fitting commerce category — choose exactly one from the 10-item taxonomy" },
    tags: { type: "ARRAY", items: { type: "STRING" }, description: "5 highly relevant search tags" },
    seller_analysis: {
      type: "OBJECT",
      properties: {
        estimated_age: { type: "STRING", description: "Estimated age group of the seller" },
        content_style: { type: "STRING", description: "Visual and text content style description" },
        engagement_level: { type: "STRING", enum: ["Low", "Medium", "High", "Viral"] },
        engagement_reason: { type: "STRING", description: "Reason for the engagement level" },
        commerce_suitability_score: { type: "INTEGER", description: "Score from 0 to 100 indicating suitability for group buying/commerce" },
        commerce_suitability_reason: { type: "STRING", description: "Reasoning for the commerce suitability score. Distinguish if it's an ad-oriented account, personal diary, or effective commerce seller." }
      }
    },
    audience_analysis: {
      type: "OBJECT",
      properties: {
        primary_gender: { type: "STRING", enum: ["Male", "Female", "Mixed"] },
        age_range: { type: "STRING", description: "Estimated age range of audience (e.g. 25-34)" },
        keywords: { type: "ARRAY", items: { type: "STRING" }, description: "3 keywords representing the audience" }
      }
    },
    sub_categories: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "주 카테고리 외 계정의 보조 성격 (예: 여행, 일상, 육아). 없으면 빈 배열"
    },
    comment_analysis: {
      type: "OBJECT",
      description: "댓글 원문이 제공된 경우에만 채움. 댓글이 없으면 생략",
      properties: {
        intent_distribution: {
          type: "OBJECT",
          description: "댓글 의도 분포 — 합이 100이 되는 정수 백분율",
          properties: {
            inquiry: { type: "INTEGER", description: "가격·일정·옵션 등 문의" },
            purchase: { type: "INTEGER", description: "구매 의사·구매 인증" },
            social: { type: "INTEGER", description: "친목·응원·일상 반응" },
            bot_or_irrelevant: { type: "INTEGER", description: "봇성·외국어 일반 칭찬·게시물과 무관" }
          }
        },
        top_keywords: { type: "ARRAY", items: { type: "STRING" }, description: "댓글에서 추출한 대표 키워드 최대 5개" },
        representative_reactions: { type: "ARRAY", items: { type: "STRING" }, description: "대표 반응 취지 요약 최대 3개 — 작성자 정보 없이 반응 내용만" }
      }
    }
  },
  required: ["category", "tags", "seller_analysis", "audience_analysis"]
};

export async function analyzeSellerData(data: LosslessSellerData, metrics: SellerMetrics) {
  // 1. 시스템 프롬프트 — 정량은 코드가 계산 완료, LLM은 해석·정성 판단 전담
  const systemInstruction = `당신은 이커머스 및 인플루언서 마케팅 전문 데이터 분석가입니다.
정량 지표(ER, 게시 주기, 광고 비중, 공구 감지, 댓글 집계 등)는 이미 코드로 계산되어 computed_metrics 필드로 제공됩니다.
숫자를 새로 추정하거나 재계산하지 마십시오. 당신의 담당은 해석과 정성 판단입니다:
1. 페르소나·톤앤매너·콘텐츠 스타일 분석 (content_style): 시각적 무드와 말투를 근거로.
2. 카테고리 판단 (category, sub_categories, tags): 주 카테고리 하나와 보조 성격을 구분.
3. 댓글 텍스트의 의도 분류 (comment_analysis): 제공된 댓글 원문을 근거로 문의/구매/친목/봇·무관 분포(합 100 정수)를 추정하고 대표 키워드를 추출. 댓글이 제공되지 않았으면 comment_analysis를 생략하고 다른 판단에서도 댓글 근거를 지어내지 마십시오.
4. 인게이지먼트 해석 (engagement_level, engagement_reason): computed_metrics의 er·consistency·commentQuality를 근거로 레벨을 판정하고, 어떤 지표 때문인지 명시.
5. 공구 셀러 적합성 (commerce_suitability_score, commerce_suitability_reason): 광고성 계정인지, 개인 일기형인지, 실제 구매 전환을 이끌 수 있는 공구 셀러인지 — computed_metrics의 gongu·ads 지표와 댓글 의도를 근거로 0~100 점수와 이유를 제시.
모든 판단에는 어떤 입력(지표 또는 원문)을 근거로 했는지 이유 필드에 드러나야 합니다.`;

  // 2. 입력 데이터 구성 — 계산된 지표 + 원문(캡션·유효 댓글 상위 15개)
  const payloadText = JSON.stringify({
    profile: data.profile,
    computed_metrics: metrics,
    raw_posts: data.raw_posts.slice(0, 30).map(post => ({
      caption: (post.caption || "").slice(0, 500),
      likes: post.likes,
      commentsCount: post.comments_count,
      media_type: post.media_type,
      is_sponsored: post.is_sponsored,
      comments: (post.sample_comments || []).filter(isValidComment).slice(0, 15)
    }))
  }, null, 2);

  const inputParts: any[] = [{ type: 'text', text: payloadText }];

  // 이미지 URL 3~5개를 병렬로 Fetch하여 Base64로 변환 후 첨부
  const imageUrls = data.images.slice(0, 5);
  for (const url of imageUrls) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (!response.ok) {
        console.warn(`[Gemini] Image fetch failed: ${response.status} for ${url}`);
        continue;
      }

      const contentType = response.headers.get('content-type') || 'image/jpeg';
      const arrayBuffer = await response.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString('base64');

      if (base64 && base64.length > 100) {
        inputParts.push({ 
          type: 'image', 
          data: base64, 
          mime_type: contentType 
        });
      }
    } catch (err: any) {
      console.warn(`[Gemini] Failed to fetch image for Gemini (${url}):`, err.message || err);
      // 에러를 무시하고 텍스트만으로 분석을 진행합니다.
    }
  }

  // 3. Interactions API (Beta) 호출
  // store=true (기본값)이 적용되어 세션 기록이 서버에 남습니다.
  // 주의: 댓글 원문 비영속 원칙 — 프롬프트 페이로드를 파일/로그로 남기지 말 것 (블루프린트 §3 A-2)
  console.log(`[Gemini] Starting analysis using interactions.create...`);

  const response = await withGeminiKeyRotation((apiKey) =>
    clientFor(apiKey).interactions.create({
      model: GEMINI_PRIMARY_MODEL,
      input: [
        {
          type: "user_input",
          content: inputParts
        }
      ],
      system_instruction: systemInstruction,
      response_format: analysisSchema as any,
      // interactions API는 snake_case — generation_config.thinking_level. 정성 판단이라 low(재배치).
      generation_config: { thinking_level: GEMINI_THINK_LOW_INTERACTION }
    })
  );

  // 4. 결과 추출 및 반환
  // SDK 버전에 맞추어 output_text 프로퍼티 사용
  const outputText = response.output_text || "";
  
  if (!outputText) {
    throw new Error("Gemini 응답이 비어있거나, 멀티턴 구조 파싱에 실패했습니다.");
  }

  const resultData = JSON.parse(outputText);

  // 멀티턴 대화에 사용할 interaction id 반환
  return {
    analysis: resultData,
    interaction_id: response.id // 이 ID를 DB에 저장하여 추후 대화(Ask AI) 시 previous_interaction_id로 활용
  };
}

export async function chatWithSellerData(previousInteractionId: string, userMessage: string) {
  // 이미 서버에 데이터가 캐싱(저장)되어 있으므로, 텍스트 질문만 넘겨도 됩니다.
  const response = await withGeminiKeyRotation((apiKey) =>
    clientFor(apiKey).interactions.create({
      model: GEMINI_PRIMARY_MODEL,
      input: userMessage,
      previous_interaction_id: previousInteractionId,
      generation_config: { thinking_level: GEMINI_THINK_LOW_INTERACTION }
    })
  );

  return {
    reply: response.output_text || "",
    interaction_id: response.id // 업데이트된 interaction id
  };
}
