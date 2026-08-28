import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/order-converter/prisma';
import { apiRequest } from '@/lib/order-converter/naver-commerce-client';
import { autoMapOrderCampaign } from '@/lib/order-converter/mapping-service';
import { computeClosedCampaignCache, fetchClosedCampaignOrders, resolveClosedCampaignPeriod } from '@/lib/order-converter/closed-campaign-cache';
import { orderFulfillmentRepository } from '@/repositories/orderFulfillmentRepository';
import { fetchAndSyncCampaigns } from '../campaigns-handler';
import { naverOrderSnapshotRepository } from '@/repositories/naverOrderSnapshotRepository';
import { enumerateSnapshotDateKeys, runSync } from '@/lib/order-converter/naver-order-sync';
import { sortProductMappingsByProductName } from '@/lib/order-converter/product-mapping-sort';
import { parseSalePeriodBounds, isSameKstDay } from '@/lib/order-converter/sale-window';
import { isCrossSellerSet, CrossSellerRejectedError, CROSS_SELLER_REJECTED_CODE } from '@/lib/cross-seller';

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // catch 블록의 거부 로그가 대상 식별자를 남길 수 있도록 try 밖에서 받는다.
  const { id } = await params;
  try {
    const data = await request.json();

    const isPartialUpdate = Object.keys(data).length === 1 && data.isActive !== undefined;

    // 트랜잭션: 기존 mappings 모두 지우고 새로 생성 (혹은 업데이트)
    const updatedCampaign = await prisma.$transaction(async (tx) => {
      // 판매기간 정본(startDate/endDate) 보존 판정에 기존 값이 필요하다.
      const existing = !isPartialUpdate
        ? await tx.orderCampaign.findUnique({ where: { id }, select: { startDate: true, endDate: true } })
        : null;

      if (!isPartialUpdate) {
        // 기존 매핑 삭제
        await tx.productMapping.deleteMany({
          where: { campaignId: id }
        });
      }

      // 캠페인 기본 정보 업데이트 및 새 매핑 추가
      const updateData: any = {};
      
      if (!isPartialUpdate) {
        if (data.name !== undefined) updateData.name = data.name;
        updateData.template = data.template || null;
        if (data.sellerName !== undefined) updateData.sellerName = data.sellerName;
        updateData.toEmail = data.toEmail || null;
        updateData.ccEmail = data.ccEmail || null;
        updateData.thumbnailUrl = data.thumbnailUrl || null;
        if (data.category !== undefined) updateData.category = data.category;
        if (data.productStatus !== undefined) updateData.productStatus = data.productStatus;
        if (data.salePeriod !== undefined) {
          updateData.salePeriod = data.salePeriod;
          // 판매기간 정본은 startDate/endDate(DateTime)다 — salePeriod 문자열은 파생 표시값(오너 확정 2026-07-15).
          // 과거 여기서 문자열만 쓰고 정본을 놔둬, 운영자가 화면에서 기간을 고쳐도 표시만 바뀌고 집계 컷오프·
          // 주문 조회창은 옛 값(또는 null)을 계속 써서 매출이 조용히 어긋났다(2026-07-15 실사고).
          // 같은 KST 날짜를 가리키면 덮어쓰지 않는다 — 스토어가 준 정밀 시각(시:분)을 날짜 단위 편집이 뭉개지 않게.
          //
          // 알려진 상호작용(신규 아님): 스토어가 SALE/WAIT가 아니고 판매캠페인이 연결된 캠페인은
          // campaigns-handler의 '판매기간 표시 동기화' 블록이 판매캠페인 기간을 정본으로 되돌려쓴다
          // (= 그 캠페인 클래스에선 판매캠페인이 기간의 소스라는 기존 의도). 그래서 여기서 쓴 값이
          // 다음 GET에 덮일 수 있는데, 되돌아가는 값은 이 변경 전에 salePeriod가 되돌아가던 값과 같아
          // 컷오프 결과는 동일하다(수렴). 두 writer가 우선순위를 나눠 갖는 구조 자체는 정리 대상이다.
          const bounds = parseSalePeriodBounds(data.salePeriod);
          if (bounds.startMs !== null && !isSameKstDay(existing?.startDate, bounds.startMs)) {
            updateData.startDate = new Date(bounds.startMs);
          }
          if (bounds.hasOpenEnd) {
            updateData.endDate = null; // '~ 계속' = 종료 미정. 옛 종료값을 남기면 컷오프가 조기 절단된다.
          } else if (bounds.endMs !== null && !isSameKstDay(existing?.endDate, bounds.endMs)) {
            updateData.endDate = new Date(bounds.endMs);
          }
        }

        if (data.mappings && data.mappings.length > 0) {
          updateData.mappings = {
            create: sortProductMappingsByProductName(data.mappings).map((m: any) => ({
              productName: m.productName || '',
              optionName: m.optionName || '',
              brandCode: m.brandCode || '',
              price: Number(m.price) || 0,
              campaignDealId: m.campaignDealId || null
            }))
          };
        }
      }
      
      if (data.isActive !== undefined) {
        updateData.isActive = data.isActive;
      }

      const campaign = await tx.orderCampaign.update({
        where: { id },
        data: updateData,
        include: {
          mappings: true
        }
      });

      if (!isPartialUpdate) {
        // 3. SalesCampaign 연동 동기화 (1:N 매핑)
        const newDealIds = sortProductMappingsByProductName(data.mappings ?? []).map((m: any) => m.campaignDealId).filter(Boolean) || [];
        const matchedSalesCampaigns = newDealIds.length > 0 ? await tx.campaignDeal.findMany({
          where: { id: { in: newDealIds } },
          select: { campaignId: true, campaign: { select: { sellerId: true } } }
        }) : [];
        const newSalesCampaignIds = Array.from(new Set(matchedSalesCampaigns.map(c => c.campaignId)));

        // 셀러 단일성 게이트 — 저장하려는 딜 연결이 **서로 다른 셀러**의 판매캠페인을 가리키면
        // 저장 전체를 거부한다(트랜잭션 롤백). 추천 드롭다운이 sellerScore>0 인 **모든 셀러**의
        // 딜을 나열하므로 운영자 오클릭 한 번이면 이 상태가 만들어지는데, 그대로 저장되면
        // 셀러 화면에 다른 셀러의 매출이 합산돼 나간다(P0 — seller-portal.ts 상단 주석이 정본).
        // ⛔ 부분 저장으로 완화하지 말 것: 매핑만 빼고 저장하면 운영자는 "저장됐다"고 믿는데
        // 실제로는 의도한 연결이 안 붙은 상태가 된다. 판정 SSOT 는 @/lib/cross-seller 이며
        // 자동매핑(전체 거부)·포털(표시 제외)이 같은 규칙을 공유한다.
        if (isCrossSellerSet(matchedSalesCampaigns.map(c => c.campaign?.sellerId))) {
          throw new CrossSellerRejectedError();
        }

        // 기존에 이 주문캠페인에 묶여있었으나 이번 저장으로 제외된 캠페인들의 연결 해제
        await tx.salesCampaign.updateMany({
          where: {
            orderCampaignId: id,
            ...(newSalesCampaignIds.length > 0 && { id: { notIn: newSalesCampaignIds } })
          },
          data: { orderCampaignId: null }
        });

        // 이번 매핑으로 연결된 판매캠페인들에 주문캠페인 ID 연동
        if (newSalesCampaignIds.length > 0) {
          await tx.salesCampaign.updateMany({
            where: { id: { in: newSalesCampaignIds } },
            data: { orderCampaignId: id }
          });
        }
      }

      return campaign;
    });

    // 비동기로 자동 매핑 (부분 업데이트가 아닐 경우) 및 주문 동기화 수행
    if (!isPartialUpdate) {
      autoMapOrderCampaign(id)
        .then(() => fetchAndSyncCampaigns(false))
        .catch(e => console.error("Auto-mapping or sync failed:", e));
    } else if (data.isActive !== undefined) {
      // 상태 변경 등 가벼운 업데이트일 때도 최신 주문 건수 반영을 위해 동기화 백그라운드 호출
      fetchAndSyncCampaigns(false).catch(e => console.error("Sync failed:", e));
    }

    // 마감 취소(isActive === true) 요청인 경우 캐시 초기화
    if (data.isActive === true) {
      (global as any).__naverDailyCache = undefined;
      // B1-2 회귀 방지: L1 nuke만으론 다음 GET이 낡은 DB 스냅샷을 그대로 재하이드레이션한다.
      // ⚠️ 무효화 폭은 **이 캠페인의 판매 창**이다 — 종전 `markAllDirty()`는 날짜를 알면서도
      // 최근 30일 전체를 찍었고, dirty를 지우는 주체(그 날짜의 upsert)가 CHANGED 사이클에선
      // 변경된 날짜에만 오므로 조용한 과거 날짜가 영구 dirty로 남았다(실측 47/48).
      const reopenedStartMs = updatedCampaign.startDate ? new Date(updatedCampaign.startDate).getTime() : NaN;
      const reopenedEndMs = updatedCampaign.endDate ? new Date(updatedCampaign.endDate).getTime() : Date.now();
      const reopenedDateKeys = Number.isFinite(reopenedStartMs)
        ? enumerateSnapshotDateKeys(reopenedStartMs, reopenedEndMs)
        : [];
      if (reopenedDateKeys.length > 0) {
        naverOrderSnapshotRepository.markDirty(reopenedDateKeys).catch(console.warn);
      }
      runSync('CHANGED').catch(console.warn);
    }

    // 마감 스냅샷의 판매기간 컷오프는 sale-window SSOT에 위임 — 라이브 집계와 동일 규칙(KST 종일 포함,
    // 스토어 정밀 종료시각 존중). 과거 여기서 'T23:59:59Z'(UTC)로 파싱해 KST 다음날 오전까지 새어
    // 동결 매출/수량이 라이브와 어긋나던 문제 제거.
    const { start: actualStartDate, end: actualEndDate } = resolveClosedCampaignPeriod(updatedCampaign as any);

    // 마감 처리(isActive === false) 요청인 경우 네이버 API를 통해 최종 통계 스크래핑 및 캐싱.
    // 계산·페치 로직은 closed-campaign-cache(SSOT)로 추출 — 백필 스크립트와 동일 구현을 공유한다.
    if (data.isActive === false && actualStartDate) {
      try {
        const recentOrders = await fetchClosedCampaignOrders(new Date(actualStartDate), apiRequest);

        let poRequestedSet = new Set<string>();
        try {
          poRequestedSet = await orderFulfillmentRepository.getPoRequestedSet(
            recentOrders.map((o: any) => o?.productOrderId).filter(Boolean),
          );
        } catch (err) {
          console.warn('[campaigns/:id] poRequested 집합 로드 실패 — 네이버 상태만으로 판정:', err);
        }

        // 교차 귀속 가드용 peer — 활성/마감 무관 전 캠페인(자기 자신은 compute 내부에서 제외).
        // 마감끼리 충돌할 때 활성 목록만 보면 보호가 0이라 전량을 넘긴다(closed-campaign-cache 주석 참조).
        const peerCampaigns = await prisma.orderCampaign.findMany({ select: { id: true, name: true, startDate: true, endDate: true, salePeriod: true } });

        const cache = computeClosedCampaignCache(
          updatedCampaign as any,
          recentOrders,
          poRequestedSet,
          { start: new Date(actualStartDate), end: actualEndDate ? new Date(actualEndDate) : null },
          peerCampaigns,
        );

        // 스냅샷 보존 가드(admin recalc 라우트와 동일 취지): 판매기간이 오래 지나 네이버 조회창이
        // 만료되면 재계산이 빈 결과(전부 0)로 돌아올 수 있다. 이전에 값이 있던 스냅샷을 0으로 덮어쓰면
        // 마감 기록(매출·인사이트·일별)이 영구 소실되므로, "이전 비영 → 이번 전부 0"이면 기존 캐시를
        // 그대로 보존한다 — 마감취소→재마감 왕복에서 기록이 날아가지 않게 하는 안전장치.
        // (실제 판매 0인 캠페인의 첫 마감은 prevHadData=false라 정상적으로 0을 기록한다.)
        const prevHadData =
          ((updatedCampaign as any).cachedTotalQuantity ?? 0) > 0 ||
          ((updatedCampaign as any).cachedTotalRevenue ?? 0) > 0 ||
          ((updatedCampaign as any).cachedTotalOrders ?? 0) > 0;
        const nextIsEmpty =
          cache.cachedTotalQuantity === 0 && cache.cachedTotalRevenue === 0 && cache.cachedTotalOrders === 0;

        if (prevHadData && nextIsEmpty) {
          console.warn(`[campaigns/:id] 마감 재계산 빈 결과 — 기존 스냅샷 보존(조회창 만료 의심): ${id}`);
        } else {
          await prisma.orderCampaign.update({ where: { id }, data: cache as any });
        }
      } catch (e) {
        console.error('Failed to cache campaign stats on close:', e);
      }
    }

    return NextResponse.json({
      ...updatedCampaign,
      mappings: sortProductMappingsByProductName(updatedCampaign.mappings),
    });
  } catch (error: any) {
    // 셀러 단일성 거부는 서버 오류가 아니라 **입력 거부**다 — 500 으로 내면 운영자에게
    // "시스템이 고장났다"로 읽혀 무엇을 고쳐야 하는지 전달되지 않는다.
    if (error?.code === CROSS_SELLER_REJECTED_CODE) {
      console.warn(`[campaigns:PUT] OrderCampaign(${id}) 저장 거부 — 셀러 단일성 위반`);
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Update API Error:', error);
    return NextResponse.json({ error: error.message || 'Failed to update campaign' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    
    // 캠페인 삭제 (연관된 Task, ProductMapping 등은 Prisma Schema의 onDelete: Cascade 설정으로 자동 삭제됨)
    await prisma.orderCampaign.delete({
      where: { id }
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Delete API Error:', error);
    return NextResponse.json({ error: error.message || 'Failed to delete campaign' }, { status: 500 });
  }
}
