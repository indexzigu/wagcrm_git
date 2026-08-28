/**
 * 첨부 **정체 판별** — 열지 않고 겉모습만 본다(순수 함수).
 *
 * ## 왜 필요한가 (2026-08-03 오너 정보로 추가)
 *
 * 오너 확인: **"통상 계산서 이메일에서 첨부파일을 열 때 우리 사업자번호를 비밀번호로 쓴다."**
 *
 * 이건 첨부가 국세청 표준 XML(평문)이 **아닐 가능성**을 강하게 시사한다 — 암호를 거는 건
 * 통상 PDF 나 ZIP 이다. 즉 XML 파싱을 본선으로 잡은 최초 설계의 전제가 흔들린다.
 *
 * 그렇다고 **추측으로 PDF 파서를 붙이지 않는다.** 대신 첨부의 정체를 매직바이트로 분류해
 * 보고하고, 실물 관측 뒤에 무엇을 만들지 정한다. 판별은 파일명·MIME 을 믿지 않는다 —
 * 발행처가 `.pdf` 를 `application/octet-stream` 으로 붙이는 일이 흔하다.
 *
 * ⚠️ **암호화 판정은 "의심"이지 단정이 아니다.** 우리는 파일을 복호화해 보지 않으므로
 * 확정할 수 없다. 이름에 `SUSPECTED` 를 남긴 이유이고, 화면·문서도 그렇게 말해야 한다.
 */

export type AttachmentKind =
  /** 국세청/KEC 표준 세금계산서 XML 로 파싱 성공 */
  | "ETAX_XML"
  /** XML 로 보이는데 표준 계산서가 아니거나 파싱 실패 */
  | "XML_UNRECOGNIZED"
  /** PDF (암호 없음으로 보임) */
  | "PDF"
  /** PDF 인데 암호화 사전(`/Encrypt`)이 있다 — 열려면 비밀번호가 필요하다 */
  | "PDF_ENCRYPTED_SUSPECTED"
  /** ZIP (암호 없음으로 보임) */
  | "ZIP"
  /** ZIP 인데 로컬 헤더의 암호화 플래그가 서 있다 */
  | "ZIP_ENCRYPTED_SUSPECTED"
  /**
   * 국세청 홈택스 **보안메일 HTML**. 표준 XML 이 이 안에 암호화돼 들어 있다.
   * 실측상 계산서 메일의 **주 경로**이므로 `OTHER` 로 뭉뚱그리면 census 가 무의미해진다.
   */
  | "NTS_SECURE_MAIL_HTML"
  /** 엑셀 계열(xlsx 는 ZIP 컨테이너라 별도 판별) */
  | "XLSX"
  /** 그 외 */
  | "OTHER";

function startsWithBytes(buffer: Buffer, bytes: readonly number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46] as const; // %PDF
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const; // PK\x03\x04

/**
 * ZIP 로컬 파일 헤더의 general purpose bit flag(오프셋 6~7) **bit 0** 이 암호화 표시다.
 * 표준 ZIP 구조라 이 판정은 신뢰도가 높다(내용 복호화 없이 플래그만 읽는다).
 */
function isZipEncrypted(buffer: Buffer): boolean {
  if (buffer.length < 8) return false;
  const flags = buffer.readUInt16LE(6);
  return (flags & 0x0001) !== 0;
}

/**
 * PDF 는 트레일러에 `/Encrypt` 참조가 있으면 암호화된 문서다.
 * 전체를 훑지 않고 **끝쪽 32KB** 만 본다 — 트레일러가 그쪽에 있고, 큰 첨부에서 비용을 아낀다.
 * ⚠️ 본문 스트림에 우연히 같은 문자열이 있을 수 있어 **의심**으로만 쓴다.
 */
function isPdfEncrypted(buffer: Buffer): boolean {
  const tailStart = Math.max(0, buffer.length - 32_768);
  return buffer.subarray(tailStart).includes("/Encrypt");
}

export interface AttachmentDescription {
  kind: AttachmentKind;
  /** 열려면 비밀번호가 필요해 보이는가 — 화면이 오너에게 안내할 근거 */
  passwordSuspected: boolean;
}

/**
 * 첨부 1개의 정체를 판별한다. **내용을 해석하지 않는다** — 겉모습만 본다.
 *
 * `etaxParsed` 는 호출부가 이미 표준 XML 파싱을 시도한 결과다(성공 여부만 받는다).
 * 파싱 로직을 여기서 다시 부르지 않는 이유는, 이 함수가 **파싱과 무관하게** 정체를
 * 말할 수 있어야 census 로서 값어치가 있기 때문이다.
 */
export function describeAttachment(
  content: Buffer,
  filename: string | null,
  etaxParsed: boolean,
): AttachmentDescription {
  if (etaxParsed) return { kind: "ETAX_XML", passwordSuspected: false };

  const lowerName = (filename ?? "").toLowerCase();

  if (startsWithBytes(content, PDF_MAGIC)) {
    const encrypted = isPdfEncrypted(content);
    return {
      kind: encrypted ? "PDF_ENCRYPTED_SUSPECTED" : "PDF",
      passwordSuspected: encrypted,
    };
  }

  if (startsWithBytes(content, ZIP_MAGIC)) {
    const encrypted = isZipEncrypted(content);
    if (encrypted) return { kind: "ZIP_ENCRYPTED_SUSPECTED", passwordSuspected: true };
    // xlsx·docx 는 ZIP 컨테이너다 — 확장자로만 구분 가능하다.
    if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls")) {
      return { kind: "XLSX", passwordSuspected: false };
    }
    return { kind: "ZIP", passwordSuspected: false };
  }

  // 매직바이트가 없다 — XML 로 보이는지 내용 앞머리로 판단한다(BOM·공백 허용).
  const head = content.subarray(0, 512).toString("utf8").trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<")) {
    return { kind: "XML_UNRECOGNIZED", passwordSuspected: false };
  }

  return { kind: "OTHER", passwordSuspected: false };
}
