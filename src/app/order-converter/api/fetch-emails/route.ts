import { NextRequest, NextResponse } from 'next/server';
import imaps from 'imap-simple';
import { resolveOrderBrand } from '@/lib/order-converter/order-brand';
import { resolveImapConfig, resolveMailCredentials } from '@/lib/mail-config';
import { fetchBodiesByUid } from '@/lib/tax-invoice-mail/mail-scan';
import {
  buildReplyMatchCriteria,
  isReplyHeaderCandidate,
  listReplyMailboxes,
  parseMailBody,
  parseReplyTracking,
  pickReplyAttachment,
  readReplyHeader,
  replyHeaderFetchOptions,
  replyHeaderSearchCriteria,
  replyRefTagPrefix,
  replyScanSince,
  replyTagSearchCriteria,
} from '@/lib/order-converter/invoice-reply-match';

// F4-②: 브랜드별 허용 발신자 도메인은 거래처(Partner) 설정에서 해석 (하드코딩 맵 제거).

export async function POST(req: NextRequest) {
  try {
    console.log('🔥 [fetch-emails] API 요청 인입됨!');
    const body = await req.json();
    // ⛔ 바디 통째 로깅 금지(P0) — `sellerName`·`toEmail` 은 셀러 실명과 메일 주소다.
    // 진단에 쓰는 것은 어떤 캠페인·공급사 요청이었나이므로 그 둘만 남긴다.
    const { template, sellerName, toEmail, sentDates, campaignId } = body;
    console.log('🔥 [fetch-emails] 요청 수신:', { template, campaignId });

    if (!template || !sellerName) {
      return NextResponse.json({ error: '템플릿(공급사) 또는 셀러명이 제공되지 않았습니다.' }, { status: 400 });
    }

    // 접속할 서버는 `src/lib/mail-config.ts` 가 소유한다(세무처리 스캔·발주 발송과 같은 계정).
    const credentials = resolveMailCredentials();
    if (!credentials) {
      return NextResponse.json({ error: '메일 서버(IMAP) 연동 정보가 설정되어 있지 않습니다.' }, { status: 500 });
    }
    const config = { imap: resolveImapConfig(credentials, { authTimeout: 5000 }) };

    let connection;
    try {
      console.log('🔥 [fetch-emails] IMAP 서버 연결 시도 중...');
      connection = await imaps.connect(config);
      console.log('🔥 [fetch-emails] IMAP 서버 연결 성공!');
      console.log('🔥 [fetch-emails] 편지함(Box) 목록 가져오는 중...');
    } catch (err: any) {
      console.error('IMAP Connect Error:', err);
      return NextResponse.json({ error: '메일 서버 연결에 실패했습니다. 계정 정보를 확인해주세요.' }, { status: 500 });
    }

    // 편지함 나열·제외·순서와 매칭 규칙은 `invoice-reply-match.ts` 가 소유한다 — 크론
    // `scan-invoice-replies`(감지 전용)가 같은 규칙을 쓴다. ⛔ 여기서 규칙을 다시 적지 말 것.
    const targetBoxes = await listReplyMailboxes(connection);

    console.log(`🔥 [fetch-emails] 스캔 대상 편지함 목록:`, targetBoxes);

    let foundAttachmentBuffer: Buffer | null = null;
    let foundFileName: string = '';
    let foundUid: number | null = null;

    const brand = await resolveOrderBrand(template);
    const criteria = buildReplyMatchCriteria({
      campaignId,
      brandEmailDomains: brand ? brand.emailDomains : [],
      toEmail,
      sellerName,
      sentDates,
    });

    // 편지함을 순회하며 검색 시작
    for (const boxName of targetBoxes) {
      if (foundAttachmentBuffer) break;

      try {
        console.log(`🔥 [fetch-emails] 편지함 [${boxName}] 여는 중...`);
        const box = await connection.openBox(boxName);
        const totalMessages = (box as any).messages.total;
        console.log(`🔥 [fetch-emails] [${boxName}] 총 메일 수: ${totalMessages}`);

        if (totalMessages === 0) continue;

        const since = replyScanSince();

        // 1. IMAP 서버 자체에서 태그(캠페인ID)를 포함한 메일 고속 검색
        const tagMessages = await connection.search(replyTagSearchCriteria(campaignId, since), replyHeaderFetchOptions());
        const tagUids = tagMessages.map((m: any) => m.attributes.uid);

        // 2. 제목/보낸사람 매칭용 전체 검색 (최근 7일)
        const messages = await connection.search(replyHeaderSearchCriteria(since), replyHeaderFetchOptions());
        console.log(`🔥 [fetch-emails] [${boxName}] 메일 헤더 검색 완료. 가져온 수: ${messages.length}`);

        messages.sort((a, b) => (b.attributes.date as Date).getTime() - (a.attributes.date as Date).getTime());

        const candidateUids: number[] = [];

        for (const msg of messages) {
          const header = await readReplyHeader(msg as any);
          if (!header) continue;
          const id = header.uid;
          if (isReplyHeaderCandidate(header, criteria, { loginUser: credentials.user, taggedInImap: tagUids.includes(id) })) {
            console.log(`🔥 [fetch-emails] 후보 메일 발견! 편지함: ${boxName}, UID: ${id}, Subject: ${header.subject}`);
            candidateUids.push(id);
          }
        }

        console.log(`🔥 [fetch-emails] [${boxName}] 1차 필터링 통과 후보 수: ${candidateUids.length}`);

        // 후보 본문은 1통씩이 아니라 UID 묶음으로 받는다 — 1통씩 요청하면 왕복 대기만으로
        // 느려진다(`mail-scan.ts` 의 `fetchBodiesByUid` 실측 참조).
        const bodyByUid = await fetchBodiesByUid(connection, candidateUids);

        for (const uid of candidateUids) {
          if (!bodyByUid.has(uid)) continue;

          const parsed = await parseMailBody(bodyByUid.get(uid));
          const verdict = pickReplyAttachment(parsed, criteria);

          // 만약 이메일 본문에 YGRD-REF 태그가 있는데 현재 조회중인 캠페인 ID가 아니면 다른 상품의 회신이므로 스킵
          if (verdict.kind === 'other-campaign') {
             console.log(`🔥 [fetch-emails] 다른 캠페인(${replyRefTagPrefix(campaignId)} 아님)의 회신으로 식별됨. 스킵. (UID: ${uid})`);
             continue;
          }

          if (verdict.kind === 'match') {
            console.log(`🔥 [fetch-emails] 최종 첨부파일 매칭 성공! 편지함: ${boxName}, 파일명: ${verdict.attachment.filename}`);
            foundAttachmentBuffer = verdict.attachment.content;
            foundFileName = verdict.attachment.filename || 'downloaded_order.xlsx';
            foundUid = uid;
            break;
          }
        }
      } catch (err) {
        console.log(`🔥 [fetch-emails] [${boxName}] 편지함 스캔 중 에러 발생, 건너뜁니다:`, err);
        continue;
      }
    }

    if (foundAttachmentBuffer && foundUid !== null) {
      // 읽음 처리 (선택사항 - 사용자가 승인했으므로 적용)
      await connection.addFlags(foundUid, ['\\Seen']);
      connection.end();

      // F4 Phase 2 §5단계: 서버에서 브랜드 reply 규칙으로 송장 파싱까지 수행해 반환한다.
      // (클라이언트가 formatAdapter를 몰라 신규 브랜드 회신을 오파싱하던 문제 해소)
      let trackingMap: Record<string, { 택배사: string; 송장번호: string }> = {};
      try {
        trackingMap = parseReplyTracking(foundAttachmentBuffer, brand);
      } catch (parseErr) {
        // 파싱 실패해도 파일 자체는 반환(클라이언트가 원본 저장/수동 확인 가능) — 삼키지 말고 로그
        console.warn('fetch-emails 송장 파싱 실패(파일은 반환):', parseErr);
      }

      // Base64로 인코딩하여 반환
      const base64Data = foundAttachmentBuffer.toString('base64');
      return NextResponse.json({
        message: '메일에서 성공적으로 발주서를 추출했습니다.',
        fileName: foundFileName,
        fileData: base64Data,
        trackingMap,
      }, { status: 200 });

    } else {
      connection.end();
      return NextResponse.json({ error: '최근 3일 내에 해당 브랜드사 도메인 및 셀러명 조건과 일치하는 회신 발주서(엑셀)를 찾을 수 없습니다.' }, { status: 404 });
    }

  } catch (error: any) {
    console.error('Fetch emails API Error:', error);
    return NextResponse.json({ error: '메일 확인 중 서버 오류가 발생했습니다.' }, { status: 500 });
  }
}
