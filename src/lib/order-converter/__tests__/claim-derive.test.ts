import { describe, it, expect } from 'vitest';
import {
  deriveClaimsFromOrder,
  deriveClaims,
  claimTransitionKey,
  isCollectedStatus,
  isFinalCompletedStatus,
  buildTrackingUrl,
  type DerivedClaim,
} from '../claim-derive';

function makeOrder(overrides: any = {}) {
  return {
    productOrderId: 'P-1001',
    productName: '와이그라운드 테스트 상품',
    productOption: '단품',
    quantity: 2,
    __claim: {
      cancel: null,
      return: null,
      exchange: null,
      beforeClaim: null,
      currentClaim: null,
      completedClaims: null,
    },
    ...overrides,
  };
}

describe('deriveClaimsFromOrder', () => {
  it('진행중인 반품(RETURN) 클레임을 파생한다 — 수거택배사/송장 후보 경로 탐색', () => {
    const order = makeOrder({
      __claim: {
        cancel: null,
        return: {
          claimStatus: 'RETURNING',
          collectDeliveryCompany: 'CJGLS',
          collectDeliveryInvoiceNo: '111111111',
          claimRequestDate: '2026-07-01T00:00:00.000Z',
        },
        exchange: null,
        beforeClaim: null,
        currentClaim: { claimType: 'RETURN', claimStatus: 'RETURNING' },
        completedClaims: null,
      },
    });

    const claims = deriveClaimsFromOrder(order);
    expect(claims).toHaveLength(1);
    const c = claims[0];
    expect(c.productOrderId).toBe('P-1001');
    expect(c.claimType).toBe('RETURN');
    expect(c.claimStatus).toBe('RETURNING');
    expect(c.claimStatusLabel).toBe('반품 수거중');
    expect(c.collectDeliveryCompanyCode).toBe('CJGLS');
    expect(c.collectDeliveryInvoiceNo).toBe('111111111');
    expect(c.requestDate).toBe('2026-07-01T00:00:00.000Z');
    expect(c.isCompleted).toBe(false);
    expect(c.raw).toEqual(order.__claim.return);
  });

  it('교환(EXCHANGE) 클레임을 파생한다', () => {
    const order = makeOrder({
      __claim: {
        cancel: null,
        return: null,
        exchange: {
          claimStatus: 'EXCHANGE_REQUEST',
          returnDeliveryCompany: 'HANJIN',
          returnDeliveryInvoiceNo: '222222222',
        },
        beforeClaim: null,
        currentClaim: { claimType: 'EXCHANGE' },
        completedClaims: null,
      },
    });

    const claims = deriveClaimsFromOrder(order);
    expect(claims).toHaveLength(1);
    expect(claims[0].claimType).toBe('EXCHANGE');
    expect(claims[0].claimStatus).toBe('EXCHANGE_REQUEST');
    expect(claims[0].claimStatusLabel).toBe('교환 요청');
    expect(claims[0].collectDeliveryCompanyCode).toBe('HANJIN');
    expect(claims[0].collectDeliveryInvoiceNo).toBe('222222222');
  });

  it('완료된 클레임(completedClaims)은 isCompleted=true로 파생된다', () => {
    const order = makeOrder({
      __claim: {
        cancel: null,
        return: null,
        exchange: null,
        beforeClaim: null,
        currentClaim: null,
        completedClaims: [
          {
            claimType: 'RETURN',
            claimStatus: 'RETURN_DONE',
            collectDeliveryCompany: 'KGB',
            collectDeliveryInvoiceNo: '333333333',
          },
        ],
      },
    });

    const claims = deriveClaimsFromOrder(order);
    expect(claims).toHaveLength(1);
    expect(claims[0].claimType).toBe('RETURN');
    expect(claims[0].claimStatus).toBe('RETURN_DONE');
    expect(claims[0].claimStatusLabel).toBe('반품 완료');
    expect(claims[0].isCompleted).toBe(true);
  });

  it('같은 클레임이 터미널 키(cancel)와 completedClaims에 중복 존재하면 1행으로만 파생한다(이중카운트 방지)', () => {
    // 네이버 실응답: 완료된 취소가 __claim.cancel(터미널)과 completedClaims[] 양쪽에 동시에 실려
    // 같은 취소가 2행으로 파생되던 버그(실측 65/66 주문). 같은 claimType이면 1행으로 접는다.
    const order = makeOrder({
      __claim: {
        cancel: { claimStatus: 'CANCEL_DONE' },
        return: null,
        exchange: null,
        beforeClaim: null,
        currentClaim: { claimType: 'CANCEL', claimStatus: 'CANCEL_DONE' },
        completedClaims: [{ claimType: 'CANCEL', claimStatus: 'CANCEL_DONE' }],
      },
    });
    const claims = deriveClaimsFromOrder(order);
    expect(claims).toHaveLength(1);
    expect(claims[0].claimType).toBe('CANCEL');
    expect(claims[0].claimStatus).toBe('CANCEL_DONE');
  });

  it('한 주문에 서로 다른 claimType(취소+반품)이면 각각 파생한다(dedup은 동일 타입에만 적용)', () => {
    const order = makeOrder({
      __claim: {
        cancel: { claimStatus: 'CANCEL_DONE' },
        return: { claimStatus: 'RETURNING' },
        exchange: null,
        beforeClaim: null,
        currentClaim: null,
        completedClaims: null,
      },
    });
    const claims = deriveClaimsFromOrder(order);
    const types = claims.map((c) => c.claimType).sort();
    expect(types).toEqual(['CANCEL', 'RETURN']);
  });

  it('빈 클레임(__claim의 모든 키가 null)이면 빈 배열을 반환한다', () => {
    const order = makeOrder();
    expect(deriveClaimsFromOrder(order)).toEqual([]);
  });

  it('이상 형태(__claim이 없거나, productOrderId가 없거나, 배열이 아닌 completedClaims)여도 throw하지 않고 방어적으로 처리한다', () => {
    // __claim 자체가 없음
    expect(deriveClaimsFromOrder({ productOrderId: 'P-1' })).toEqual([]);
    // productOrderId가 없음
    expect(deriveClaimsFromOrder({ __claim: { return: { claimStatus: 'RETURNING' } } })).toEqual([]);
    // __claim이 문자열 등 이상 타입
    expect(deriveClaimsFromOrder({ productOrderId: 'P-2', __claim: 'not-an-object' })).toEqual([]);
    // completedClaims가 배열이 아님(이상 응답 형태 대비)
    expect(
      deriveClaimsFromOrder({
        productOrderId: 'P-3',
        __claim: { return: null, exchange: null, cancel: null, currentClaim: null, completedClaims: { claimType: 'RETURN' } },
      }),
    ).toEqual([]);
    // 완전히 null
    expect(deriveClaimsFromOrder(null)).toEqual([]);
    expect(deriveClaimsFromOrder(undefined)).toEqual([]);
  });
});

describe('claimTransitionKey', () => {
  it('productOrderId:claimType:claimStatus 조합 키를 만든다', () => {
    const claim: DerivedClaim = {
      productOrderId: 'P-1001',
      claimType: 'RETURN',
      claimStatus: 'RETURNING',
      claimStatusLabel: '반품 수거중',
      collectDeliveryCompanyCode: 'CJGLS',
      collectDeliveryInvoiceNo: '111',
      productName: null,
      productOption: null,
      productId: null,
      quantity: null,
      requestDate: null,
      isCompleted: false,
      raw: {},
    };
    expect(claimTransitionKey(claim)).toBe('P-1001:RETURN:RETURNING');
  });

  it('claimStatus가 null이면 UNKNOWN으로 대체한다', () => {
    const claim: DerivedClaim = {
      productOrderId: 'P-2',
      claimType: 'EXCHANGE',
      claimStatus: null,
      claimStatusLabel: '상태 미확인',
      collectDeliveryCompanyCode: null,
      collectDeliveryInvoiceNo: null,
      productName: null,
      productOption: null,
      productId: null,
      quantity: null,
      requestDate: null,
      isCompleted: false,
      raw: {},
    };
    expect(claimTransitionKey(claim)).toBe('P-2:EXCHANGE:UNKNOWN');
  });
});

describe('isCollectedStatus / isFinalCompletedStatus', () => {
  it('COLLECT_DONE류 상태를 수거완료로 판정한다', () => {
    expect(isCollectedStatus('COLLECT_DONE')).toBe(true);
    expect(isCollectedStatus('RETURNING')).toBe(false);
    expect(isCollectedStatus(null)).toBe(false);
  });

  it('DONE/COMPLETE류 상태를 종단완료로 판정한다', () => {
    expect(isFinalCompletedStatus('RETURN_DONE')).toBe(true);
    expect(isFinalCompletedStatus('EXCHANGE_DONE')).toBe(true);
    expect(isFinalCompletedStatus('RETURNING')).toBe(false);
    expect(isFinalCompletedStatus(null)).toBe(false);
  });
});

describe('deriveClaims (전체 orders 배열 + 캠페인 매칭)', () => {
  it('여러 주문에서 클레임을 모으고, campaignNames가 주어지면 유사도로 매칭한다', () => {
    const orders = [
      makeOrder({
        productOrderId: 'P-1',
        productName: '와이그라운드 콜라겐 3박스',
        __claim: {
          cancel: null,
          return: { claimStatus: 'RETURNING', collectDeliveryCompany: 'CJGLS' },
          exchange: null,
          beforeClaim: null,
          currentClaim: null,
          completedClaims: null,
        },
      }),
      makeOrder({ productOrderId: 'P-2' }), // 클레임 없음 — 결과에서 제외돼야 함
    ];

    const claims = deriveClaims(orders, ['콜라겐 3박스 세트', '전혀다른캠페인']);
    expect(claims).toHaveLength(1);
    expect(claims[0].productOrderId).toBe('P-1');
    expect(claims[0].matchedCampaignName).toBe('콜라겐 3박스 세트');
  });

  it('orders가 배열이 아니면 빈 배열을 반환한다', () => {
    expect(deriveClaims(null as any)).toEqual([]);
    expect(deriveClaims(undefined as any)).toEqual([]);
  });

  it('campaignNames를 생략하면 매칭 없이 파생만 한다', () => {
    const orders = [
      makeOrder({
        __claim: {
          cancel: { claimStatus: 'CANCEL_DONE' },
          return: null,
          exchange: null,
          beforeClaim: null,
          currentClaim: null,
          completedClaims: null,
        },
      }),
    ];
    const claims = deriveClaims(orders);
    expect(claims).toHaveLength(1);
    expect(claims[0].matchedCampaignName).toBeUndefined();
  });

  it('CampaignMatchInfo[]가 주어지면 상품명 fuzzy가 아니라 productId로 귀속한다', () => {
    // 두 캠페인이 이름은 유사(둘 다 "콜라겐")하지만 productId가 다르다.
    // 상품명 fuzzy였다면 한 캠페인이 양쪽 취소를 다 흡수했을 것 → productId로 정확히 갈라야 한다.
    const orders = [
      makeOrder({
        productOrderId: 'P-A',
        productName: '뉴트리원 콜라겐 3박스',
        productId: '111',
        __claim: { cancel: { claimStatus: 'CANCEL_DONE' }, return: null, exchange: null, beforeClaim: null, currentClaim: null, completedClaims: null },
      }),
      makeOrder({
        productOrderId: 'P-B',
        productName: '트리프 콜라겐 3박스',
        productId: '222',
        __claim: { cancel: { claimStatus: 'CANCEL_DONE' }, return: null, exchange: null, beforeClaim: null, currentClaim: null, completedClaims: null },
      }),
    ];
    const claims = deriveClaims(orders, [
      { name: '콜라겐 딜 - 셀러가 (뉴트리원)', productId: '111' },
      { name: '콜라겐 딜 - 셀러나 (트리프)', productId: '222' },
    ]);
    const byId = Object.fromEntries(claims.map((c) => [c.productOrderId, c.matchedCampaignName]));
    expect(byId['P-A']).toBe('콜라겐 딜 - 셀러가 (뉴트리원)');
    expect(byId['P-B']).toBe('콜라겐 딜 - 셀러나 (트리프)');
  });

  it('동일 productId의 회차(기간분리) 캠페인은 주문 결제일로 갈라 귀속한다', () => {
    const orders = [
      makeOrder({
        productOrderId: 'P-1CHA',
        productId: '900',
        paymentDate: '2026-01-10T00:00:00Z',
        __claim: { cancel: { claimStatus: 'CANCEL_DONE' }, return: null, exchange: null, beforeClaim: null, currentClaim: null, completedClaims: null },
      }),
      makeOrder({
        productOrderId: 'P-2CHA',
        productId: '900',
        paymentDate: '2026-03-10T00:00:00Z',
        __claim: { cancel: { claimStatus: 'CANCEL_DONE' }, return: null, exchange: null, beforeClaim: null, currentClaim: null, completedClaims: null },
      }),
    ];
    const claims = deriveClaims(orders, [
      { name: '겨울딜 - 셀러 1차', productId: '900', startDate: '2026-01-01T00:00:00Z', endDate: '2026-01-31T23:59:59Z' },
      { name: '겨울딜 - 셀러 2차', productId: '900', startDate: '2026-03-01T00:00:00Z', endDate: '2026-03-31T23:59:59Z' },
    ]);
    const byId = Object.fromEntries(claims.map((c) => [c.productOrderId, c.matchedCampaignName]));
    expect(byId['P-1CHA']).toBe('겨울딜 - 셀러 1차');
    expect(byId['P-2CHA']).toBe('겨울딜 - 셀러 2차');
  });

  it('캠페인 productId가 주문의 원상품번호(originalProductId)와 일치하면 귀속한다(채널상품번호 불일치 무관)', () => {
    // 네이버: 캠페인은 원상품번호로 저장되고 주문 1차 필드 productId는 채널상품번호라 서로 다르다.
    // 주문의 productId(채널)·originalProductId(원상품) 둘 다 후보키로 비교해야 매칭된다.
    const orders = [
      makeOrder({
        productOrderId: 'P-ORIG',
        productName: '[김본명 X 보바] 보조 배터리 마켓',
        productId: '13643025431', // 채널상품번호 — 캠페인과 다름
        originalProductId: '13583224998', // 원상품번호 — 캠페인 productId와 일치
        __claim: { cancel: { claimStatus: 'CANCEL_DONE' }, return: null, exchange: null, beforeClaim: null, currentClaim: null, completedClaims: null },
      }),
    ];
    const claims = deriveClaims(orders, [{ name: '[김본명 X 보바] 보조 배터리 마켓', productId: '13583224998' }]);
    expect(claims).toHaveLength(1);
    expect(claims[0].matchedCampaignName).toBe('[김본명 X 보바] 보조 배터리 마켓');
  });

  it('productId가 어느 캠페인과도 안 맞으면(무관 상품) 귀속하지 않는다', () => {
    const orders = [
      makeOrder({
        productOrderId: 'P-X',
        productName: '전혀다른 상품',
        productId: '999',
        __claim: { cancel: { claimStatus: 'CANCEL_DONE' }, return: null, exchange: null, beforeClaim: null, currentClaim: null, completedClaims: null },
      }),
    ];
    const claims = deriveClaims(orders, [
      { name: '콜라겐 딜 - 셀러가', productId: '111' },
      { name: '콜라겐 딜 - 셀러나', productId: '222' },
    ]);
    expect(claims).toHaveLength(1);
    expect(claims[0].matchedCampaignName).toBeNull();
  });
});

describe('buildTrackingUrl', () => {
  it('택배사별 URL 템플릿에 송장번호를 치환한다', () => {
    expect(buildTrackingUrl('CJGLS', '123456789')).toBe(
      'https://trace.cjlogistics.com/next/tracking.html?wblNo=123456789',
    );
    expect(buildTrackingUrl('HANJIN', '987654321')).toBe(
      'https://www.hanjin.com/kor/CMS/DeliveryMgr/WaybillResult.do?mCode=MN038&schLang=KR&wblnumText2=987654321',
    );
    expect(buildTrackingUrl('HYUNDAI', '111')).toBe(
      'https://www.lotteglogis.com/home/reservation/tracking/linkView?InvNo=111',
    );
    expect(buildTrackingUrl('KGB', '222')).toBe('https://www.ilogen.com/web/personal/trace/222');
    expect(buildTrackingUrl('EPOST', '333')).toBe(
      'https://service.epost.go.kr/trace.RetrieveDomRigiTraceList.comm?sid1=333',
    );
    expect(buildTrackingUrl('KDEXP', '444')).toBe(
      'https://kdexp.com/service/delivery/etc/delivery.do?barcode=444',
    );
  });

  it('미매핑 택배사 코드는 null을 반환한다', () => {
    expect(buildTrackingUrl('UNKNOWN_CODE', '123')).toBeNull();
  });

  it('송장번호나 코드가 없으면 null을 반환한다', () => {
    expect(buildTrackingUrl(null, '123')).toBeNull();
    expect(buildTrackingUrl('CJGLS', null)).toBeNull();
    expect(buildTrackingUrl(undefined, undefined)).toBeNull();
  });

  it('송장번호를 URL-safe하게 인코딩한다', () => {
    expect(buildTrackingUrl('CJGLS', 'ABC 123')).toBe(
      'https://trace.cjlogistics.com/next/tracking.html?wblNo=ABC%20123',
    );
  });
});

// ============================================================================
// claimSource write-path 프로젝션 (egress 절감, 2026-07-21 · P7)
// 핵심 계약: 블롭 전량 파생 vs 저장 프로젝션 파생이 동일 입력에서 동일 결과여야 한다.
// ============================================================================

import {
  extractClaimSourceOrders,
  computeSnapshotClaimSource,
  parseSnapshotClaimSource,
  SNAPSHOT_CLAIM_SOURCE_VERSION,
  SNAPSHOT_CLAIM_SOURCE_UNAVAILABLE,
  type CampaignMatchInfo,
} from '../claim-derive';

/** 실스냅샷 형태를 흉내낸 혼합 픽스처 — 클레임 3종 + 무클레임 + 이상 형태를 섞는다. */
function mixedSnapshotOrders(): any[] {
  return [
    // A: 진행중 반품 — 상품명 폴백 매칭 대상
    {
      productOrderId: 'P-A',
      productName: '콜라겐 공구',
      productOption: '단품',
      quantity: 1,
      orderDate: '2026-07-10T10:00:00+09:00',
      __claim: {
        return: { claimStatus: 'RETURNING', collectDeliveryCompany: 'CJGLS', collectDeliveryInvoiceNo: '111' },
        currentClaim: { claimType: 'RETURN', claimStatus: 'RETURNING' },
      },
    },
    // B: 취소 완료 — 터미널 키와 completedClaims 양쪽에 실린 이중카운트 케이스
    {
      productOrderId: 'P-B',
      productName: '유산균',
      quantity: 2,
      __claim: {
        cancel: { claimStatus: 'CANCEL_DONE' },
        completedClaims: [{ claimType: 'CANCEL', claimStatus: 'CANCEL_DONE' }],
      },
    },
    // C: 클레임 없음 — 프로젝션에서 탈락해야 한다
    { productOrderId: 'P-C', productName: '비타민', quantity: 1, __claim: { cancel: null, return: null } },
    // D: __claim 자체가 없음
    { productOrderId: 'P-D', productName: '오메가3', quantity: 3 },
    // E: 교환 — productId/originalProductId 기반 캠페인 귀속 대상
    {
      productOrderId: 'P-E',
      productName: '슬림핏 레깅스',
      productId: '13643025431',
      originalProductId: '13583224998',
      quantity: 1,
      paymentDate: '2026-07-08T12:00:00+09:00',
      __claim: { exchange: { claimStatus: 'EXCHANGE_REQUEST', claimRequestDate: '2026-07-09T00:00:00.000Z' } },
    },
    // F: productOrderId 없음 + 클레임 있음 — 파생 자체가 빈 배열이므로 프로젝션도 탈락(동치)
    { productName: '이상 주문', __claim: { cancel: { claimStatus: 'CANCEL_REQUEST' } } },
  ];
}

function matchCampaigns(): CampaignMatchInfo[] {
  return [
    {
      name: '레깅스 7월 공구',
      productId: '13583224998',
      startDate: '2026-07-01T00:00:00+09:00',
      endDate: '2026-07-31T23:59:59+09:00',
    },
    { name: '콜라겐 공구' },
  ];
}

describe('extractClaimSourceOrders / computeSnapshotClaimSource', () => {
  it('클레임 보유 주문만 최소 프로젝션으로 남긴다', () => {
    const projected = extractClaimSourceOrders(mixedSnapshotOrders());
    expect(projected.map((o) => o.productOrderId)).toEqual(['P-A', 'P-B', 'P-E']);
    // 프로젝션은 __claim 원본을 그대로 보존한다(?debug=1 raw 노출 계약).
    expect((projected[0].__claim as any).return.collectDeliveryCompany).toBe('CJGLS');
  });

  it('배열이 아닌 입력은 빈 프로젝션으로 강등한다', () => {
    expect(extractClaimSourceOrders(null as any)).toEqual([]);
    expect(extractClaimSourceOrders({} as any)).toEqual([]);
  });

  it('저장값은 버전 봉투(v1)를 갖는다', () => {
    const stored = computeSnapshotClaimSource(mixedSnapshotOrders());
    expect(stored.v).toBe(SNAPSHOT_CLAIM_SOURCE_VERSION);
    expect(stored.orders).toHaveLength(3);
  });
});

describe('블롭 파생 vs 저장 프로젝션 파생 동치성 (회귀 고정)', () => {
  it('deriveClaims 결과가 캠페인 매칭 포함 완전히 일치한다', () => {
    const orders = mixedSnapshotOrders();
    const campaigns = matchCampaigns();

    const fromBlob = deriveClaims(orders, campaigns);
    const fromProjection = deriveClaims(extractClaimSourceOrders(orders), campaigns);

    expect(fromProjection).toEqual(fromBlob);
    // 검증이 공허하지 않다는 가드: 실제로 클레임이 파생되고 매칭도 걸렸다.
    expect(fromBlob.length).toBeGreaterThanOrEqual(3);
    expect(fromBlob.find((c) => c.productOrderId === 'P-E')?.matchedCampaignName).toBe('레깅스 7월 공구');
    expect(fromBlob.find((c) => c.productOrderId === 'P-A')?.matchedCampaignName).toBe('콜라겐 공구');
    // B의 이중카운트 dedup도 두 경로에서 동일하게 1건이다.
    expect(fromBlob.filter((c) => c.productOrderId === 'P-B')).toHaveLength(1);
  });

  it('저장→파싱 왕복(SQLite 문자열 직렬화 포함) 후에도 동치성이 유지된다', () => {
    const orders = mixedSnapshotOrders();
    const campaigns = matchCampaigns();
    const stored = computeSnapshotClaimSource(orders);

    const viaObject = parseSnapshotClaimSource(stored);
    const viaString = parseSnapshotClaimSource(JSON.stringify(stored));

    expect(viaObject).not.toBeNull();
    expect(viaString).not.toBeNull();
    expect(deriveClaims(viaObject!, campaigns)).toEqual(deriveClaims(orders, campaigns));
    expect(deriveClaims(viaString!, campaigns)).toEqual(deriveClaims(orders, campaigns));
  });
});

describe('parseSnapshotClaimSource 폴백 강등', () => {
  it('null(레거시 행)·UNAVAILABLE 마커·버전 불일치·형태 불량은 전부 null', () => {
    expect(parseSnapshotClaimSource(null)).toBeNull();
    expect(parseSnapshotClaimSource(undefined)).toBeNull();
    expect(parseSnapshotClaimSource(SNAPSHOT_CLAIM_SOURCE_UNAVAILABLE)).toBeNull();
    expect(parseSnapshotClaimSource({ v: 0 })).toBeNull();
    expect(parseSnapshotClaimSource({ v: 999, orders: [] })).toBeNull();
    expect(parseSnapshotClaimSource({ v: SNAPSHOT_CLAIM_SOURCE_VERSION })).toBeNull(); // orders 누락
    expect(parseSnapshotClaimSource('not-json{')).toBeNull();
    expect(parseSnapshotClaimSource(42)).toBeNull();
  });

  it('클레임 0건인 날의 정상 저장값은 null이 아니라 빈 배열(블롭 폴백 불필요)', () => {
    const stored = computeSnapshotClaimSource([{ productOrderId: 'P-1', productName: 'x' }]);
    expect(parseSnapshotClaimSource(stored)).toEqual([]);
  });
});
