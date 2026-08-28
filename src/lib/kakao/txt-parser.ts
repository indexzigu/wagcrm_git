/**
 * 카카오톡 PC "대화 내보내기" txt 파서 (Phase 4-5).
 *
 * 지원 포맷 변형 2종:
 *   변형 A: `[홍길동] [오후 3:42] 내용`
 *   변형 B: `2026년 7월 1일 오후 3:44, 홍길동 : 내용`
 *
 * 변형 A는 메시지 행에 시각만 있고 날짜가 없으므로, 파일 중간중간 삽입되는 날짜 구분선
 * (`--------------- 2026년 7월 1일 화요일 ---------------` 또는 장식 없이 `2026년 7월 1일 화요일`)에서
 * 연도/월/일 컨텍스트를 유지해야 한다. 변형 B는 각 메시지 행 자체에 날짜가 포함되어 있다.
 *
 * 순수 함수, 부작용 없음, 결정적(같은 입력 → 같은 출력).
 *
 * PII 주의(M1 리뷰 반영): warnings 배열은 preview 응답(kakao-uploads/route.ts)을 거쳐 브라우저까지
 * 그대로 노출된다. 따라서 이 파일 어디에서도 원문 대화 조각(line.slice 등)을 warnings에 절대 담지
 * 않는다 — 건수 집계 또는 파일명 등 비민감 정보만 포함한다.
 */

export type ParsedMessage = {
  sender: string;
  sentAt: Date; // UTC로 변환된 시각(KST 해석 후)
  text: string;
};

export type ParseResult = {
  roomName: string;
  messages: ParsedMessage[];
  warnings: string[];
};

const KST_OFFSET_MINUTES = 9 * 60;

// 헤더 1행: "<방이름> 님과 카카오톡 대화" 또는 "<방이름> 카카오톡 대화" 등.
const HEADER_PATTERNS = [
  /^(.+?)\s*님과\s*카카오톡\s*대화\s*$/,
  /^(.+?)\s*카카오톡\s*대화\s*내용\s*$/,
  /^(.+?)\s*카카오톡\s*대화\s*$/,
];

// "저장한 날짜 : 2026-07-05 12:00:00" 류 스킵 행.
const SAVED_DATE_LINE = /^\s*저장한\s*날짜\s*[:：]/;

// 날짜 구분선: 장식(-----) 유무 모두 허용. 예) "2026년 7월 1일 화요일", "--------------- 2026년 7월 1일 화요일 ---------------"
const DATE_SEPARATOR_PATTERN =
  /^-*\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*[가-힣]*요일\s*-*\s*$/;

// 변형 A: [발신자] [오전/오후 h:mm] 내용
const VARIANT_A_PATTERN = /^\[(.+?)\]\s*\[(오전|오후)\s*(\d{1,2}):(\d{2})\]\s?(.*)$/;

// 변형 B: 2026년 7월 1일 오후 3:44, 홍길동 : 내용
// M2 리뷰 반영: 카카오톡 PC 내보내기의 실제 발신자/본문 구분자는 " : "(공백-콜론-공백)이다.
// 이전에는 `\s*:\s?`로 아무 콜론에서나 분리되어 발신자명에 콜론이 포함된 경우(예: "부서:영업팀")
// 오분리되었다. 이제 " : " 리터럴만 구분자로 인정한다. 발신자명 자체에 " : "(공백 포함 콜론)이
// 포함된 극단적 케이스는 이 구분자와 구별 불가능하므로 알려진 한계로 남긴다.
const VARIANT_B_PATTERN =
  /^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*(오전|오후)\s*(\d{1,2}):(\d{2}),\s*(.+?) : (.*)$/;

// 시스템 메시지(입장/퇴장/삭제된 메시지 등). M3 리뷰 반영: 카카오톡 내보내기에서 시스템 메시지는
// 발신자/시각 prefix 없이 "bare 라인"으로 출력된다 — 즉 변형 A/B 패턴에 매치되지 않는 독립된 한
// 줄이다. 따라서 이 판정은 "파싱에 실패한 bare 라인"에만 적용하고, 전체 일치(^...$) 앵커로
// 좁혀서 실제 메시지 본문이 우연히 이 문구를 포함/종료하는 경우(예: "...나갔습니다"로 끝나는
// 대화 내용)를 시스템 메시지로 오탐하지 않게 한다.
const SYSTEM_MESSAGE_PATTERNS = [
  /^.+님이\s*들어왔습니다\s*\.?$/,
  /^.+님이\s*나갔습니다\s*\.?$/,
  /^.+채팅방을\s*나갔습니다\s*\.?$/,
  /^.+채팅방에\s*초대되었습니다\s*\.?$/,
  /^.+님을\s*초대했습니다\s*\.?$/,
  /^삭제된\s*메시지입니다\s*\.?$/,
];

// 첨부 단독 행(메시지 본문이 정확히 이 값과 전체 일치할 때만 제외) — 사진/이모티콘/동영상 등.
// M3 리뷰 반영: 파싱된 메시지 본문에 대해서도 전체 일치로만 판정한다 — "사진 보냈어요"처럼
// 첨부 마커 단어를 포함하지만 실제 텍스트가 있는 메시지는 보존해야 한다.
const ATTACHMENT_ONLY_VALUES = new Set(["사진", "이모티콘", "동영상", "파일", "사진 여러 장", "삭제된 메시지입니다."]);

/** 파싱된 메시지 "본문"이 첨부 마커와 정확히 일치하는지(전체 일치)만 판단한다. */
function isAttachmentOnlyBody(text: string): boolean {
  return ATTACHMENT_ONLY_VALUES.has(text.trim());
}

/** 패턴 매칭에 실패한 "bare 라인"이 시스템 메시지 안내문인지 판단한다(전체 일치 기반). */
function isSystemMessageLine(line: string): boolean {
  const trimmed = line.trim();
  if (ATTACHMENT_ONLY_VALUES.has(trimmed)) return true;
  return SYSTEM_MESSAGE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function to24Hour(period: "오전" | "오후", hour12: number): number {
  if (period === "오전") {
    return hour12 === 12 ? 0 : hour12;
  }
  // 오후
  return hour12 === 12 ? 12 : hour12 + 12;
}

/** KST(년,월,일,시,분)를 UTC Date로 변환한다. */
function kstToUtcDate(year: number, month: number, day: number, hour: number, minute: number): Date {
  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, 0, 0) - KST_OFFSET_MINUTES * 60 * 1000;
  return new Date(utcMillis);
}

/** 날짜 컨텍스트(y,m,d)를 단일 정수로 비교 가능한 키로 변환한다(연대순 비교용). */
function dateKey(year: number, month: number, day: number): number {
  return year * 10000 + month * 100 + day;
}

function extractRoomName(headerLine: string, fallbackFileName: string, warnings: string[]): string {
  for (const pattern of HEADER_PATTERNS) {
    const match = headerLine.match(pattern);
    if (match) return match[1].trim();
  }
  // M1 리뷰 반영: 원문 헤더 라인을 warnings에 담지 않는다(파일명만 언급).
  warnings.push(`방 이름을 헤더에서 추출하지 못해 파일명으로 대체합니다: "${fallbackFileName}"`);
  return fallbackFileName.replace(/\.txt$/i, "");
}

/**
 * 카카오톡 대화 내보내기 txt 파일 원문을 파싱한다.
 * @param rawText 파일 원문(UTF-8 디코딩된 문자열)
 * @param fileName 헤더에서 방 이름 추출 실패 시 fallback으로 사용할 파일명
 */
export function parseKakaoTxt(rawText: string, fileName: string): ParseResult {
  const warnings: string[] = [];
  // BOM 제거 + CRLF 정규화.
  const normalized = rawText.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  let roomName: string | null = null;
  let currentYear: number | null = null;
  let currentMonth: number | null = null;
  let currentDay: number | null = null;

  const messages: ParsedMessage[] = [];
  let lastMessage: ParsedMessage | null = null;

  // M1 리뷰 반영: 원문 미노출 건수 집계용 카운터(경고 메시지는 건수만 담는다).
  let missingDateContextSkipCount = 0;
  // M4 리뷰 반영: 구분선 후보가 멀티라인 진행 중(lastMessage 존재)에 날짜를 전진시킨 건수.
  let dateAdvancedDuringMultilineCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim().length === 0) continue;

    if (roomName === null) {
      // 첫 비어있지 않은 행을 헤더로 취급 시도.
      const looksLikeHeader = HEADER_PATTERNS.some((p) => p.test(line.trim()));
      if (looksLikeHeader) {
        roomName = extractRoomName(line.trim(), fileName, warnings);
        continue;
      }
      // 헤더가 아니라면(예: 저장한 날짜가 먼저 오는 변형) 계속 탐색하되, 이 행이 날짜구분선/메시지일
      // 수도 있으니 아래로 흘려보낸다. 파일 끝까지 헤더를 못 찾으면 fallback.
    }

    if (SAVED_DATE_LINE.test(line)) continue;

    const dateSepMatch = line.match(DATE_SEPARATOR_PATTERN);
    if (dateSepMatch) {
      const candidateYear = Number(dateSepMatch[1]);
      const candidateMonth = Number(dateSepMatch[2]);
      const candidateDay = Number(dateSepMatch[3]);

      // M4 리뷰 반영 — 연대순 가드: 내보내기는 시간순이므로, 구분선 후보의 날짜가 현재 날짜
      // 컨텍스트보다 과거라면 이는 실제 날짜 구분선이 아니라(포맷상 날짜는 전진만 함)
      // 날짜 문자열과 우연히 동일한 멀티라인 연속행일 가능성이 높다 — 메시지 연속으로 처리한다.
      const isPastDate =
        currentYear !== null &&
        currentMonth !== null &&
        currentDay !== null &&
        dateKey(candidateYear, candidateMonth, candidateDay) < dateKey(currentYear, currentMonth, currentDay);

      if (!isPastDate) {
        // M4 리뷰 반영: 멀티라인 진행 중(lastMessage 존재)에 날짜가 전진되면, 실제로는 메시지
        // 연속행일 가능성이 있으므로 원문 없이 건수만 경고로 남긴다(결정성은 유지 — 판단 자체는
        // 바뀌지 않고 로그만 추가됨).
        if (lastMessage) {
          dateAdvancedDuringMultilineCount += 1;
        }
        currentYear = candidateYear;
        currentMonth = candidateMonth;
        currentDay = candidateDay;
        continue;
      }
      // isPastDate: 구분선으로 인정하지 않고 아래로 흘려보내 멀티라인 연속행으로 처리한다.
    }

    const variantAMatch = line.match(VARIANT_A_PATTERN);
    if (variantAMatch) {
      const [, sender, period, hourStr, minuteStr, text] = variantAMatch;
      if (currentYear === null || currentMonth === null || currentDay === null) {
        missingDateContextSkipCount += 1;
        continue;
      }
      const hour = to24Hour(period as "오전" | "오후", Number(hourStr));
      const sentAt = kstToUtcDate(currentYear, currentMonth, currentDay, hour, Number(minuteStr));

      // M3 리뷰 반영: 패턴 매칭에 성공한 메시지는 본문이 첨부 마커와 "전체 일치"할 때만 제외한다.
      // 시스템 메시지 판정은 bare 라인에만 적용하므로 여기서는 첨부 단독 여부만 확인한다.
      if (isAttachmentOnlyBody(text)) {
        continue;
      }

      const message: ParsedMessage = { sender, sentAt, text };
      messages.push(message);
      lastMessage = message;
      continue;
    }

    const variantBMatch = line.match(VARIANT_B_PATTERN);
    if (variantBMatch) {
      const [, yearStr, monthStr, dayStr, period, hourStr, minuteStr, sender, text] = variantBMatch;
      currentYear = Number(yearStr);
      currentMonth = Number(monthStr);
      currentDay = Number(dayStr);

      if (isAttachmentOnlyBody(text)) {
        continue;
      }

      const hour = to24Hour(period as "오전" | "오후", Number(hourStr));
      const sentAt = kstToUtcDate(currentYear, currentMonth, currentDay, hour, Number(minuteStr));
      const message: ParsedMessage = { sender, sentAt, text };
      messages.push(message);
      lastMessage = message;
      continue;
    }

    // 변형 A/B 어느 패턴에도 매치되지 않는 "bare 라인" — 시스템 메시지 안내문이거나 멀티라인
    // 연속행이다. M3 리뷰 반영: 시스템 메시지로 판정되어도 lastMessage를 null로 리셋하지 않는다
    // (직후 라인이 이전 메시지의 연속일 가능성을 소실시키지 않기 위함 — 소실보다 안전한 쪽 선택).
    if (isSystemMessageLine(line)) {
      continue;
    }

    // 멀티라인 메시지의 연속 행. 직전 메시지에 append.
    if (lastMessage) {
      lastMessage.text = `${lastMessage.text}\n${line}`;
    }
    // lastMessage가 없으면(예: 헤더 탐색 중) 조용히 무시한다.
  }

  if (roomName === null) {
    // M1 리뷰 반영: 파일명만 언급(이 경로는 애초에 원문을 담지 않았으나 일관성을 위해 유지).
    warnings.push(`방 이름을 헤더에서 찾지 못해 파일명으로 대체합니다: "${fileName}"`);
    roomName = fileName.replace(/\.txt$/i, "");
  }

  if (missingDateContextSkipCount > 0) {
    warnings.push(
      `날짜 컨텍스트 없이 발견되어 스킵한 메시지가 ${missingDateContextSkipCount}건 있습니다(변형 A).`
    );
  }

  if (dateAdvancedDuringMultilineCount > 0) {
    warnings.push(
      `멀티라인 메시지 진행 중 날짜 구분선으로 해석된 행이 ${dateAdvancedDuringMultilineCount}건 있어 날짜 컨텍스트가 전진되었습니다. 결과를 확인해주세요.`
    );
  }

  return { roomName, messages, warnings };
}
