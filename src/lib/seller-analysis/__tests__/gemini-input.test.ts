import { beforeEach, describe, expect, it, vi } from 'vitest';

// [셀러분석] 릴스 조회 배수는 Gemini 입력(computed_metrics)에 넣지 않는다 — 프롬프트 지시문이 모르는 지표다.
// 네트워크·키 없음: SDK 와 키 로테이션은 가짜다. 픽스처는 가상 값.

const createCalls: unknown[] = [];

vi.mock('@google/genai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google/genai')>()),
  GoogleGenAI: class {
    interactions = {
      create: vi.fn(async (args: unknown) => {
        createCalls.push(args);
        return { id: 'synthetic-interaction', output_text: '{"category":"리빙","tags":[]}' };
      }),
    };
  },
}));

vi.mock('@/lib/agent/gemini-client', () => ({
  withGeminiKeyRotation: async (fn: (key: string) => Promise<unknown>) => fn('synthetic-key'),
}));

import { analyzeSellerData, metricsForGemini } from '../gemini';
import { computeSellerMetrics } from '../metrics';
import type { LosslessSellerData } from '../types';

const data: LosslessSellerData = {
  seller_id: 'synthetic',
  profile: { follower_count: 1000 },
  raw_posts: [1, 2, 3].map((i) => ({
    caption: `가상 릴스 ${i}`,
    likes: 10,
    comments_count: 1,
    sample_comments: [],
    taken_at: new Date(Date.UTC(2026, 0, i)).toISOString(),
    media_type: 'reel' as const,
    video_view_count: 1000 * i,
    view_source: 'views' as const,
    is_sponsored: false,
  })),
  images: [],
};

describe('Gemini 입력 — reach 제외', () => {
  beforeEach(() => {
    createCalls.length = 0;
  });

  it('metricsForGemini 는 reach 만 빼고 나머지 지표는 그대로 둔다', () => {
    const metrics = computeSellerMetrics(data);
    expect(metrics.reach).not.toBeNull();
    const sent = metricsForGemini(metrics);
    expect(sent).not.toHaveProperty('reach');
    expect(sent.engagement).toEqual(metrics.engagement);
  });

  it('실제로 보내는 페이로드의 computed_metrics 에 reach 가 없다', async () => {
    await analyzeSellerData(data, computeSellerMetrics(data));
    expect(createCalls).toHaveLength(1);
    const call = createCalls[0] as { input: { content: { type: string; text?: string }[] }[] };
    const payload = JSON.parse(call.input[0].content.find((part) => part.type === 'text')!.text!);
    expect(payload.computed_metrics).toBeDefined();
    expect(payload.computed_metrics).not.toHaveProperty('reach');
    expect(payload.computed_metrics).toHaveProperty('engagement');
  });
});
