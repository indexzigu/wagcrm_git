// 셀러 실판매 성과 요약 계약 — T3 분석 리포트의 "실측 성과" 카드 근거(2026-08-08, 오너 승인 1층 ②).
//
// 핵심 계약 2줄:
// - 캠페인 개수는 그룹을 1건으로 접는다(CG-1) — 접기는 countEffectiveCampaigns SSOT 위임.
//   그룹은 실캠페인 1개를 딜별 N행으로 분할한 것이라, 행 단위로 세면 "공구당 평균 매출"이
//   그룹 셀러에서만 조직적으로 낮아진다(분모 부풀림).
// - 매출 합은 접기와 무관하다(행 합 = 실캠페인 합). 평균의 분모는 "실매출이 잡힌 유효
//   캠페인"이다 — 매출 미입력 캠페인을 분모에 넣으면 평균이 미입력률에 따라 출렁인다
//   (미입력을 0으로 계산하는 그 결함의 평균 버전).

import { describe, it, expect } from 'vitest';
import { summarizeSellerSalesPerformance } from '../seller-sales-performance';

const row = (actualSales: number | null, groupId: string | null = null) => ({ actualSales, groupId });

describe('summarizeSellerSalesPerformance', () => {
  it('미그룹 행: 유효 수 = 행 수, 평균 = 총매출 ÷ 매출 보유 캠페인', () => {
    const s = summarizeSellerSalesPerformance([row(1000), row(3000), row(null)]);
    expect(s.effectiveCount).toBe(3);
    expect(s.effectiveWithSales).toBe(2);
    expect(s.totalSales).toBe(4000);
    expect(s.avgSalesPerCampaign).toBe(2000);
  });

  it('그룹은 1건으로 접고 매출은 멤버 합산이다', () => {
    // 그룹 g1 = 실캠페인 1개(딜별 2행 매출 1000+2000), 단독 1개(3000)
    const s = summarizeSellerSalesPerformance([row(1000, 'g1'), row(2000, 'g1'), row(3000)]);
    expect(s.effectiveCount).toBe(2);
    expect(s.effectiveWithSales).toBe(2);
    expect(s.totalSales).toBe(6000);
    expect(s.avgSalesPerCampaign).toBe(3000);
  });

  it('그룹 멤버 일부만 매출이 있어도 그 그룹은 매출 보유 1건이다', () => {
    const s = summarizeSellerSalesPerformance([row(1000, 'g1'), row(null, 'g1')]);
    expect(s.effectiveCount).toBe(1);
    expect(s.effectiveWithSales).toBe(1);
    expect(s.avgSalesPerCampaign).toBe(1000);
  });

  it('매출 보유 캠페인이 0이면 평균은 null (0 이 아니다)', () => {
    const s = summarizeSellerSalesPerformance([row(null), row(0)]);
    expect(s.effectiveCount).toBe(2);
    expect(s.effectiveWithSales).toBe(0);
    expect(s.totalSales).toBe(0);
    expect(s.avgSalesPerCampaign).toBeNull();
  });

  it('캠페인이 하나도 없으면 전부 0/null', () => {
    const s = summarizeSellerSalesPerformance([]);
    expect(s.effectiveCount).toBe(0);
    expect(s.effectiveWithSales).toBe(0);
    expect(s.totalSales).toBe(0);
    expect(s.avgSalesPerCampaign).toBeNull();
  });

  it('Prisma Decimal 유사 입력(문자열화 가능 객체)도 숫자로 합산한다', () => {
    const decimalLike = { toString: () => '1500' } as unknown as number;
    const s = summarizeSellerSalesPerformance([{ actualSales: decimalLike, groupId: null }]);
    expect(s.totalSales).toBe(1500);
    expect(s.avgSalesPerCampaign).toBe(1500);
  });
});
