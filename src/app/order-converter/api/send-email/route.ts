import { NextRequest, NextResponse, after } from 'next/server';
import nodemailer from 'nodemailer';
import { prisma } from '@/lib/order-converter/prisma';
import { orderFulfillmentRepository } from '@/repositories/orderFulfillmentRepository';
import { resolveCampaignExpectedOrderIds } from '@/lib/order-converter/campaign-orders';
import { resolveMailCredentials, resolveMailFrom, resolveSmtpConfig } from '@/lib/mail-config';

// 캠페인 재조회(라이브)를 백그라운드 폴백에서 수행할 수 있으므로 실행시간 한도를 상향한다
// (execute/validate 라우트와 동일 기준). 메일 발송 자체는 이 한도 이전에 끝난다.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const to = formData.get('to') as string;
    const cc = formData.get('cc') as string;
    const subject = formData.get('subject') as string;
    const message = formData.get('message') as string;
    const campaignId = formData.get('campaignId') as string;
    // 발주서에 실린 상품주문번호(CSV) — 발송 성공 시 배송대기(poRequestedAt) 스탬프 대상.
    const productOrderIdsRaw = (formData.get('productOrderIds') as string) || '';

    if (!file || !to) {
      return NextResponse.json({ error: '필수 항목(수신자, 첨부파일)이 누락되었습니다.' }, { status: 400 });
    }

    // 파일 버퍼 추출
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // SMTP 자격증명은 env 필수 — 개인 이메일 폴백 하드코딩 금지(공개 레포).
    // 미설정이면 빈 비밀번호로 인증 실패하던 기존 동작 대신 명시적으로 실패한다.
    // 접속할 서버는 `src/lib/mail-config.ts` 가 소유한다(수신 경로 2곳과 같은 계정).
    const credentials = resolveMailCredentials();
    if (!credentials) {
      return NextResponse.json(
        { error: 'SMTP_USER/SMTP_PASS 환경변수가 설정되지 않았습니다. 발주 메일을 보낼 수 없습니다.' },
        { status: 503 }
      );
    }
    const transporter = nodemailer.createTransport(resolveSmtpConfig(credentials));

    const { name: fromName, email: fromEmail } = resolveMailFrom(credentials.user);

    const campaign = campaignId ? await prisma.orderCampaign.findUnique({ where: { id: campaignId } }) : null;
    const sellerName = campaign?.sellerName || '미지정';
    const dispatchDate = new Date().toISOString().slice(0, 10);
    const refTag = `[YGRD-REF:${campaignId}|${sellerName}|${dispatchDate}]`;

    const plainTextMessage = message || '요청하신 발주서 첨부파일을 송부드립니다.';
    const htmlMessage = plainTextMessage.replace(/\n/g, '<br/>') + 
      `<br/><div style="display:none; font-size:0px; color:transparent; opacity:0; line-height:0; height:0px; overflow:hidden;">${refTag}</div>`;

    const mailOptions: any = {
      from: `"${fromName}" <${fromEmail}>`,
      to,
      subject: subject || '브랜드사 발주서 전달',
      text: plainTextMessage,
      html: htmlMessage,
      attachments: [
        {
          filename: file.name,
          content: buffer,
        },
      ],
      bcc: fromEmail, // 발신자에게도 숨은참조로 복사본 발송
    };

    if (cc) {
      mailOptions.cc = cc;
    }

    await transporter.sendMail(mailOptions);

    // 발송 성공 → 이 발주서에 실린 상품주문번호들을 "배송대기"로 스탬프(상품주문 1건 단위).
    // 발주요청(REQUEST_PO)이 배송대기 진입 트리거라는 재정의(order-fulfillment.ts)의 쓰기 지점.
    // 스탬프 실패가 메일 발송 성공(원 액션)을 되돌리지 않도록 방어적으로 감싼다.
    //
    // 경로별 신뢰도 차이(버그 2026-07-10): productOrderIds는 자동 연동(execute 헤더)·수동 첨부
    // (validate matchedOrderIds) 두 소스에서만 채워지고, 헤더 유실·파싱 실패·기존 파일 재발송 등에서
    // 비어 올 수 있다. 비면 스탬프가 0건이 되어 발주요청된 주문이 파이프라인상 '주문확인'에 남고
    // 대시보드 배송대기가 과소 집계된다. → 클라이언트 ID가 비면 서버가 이 캠페인의 발주요청 대상
    // 주문을 직접 조회해 스탬프하는 폴백으로, 모든 발송 경로에서 배송대기 진입을 보장한다.
    const productOrderIds = productOrderIdsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (productOrderIds.length > 0) {
      // 빠른 경로: 발주서에 실린 상품주문번호가 명시적으로 전달됨 — 그것만 정확히 스탬프.
      try {
        await orderFulfillmentRepository.stampPoRequested(productOrderIds, campaignId || null);
      } catch (stampErr) {
        console.warn('발주요청 배송대기 스탬프 실패(발송은 성공):', stampErr);
      }
    } else if (campaignId) {
      // 폴백 경로: 클라이언트가 상품주문번호를 넘기지 못했다. 라이브 캠페인 재조회는 느릴 수 있어
      // 응답(모달 완료 표시)을 막지 않도록 after()로 백그라운드에서 스탬프한다.
      // 대상: 이 캠페인의 유효 주문(PAYED/PRODUCT_ORDERED) 중 아직 발주요청되지 않은 건 —
      // execute(includePending=false)가 발주서에 싣는 집합과 동일 규칙. 이미 발송된 건은
      // 원 시각을 보존하려고 제외한다(멱등).
      after(async () => {
        try {
          const { orderIds } = await resolveCampaignExpectedOrderIds(campaignId);
          const allIds = Array.from(orderIds);
          if (allIds.length === 0) return;
          const already = await orderFulfillmentRepository.getPoRequestedSet(allIds);
          const toStamp = allIds.filter((id) => !already.has(id));
          if (toStamp.length > 0) {
            await orderFulfillmentRepository.stampPoRequested(toStamp, campaignId);
            console.info(`[send-email] 서버측 폴백 스탬프 ${toStamp.length}건 (campaign=${campaignId})`);
          }
        } catch (fallbackErr) {
          console.warn('발주요청 배송대기 서버측 폴백 스탬프 실패(발송은 성공):', fallbackErr);
        }
      });
    }

    // 성공 시 Task 상태 업데이트 (campaignId가 있을 경우)
    if (campaignId) {
      const d = new Date();
      const dKst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
      const today = dKst.toISOString().slice(0, 10);
      
      await prisma.dailyOrderTask.upsert({
        where: {
          campaignId_date: {
            campaignId,
            date: today
          }
        },
        update: {
          status: 'EMAILED',
          sentFileName: file.name,
        },
        create: {
          campaignId,
          date: today,
          status: 'EMAILED',
          sentFileName: file.name,
        }
      });
    }

    return NextResponse.json({ message: '이메일이 성공적으로 발송되었습니다.' }, { status: 200 });
  } catch (error: any) {
    console.error('Email send error:', error);
    return NextResponse.json({ error: '이메일 발송 중 서버 오류가 발생했습니다.' }, { status: 500 });
  }
}
