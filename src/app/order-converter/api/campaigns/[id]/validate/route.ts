import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { prisma } from '@/lib/order-converter/prisma';
import { resolveCampaignExpectedOrderIds } from '@/lib/order-converter/campaign-orders';

// 라이브 재조회(캠페인 기간 전체)를 포함하므로 execute 라우트와 동일하게 실행시간 한도를 상향한다.
export const maxDuration = 300;

// 발주서 열 헤더 후보(공백 제거 후 매칭). 첫 매칭 열을 채택한다.
// 이 템플릿류는 수취인/주문인 블록이 각각 주소·수량을 가지므로 "첫 매칭 = 수취인 블록"이 된다.
// 수령자/받는이 등 실제 발주서에서 흔한 동의어를 포함한다(수취인 열 미인식 → "수취인 누락"
// 오탐의 근본 원인이었다). 주문자 블록과 겹칠 수 있는 범용어(이름/성명/고객명)는 넣지 않는다.
const RECIPIENT_HEADERS = [
  '수취인', '수취인명', '수취인성함', '수취인이름',
  '받는분', '받는사람', '받는이', '받으실분',
  '수령인', '수령자', '수령자명',
];
const ADDRESS_HEADERS = ['주소', '배송지', '수취인주소', '통합배송지', '배송주소', '수령지'];
const ITEM_HEADERS = ['품목', '상품명', '옵션정보', '옵션명', '상품'];
const ORDER_NO_HEADERS = ['주문번호', '상품주문번호'];
const SELLER_HEADERS = ['업체명', '업체', '판매자', '셀러'];

const clean = (v: any) => (v === undefined || v === null ? '' : String(v).replace(/\s+/g, ''));
const cellStr = (v: any) => (v === undefined || v === null ? '' : String(v).trim());

function findColumnIndex(headers: any[], candidates: string[]): number {
  const cleanedCandidates = candidates.map(clean);
  for (let i = 0; i < headers.length; i++) {
    const h = clean(headers[i]);
    if (h && cleanedCandidates.includes(h)) return i;
  }
  return -1;
}

/**
 * 수동 첨부 발송 전 검증 — 파일을 "변환하지 않고" 정합성만 판정한다.
 * (1) 데이터 정합성: 필수 열 존재 + 행별 수취인·주소·품목·주문번호 빈값 없음
 * (2) 캠페인 대조: 셀러 일치 + 파일 주문번호가 이 캠페인 주문 집합에 귀속되는지
 * 하드 차단 정책(소유자 결정 2026-07-10): 형식 오류·셀러 불일치·외부 주문번호는 발송 차단.
 * "캠페인엔 있으나 파일엔 없는 주문(누락)"은 부분 발송 정당성 때문에 경고로만 처리한다.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: campaignId } = await params;
    const formData = await request.formData();
    const file = formData.get('file') as File;
    if (!file) {
      return NextResponse.json({ error: '파일이 첨부되지 않았습니다.' }, { status: 400 });
    }

    const campaign = await prisma.orderCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) {
      return NextResponse.json({ error: '캠페인을 찾을 수 없습니다.' }, { status: 404 });
    }

    // 1. 엑셀 파싱 (원본은 그대로 두고 읽기만)
    const arrayBuffer = await file.arrayBuffer();
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(arrayBuffer, { type: 'array' });
    } catch (err: any) {
      if (err.message?.includes('password-protected')) {
        return NextResponse.json({ error: '첨부 파일에 암호가 설정되어 있어 읽을 수 없습니다.' }, { status: 400 });
      }
      return NextResponse.json({ error: '엑셀 파일을 읽지 못했습니다. 손상되었거나 지원하지 않는 형식입니다.' }, { status: 400 });
    }

    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<any[]>(worksheet, { header: 1, defval: '' });

    // 헤더 행 탐지 (주문번호/상품주문번호가 있는 첫 행)
    let headerIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const r = rows[i];
      if (Array.isArray(r) && r.some((c) => ORDER_NO_HEADERS.map(clean).includes(clean(c)))) {
        headerIdx = i;
        break;
      }
    }

    const errors: string[] = [];
    const warnings: string[] = [];

    if (headerIdx === -1) {
      return NextResponse.json(
        {
          ok: false,
          errors: ['발주서 형식이 아닙니다. 주문번호 열을 찾을 수 없습니다. 완성된 발주서 파일을 첨부해 주세요.'],
          warnings: [],
          stats: null,
        },
        { status: 200 },
      );
    }

    const headers = rows[headerIdx];
    const presentHeaders = headers.map(cellStr).filter((h) => h !== '');
    const recipientIdx = findColumnIndex(headers, RECIPIENT_HEADERS);
    const addressIdx = findColumnIndex(headers, ADDRESS_HEADERS);
    const itemIdx = findColumnIndex(headers, ITEM_HEADERS);
    const orderNoIdx = findColumnIndex(headers, ORDER_NO_HEADERS);
    const sellerIdx = findColumnIndex(headers, SELLER_HEADERS);

    // 서버 로그: 헤더 행 위치·인식된 헤더·매칭된 열 인덱스(운영자가 로그로 원인 추적 가능).
    console.log(
      `[validate] campaign=${campaignId} file="${file.name}" headerRow=${headerIdx + 1} ` +
        `headers=[${presentHeaders.join(' | ')}] ` +
        `idx={수취인:${recipientIdx}, 주소:${addressIdx}, 품목:${itemIdx}, 주문번호:${orderNoIdx}, 셀러:${sellerIdx}}`,
    );

    // 2. 필수 열 존재 검증 — 못 찾은 열은 "파일이 실제로 어떤 헤더를 갖고 있는지" 함께 노출해
    //    (헤더명이 후보와 달라서 열 자체를 못 찾은 것인지) 운영자가 즉시 판별하게 한다.
    const missingCols: string[] = [];
    if (recipientIdx === -1) missingCols.push('수취인');
    if (addressIdx === -1) missingCols.push('주소');
    if (itemIdx === -1) missingCols.push('품목');
    if (orderNoIdx === -1) missingCols.push('주문번호');
    if (missingCols.length > 0) {
      errors.push(
        `필수 열을 찾지 못했습니다: ${missingCols.join(', ')}. 헤더명이 발주서 양식과 다를 수 있습니다. ` +
          `파일에서 인식된 헤더: [${presentHeaders.join(' | ') || '없음'}]`,
      );
    }

    // 3. 데이터 행 순회 — 빈값·셀러·주문번호 수집
    const dataRows = rows.slice(headerIdx + 1).filter((r) => Array.isArray(r) && r.some((c) => cellStr(c) !== ''));
    const fileOrderIds = new Set<string>();
    // 행별로 "어느 칸이" 비었는지까지 기록한다(엑셀 실제 행번호 1-based + 빈 필드명 목록).
    const emptyFieldRows: { row: number; fields: string[] }[] = [];
    const sellerMismatches = new Set<string>();

    dataRows.forEach((r, i) => {
      const excelRowNo = headerIdx + 2 + i;
      const recipient = recipientIdx >= 0 ? cellStr(r[recipientIdx]) : '';
      const address = addressIdx >= 0 ? cellStr(r[addressIdx]) : '';
      const item = itemIdx >= 0 ? cellStr(r[itemIdx]) : '';
      const orderNo = orderNoIdx >= 0 ? cellStr(r[orderNoIdx]) : '';

      const emptyFields: string[] = [];
      if (recipientIdx >= 0 && !recipient) emptyFields.push('수취인');
      if (addressIdx >= 0 && !address) emptyFields.push('주소');
      if (itemIdx >= 0 && !item) emptyFields.push('품목');
      if (orderNoIdx >= 0 && !orderNo) emptyFields.push('주문번호');
      if (emptyFields.length > 0) {
        emptyFieldRows.push({ row: excelRowNo, fields: emptyFields });
      }
      if (orderNo) fileOrderIds.add(orderNo);

      if (sellerIdx >= 0) {
        const seller = cellStr(r[sellerIdx]);
        // 셀러명(별칭 포함 전체 문자열)이 파일 업체명에 포함돼야 한다.
        if (seller && campaign.sellerName && !seller.includes(campaign.sellerName)) {
          sellerMismatches.add(seller);
        }
      }
    });

    if (dataRows.length === 0) {
      errors.push('발송할 주문 데이터가 없습니다 (데이터 행 0건).');
    }
    if (emptyFieldRows.length > 0) {
      // 어느 행의 어느 칸이 비었는지 그대로 노출한다(예: "12행: 수취인, 15행: 주소·품목").
      const preview = emptyFieldRows
        .slice(0, 10)
        .map((e) => `${e.row}행(${e.fields.join('·')})`)
        .join(', ');
      errors.push(
        `필수 항목이 비어 있는 행 ${emptyFieldRows.length}건: ${preview}${emptyFieldRows.length > 10 ? ' 외' : ''}`,
      );
      console.warn(
        `[validate] campaign=${campaignId} empty-field rows=${JSON.stringify(emptyFieldRows)}`,
      );
    }
    if (sellerMismatches.size > 0) {
      errors.push(
        `셀러 불일치: 이 캠페인은 '${campaign.sellerName}'인데 파일 업체명에 ['${Array.from(sellerMismatches).slice(0, 3).join("', '")}'] 이(가) 있습니다. 다른 셀러 발주서일 수 있습니다.`,
      );
    }

    // 4. 캠페인 대조 (라이브 재조회 — 발주확인 등 부작용 없음)
    const matchedOrderIds: string[] = [];
    let campaignOrderCount = 0;
    if (fileOrderIds.size > 0) {
      try {
        const { orderIds: expected, count } = await resolveCampaignExpectedOrderIds(campaignId);
        campaignOrderCount = count;

        const foreign: string[] = [];
        fileOrderIds.forEach((id) => {
          if (expected.has(id)) matchedOrderIds.push(id);
          else foreign.push(id);
        });

        if (foreign.length > 0) {
          const preview = foreign.slice(0, 5).join(', ');
          errors.push(
            `이 캠페인에 속하지 않는 주문번호 ${foreign.length}건이 파일에 있습니다. ${preview}${foreign.length > 5 ? ' 외' : ''}. 다른 캠페인/기간 발주서가 섞였을 수 있습니다.`,
          );
        }

        const missingCount = expected.size - matchedOrderIds.length;
        if (missingCount > 0) {
          // 부분 발송은 정당할 수 있어 경고로만 처리 (하드 차단 아님).
          warnings.push(`이 캠페인 주문 중 ${missingCount}건이 첨부 파일에 없습니다 (전체 ${expected.size}건 중 ${matchedOrderIds.length}건 일치). 부분 발송이면 무시하세요.`);
        }
      } catch (resolveErr: any) {
        // 대조 기준을 확정 못하면 하드 차단 정책상 발송을 막는다(오발송 방지).
        errors.push(`캠페인 주문 대조 실패: ${resolveErr?.message || '조회 오류'}. 대조할 수 없어 발송을 차단합니다.`);
      }
    }

    const ok = errors.length === 0;
    return NextResponse.json(
      {
        ok,
        errors,
        warnings,
        // 발송 성공 시 배송대기 스탬프 대상(캠페인에 실제 귀속된 주문번호만).
        matchedOrderIds,
        stats: {
          totalDataRows: dataRows.length,
          fileOrderCount: fileOrderIds.size,
          campaignOrderCount,
          matched: matchedOrderIds.length,
        },
      },
      { status: 200 },
    );
  } catch (error: any) {
    console.error('Validate API Error:', error);
    return NextResponse.json({ error: error.message || '검증 중 오류가 발생했습니다.' }, { status: 500 });
  }
}
