import { NextRequest, NextResponse } from 'next/server';
import imaps from 'imap-simple';
import { simpleParser } from 'mailparser';
import { Readable } from 'stream';
import { resolveOrderBrand, resolveReplyRule } from '@/lib/order-converter/order-brand';
import { extractTrackingMapByReply } from '@/lib/order-converter/order-parser';
import {
  isOwnSenderAddress,
  orderMailboxesForScan,
  resolveImapConfig,
  resolveMailCredentials,
  type MailboxDescriptor,
} from '@/lib/mail-config';

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

    // 편지함 전수 나열 → 제외·순서는 `mail-config` 가 판정한다.
    // ⛔ 여기서 이름 목록을 다시 만들지 말 것: 종전 인라인 목록은 다음메일의 **띄어쓴**
    //    한국어 이름만 알고 있어서 구글의 `휴지통`·`보낸편지함`·`전체보관함` 이 하나도
    //    안 걸렸다(전체보관함은 전 메일의 사본이라 메일함을 두 번 훑게 된다).
    const boxesInfo = await connection.getBoxes();
    const discovered: MailboxDescriptor[] = [];

    const extractBoxes = (boxObj: any, prefix = '') => {
      for (const key of Object.keys(boxObj)) {
        const boxName = prefix + key;
        discovered.push({ name: boxName, attribs: boxObj[key]?.attribs ?? [] });
        if (boxObj[key].children) {
          extractBoxes(boxObj[key].children, boxName + boxObj[key].delimiter);
        }
      }
    };
    extractBoxes(boxesInfo);

    const targetBoxes = orderMailboxesForScan(discovered);

    console.log(`🔥 [fetch-emails] 스캔 대상 편지함 목록:`, targetBoxes);

    let foundAttachmentBuffer: Buffer | null = null;
    let foundFileName: string = '';
    let foundUid: number | null = null;

    const brand = await resolveOrderBrand(template);
    const allowedDomains: string[] = brand ? [...brand.emailDomains] : [];
    
    // 수신 이메일에서 도메인 추출하여 허용 목록에 추가
    if (toEmail) {
      const emails = toEmail.split(',').map((e: string) => e.trim());
      emails.forEach((email: string) => {
        const parts = email.split('@');
        if (parts.length === 2) {
          const domain = '@' + parts[1];
          if (!allowedDomains.includes(domain)) {
            allowedDomains.push(domain);
          }
        }
      });
    }
    
    const coreSellerName = sellerName ? sellerName.split('(')[0].trim().replace(/\s+/g, '') : '';

    // 편지함을 순회하며 검색 시작
    for (const boxName of targetBoxes) {
      if (foundAttachmentBuffer) break;

      try {
        console.log(`🔥 [fetch-emails] 편지함 [${boxName}] 여는 중...`);
        const box = await connection.openBox(boxName);
        const totalMessages = (box as any).messages.total;
        console.log(`🔥 [fetch-emails] [${boxName}] 총 메일 수: ${totalMessages}`);

        if (totalMessages === 0) continue;

        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        
        // 1. IMAP 서버 자체에서 태그(캠페인ID)를 포함한 메일 고속 검색
        const tagSearchCriteria = [['SINCE', sevenDaysAgo], ['BODY', `[YGRD-REF:${campaignId}`]];
        const tagMessages = await connection.search(tagSearchCriteria, { bodies: ['HEADER'], markSeen: false, struct: true });
        const tagUids = tagMessages.map((m: any) => m.attributes.uid);

        // 2. 제목/보낸사람 매칭용 전체 검색 (최근 7일)
        const searchCriteria = [['SINCE', sevenDaysAgo]];
        const fetchOptions = { bodies: ['HEADER'], markSeen: false, struct: true };

        const messages = await connection.search(searchCriteria, fetchOptions);
        console.log(`🔥 [fetch-emails] [${boxName}] 메일 헤더 검색 완료. 가져온 수: ${messages.length}`);

        messages.sort((a, b) => (b.attributes.date as Date).getTime() - (a.attributes.date as Date).getTime());

        const candidateUids: number[] = [];

        for (const msg of messages) {
          const headerPart = msg.parts.find((part: any) => part.which === 'HEADER');
          if (!headerPart) continue;

          const id = msg.attributes.uid;
          let subject = '';
          let fromAddress = '';

          if (typeof headerPart.body === 'object' && !Buffer.isBuffer(headerPart.body)) {
            subject = headerPart.body.subject?.[0] || headerPart.body.Subject?.[0] || '';
            fromAddress = headerPart.body.from?.[0] || headerPart.body.From?.[0] || '';
          } else {
            let rawHeader = headerPart.body;
            if (typeof rawHeader === 'string') {
              rawHeader = Buffer.from(rawHeader, 'utf8');
            }
            const streamHeader = new Readable();
            streamHeader.push(rawHeader);
            streamHeader.push(null);
            const parsedHeader = await simpleParser(streamHeader);
            fromAddress = parsedHeader.from?.value[0]?.address || '';
            subject = parsedHeader.subject || '';
          }

          let domainMatched = allowedDomains.length === 0;
          if (!domainMatched) {
            domainMatched = allowedDomains.some((domain) => fromAddress.toLowerCase().includes(domain.toLowerCase()));
          }

          const normalizedSubject = subject.replace(/\s+/g, '').toLowerCase();
          const hasOurCompanyName = normalizedSubject.includes('와이그라운드');
          const hasSeller = coreSellerName && normalizedSubject.includes(coreSellerName.toLowerCase());
          
          let hasSentDate = false;
          if (sentDates && sentDates.length > 0) {
            hasSentDate = sentDates.some((dateStr: string) => {
              const shortDate = dateStr.length === 6 ? dateStr.substring(2) : dateStr;
              return normalizedSubject.includes(dateStr) || normalizedSubject.includes(shortDate);
            });
          } else {
            hasSentDate = true; 
          }
          
          const matchScore = (hasOurCompanyName ? 1 : 0) + (hasSeller ? 1 : 0) + (hasSentDate ? 1 : 0);
          
          // 내가 발송한 메일(원본)은 제외 처리 — 판정은 `mail-config` 가 소유한다
          // (자사 도메인 · 로그인 계정 · 옛 사업자 계정 세 갈래. 사유는 그 함수 주석).
          const isMyOwnMail = isOwnSenderAddress(fromAddress, credentials.user);
          const subjectMatched = !isMyOwnMail && (domainMatched || matchScore >= 2);
          const hasTagInImap = tagUids.includes(id) && !isMyOwnMail;
          
          if (subjectMatched || hasTagInImap) {
            console.log(`🔥 [fetch-emails] 후보 메일 발견! 편지함: ${boxName}, UID: ${id}, Subject: ${subject}`);
            candidateUids.push(id);
          }
        }

        console.log(`🔥 [fetch-emails] [${boxName}] 1차 필터링 통과 후보 수: ${candidateUids.length}`);

        for (const uid of candidateUids) {
          console.log(`🔥 [fetch-emails] 후보 메일(UID:${uid}) 전체 다운로드 시작...`);
          const fullMsgArr = await connection.search([['UID', uid]], { bodies: [''], markSeen: false });
          if (!fullMsgArr || fullMsgArr.length === 0) continue;
          
          const msg = fullMsgArr[0];
          const allBody = msg.parts.find((part: any) => part.which === '');
          if (!allBody) continue;

          let rawBody = allBody.body;
          if (typeof rawBody === 'string') {
            rawBody = Buffer.from(rawBody, 'utf8');
          }
          const streamBody = new Readable();
          streamBody.push(rawBody);
          streamBody.push(null);
          const parsed = await simpleParser(streamBody);
          
          const textBody = parsed.text || '';
          const htmlBody = parsed.html || '';
          const refTagPrefix = `[YGRD-REF:${campaignId}`;
          const containsAnyRefTag = textBody.includes('[YGRD-REF:') || htmlBody.includes('[YGRD-REF:');
          const hasMyRefTag = textBody.includes(refTagPrefix) || htmlBody.includes(refTagPrefix);

          // 만약 이메일 본문에 YGRD-REF 태그가 있는데 현재 조회중인 캠페인 ID가 아니면 다른 상품의 회신이므로 스킵
          if (containsAnyRefTag && !hasMyRefTag) {
             console.log(`🔥 [fetch-emails] 다른 캠페인(${refTagPrefix} 아님)의 회신으로 식별됨. 스킵. (UID: ${uid})`);
             continue;
          }

          let attachmentMatched = false;
          let targetAttachment = null;

          for (const attachment of parsed.attachments) {
            const fileName = attachment.filename || '';
            const normalizedFilename = fileName.replace(/\s+/g, '').toLowerCase();
            const isExcelOrCsv = fileName.endsWith('.xlsx') || fileName.endsWith('.xls') || fileName.endsWith('.csv');
            
            // 파일명에 셀러명 반드시 포함 (단, 태그 매칭이 되었다면 양식이 달라도 허용)
            const hasSellerName = coreSellerName ? normalizedFilename.includes(coreSellerName.toLowerCase()) : true;

            if (isExcelOrCsv && (hasSellerName || hasMyRefTag)) {
              attachmentMatched = true;
              targetAttachment = attachment;
              break;
            }
          }

          if (attachmentMatched && targetAttachment) {
            console.log(`🔥 [fetch-emails] 최종 첨부파일 매칭 성공! 편지함: ${boxName}, 파일명: ${targetAttachment.filename}`);
            foundAttachmentBuffer = targetAttachment.content;
            foundFileName = targetAttachment.filename || 'downloaded_order.xlsx';
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
        const reply = resolveReplyRule(brand);
        // Buffer → ArrayBuffer 뷰. subarray로 정확한 바이트 범위만 전달.
        const ab = foundAttachmentBuffer.buffer.slice(
          foundAttachmentBuffer.byteOffset,
          foundAttachmentBuffer.byteOffset + foundAttachmentBuffer.byteLength
        ) as ArrayBuffer;
        trackingMap = extractTrackingMapByReply(ab, reply);
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
