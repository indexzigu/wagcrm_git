/**
 * 국세청/KEC 표준 전자세금계산서 XML 파서 (순수 함수).
 *
 * ## 스키마 근거 (실샘플 대조 확인, 2026-08-03)
 *
 * 루트 `<TaxInvoice>` · 네임스페이스
 * `urn:kr:or:kec:standard:Tax:ReusableAggregateBusinessInformationEntitySchemaModule:1:0`.
 * 아래 경로는 국세청 전자세금계산서 검증 샘플(`ruseel/kr-etax-sample` 의
 * `src/main/resources/unsigned.xml`)의 실제 문서로 확인했다 — 기억으로 지어낸 것이 아니다.
 *
 * | 우리가 필요한 값 | 경로 |
 * | --- | --- |
 * | 작성일자 | `TaxInvoiceDocument/IssueDateTime` (8자리 `yyyyMMdd`) |
 * | 승인번호 | `TaxInvoiceDocument/IssueID` |
 * | 공급자(상대) 사업자번호 | `TaxInvoiceTradeSettlement/InvoicerParty/ID` |
 * | 공급받는자(우리) 사업자번호 | `TaxInvoiceTradeSettlement/InvoiceeParty/ID` |
 * | 공급가액 | `TaxInvoiceTradeSettlement/SpecifiedMonetarySummation/ChargeTotalAmount` |
 * | 세액 | `…/SpecifiedMonetarySummation/TaxTotalAmount` |
 * | 합계 | `…/SpecifiedMonetarySummation/GrandTotalAmount` |
 *
 * ## ⛔ 정규식으로 뽑지 말 것 — 같은 태그명이 여러 스코프에 있다
 *
 * - `IssueDateTime` 은 `ExchangedDocument`(**전송일시**, 14자리)에도 있다. 첫 매치를 집으면
 *   오너가 확인하려는 **작성일자 대신 전송일시**를 읽고, 그 오류는 8자리/14자리 길이 차이로만
 *   드러나 조용히 지나간다.
 * - `ID` 는 `ExchangedDocument`·`InvoicerParty`·`InvoiceeParty` 세 곳에 있다. 스코프 없이
 *   집으면 **"우리 앞으로 발행된 계산서인가"** 라는 이 기능의 1차 관문 자체가 성립하지 않는다.
 *
 * 그래서 경로 기반으로 읽는다. 네임스페이스 접두사(`ns:TaxInvoice`)는 무시한다 — 발행처마다
 * 접두사를 다르게 붙일 수 있고, 우리가 쓰는 것은 지역명(local name)뿐이다.
 *
 * ## 인코딩
 *
 * 표준 샘플은 UTF-8 이지만 EUC-KR 선언을 본 적이 없다고 단정할 수는 없다. UTF-8 이 아닌
 * 인코딩이 선언되면 **한글 이름만 깨지고 숫자·사업자번호는 ASCII 라 온전**하므로, 파싱을
 * 중단하지 않고 `declaredEncoding` 을 실어 호출부가 이름 값을 신뢰하지 않게 한다
 * (P0 No Silent Failure — 조용히 깨진 문자열을 정상값처럼 돌려주지 않는다).
 */

export interface EtaxAmounts {
  /** 공급가액 */
  supplyAmount: number | null;
  /** 세액 */
  taxAmount: number | null;
  /** 합계(공급가액 + 세액) */
  totalAmount: number | null;
}

/**
 * 계산서 1줄(품목). **금액만으로는 대조가 끝나지 않는다**는 실측에서 나왔다(2026-08-05).
 *
 * 실제 발행에서 관측된 세 패턴은 전부 금액으로 판별 불가였다:
 * ① 통과 광고비가 **계산서에만** 실린다(CRM 에 그 칸이 없다 — 오너 확인, 정상 상태)
 * ② 여러 회차를 한 장에 묶거나 한 건을 두 장으로 쪼갠다
 * ③ 계산서의 회차 번호가 CRM 회차와 어긋난다(시기로도 못 가른다)
 *
 * 품목명에는 셀러·딜·회차·월이 **사람이 읽는 형태로** 들어 있어 캠페인 특정에 직접 쓰인다.
 *
 * ⛔ **품목명에는 셀러 실명·상호가 들어간다** — 로그·추적 파일·커밋·PR 본문에 남기지 말 것
 * (P0 공개 레포). `ScannedTaxMail.subject` 와 같은 등급으로 다룬다.
 */
export interface EtaxLineItem {
  /** 일련번호(`SequenceNumeric`). 없으면 null. */
  sequence: number | null;
  /** 품목명. 인코딩을 신뢰할 수 없으면 null(깨진 문자열을 정상값으로 돌려주지 않는다). */
  name: string | null;
  quantity: number | null;
  unitPrice: number | null;
  /** 이 줄의 공급가액(`InvoiceAmount`) */
  supplyAmount: number | null;
  /** 이 줄의 세액(`TotalTax/CalculatedAmount`) */
  taxAmount: number | null;
}

export interface ParsedEtaxInvoice {
  /** 국세청 승인번호(`TaxInvoiceDocument/IssueID`) — 중복 발행 판정의 키 */
  issueId: string | null;
  /** 계산서 종류 코드. **확인된 값은 `0101`(일반) 하나뿐**이다 — 그 외는 호출부가 보류 처리한다. */
  typeCode: string | null;
  /** 영수/청구 구분 코드(`01`/`02`로 관측). 판정에 쓰지 않고 표시용으로만 싣는다. */
  purposeCode: string | null;
  /** 작성일자 `YYYY-MM-DD`. 파싱 불가면 null. */
  writtenDate: string | null;
  /** 공급자 = 계산서를 **발행한 상대**의 사업자등록번호(숫자 10자리) */
  invoicerBusinessNumber: string | null;
  invoicerName: string | null;
  /** 공급받는자 = **우리**여야 하는 사업자등록번호(숫자 10자리) */
  invoiceeBusinessNumber: string | null;
  invoiceeName: string | null;
  amounts: EtaxAmounts;
  /** 품목 줄. 없으면 빈 배열(= 줄이 없다)이고 null 을 쓰지 않는다. */
  lineItems: EtaxLineItem[];
  /** XML 선언의 encoding. UTF-8 이 아니면 이름 계열 값은 신뢰할 수 없다. */
  declaredEncoding: string | null;
}

// ─────────────────────────────────────────────
// 최소 XML 트리 파서
// ─────────────────────────────────────────────

interface XmlNode {
  /** 네임스페이스 접두사를 제거한 지역명 */
  name: string;
  children: XmlNode[];
  text: string;
}

/** `<ns:Foo>` → `Foo`. 접두사는 발행처마다 다를 수 있으므로 지역명만 쓴다. */
function localName(raw: string): string {
  const colon = raw.indexOf(":");
  return colon === -1 ? raw : raw.slice(colon + 1);
}

/**
 * 태그 트리를 만든다. 속성은 쓰지 않으므로 버린다.
 *
 * 닫는 태그가 어긋난 문서(발행처 버그·전송 절단)는 **throw 하지 않고** 지금까지 만든 트리를
 * 돌려준다 — 뒤가 잘려도 앞의 사업자번호·금액은 읽히기 때문이다. 값이 비면 그 자체가 판정
 * 근거(`NEEDS_REVIEW`)가 되므로 삼키는 것이 아니다.
 */
function parseXmlTree(source: string): XmlNode {
  const root: XmlNode = { name: "#root", children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;

  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt === -1) break;

    // 태그 앞의 텍스트는 현재 노드에 붙인다.
    if (lt > i) {
      stack[stack.length - 1].text += source.slice(i, lt);
    }

    // 주석 · CDATA · 선언 · 처리 명령
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt);
      const body = source.slice(lt + 9, end === -1 ? source.length : end);
      stack[stack.length - 1].text += body;
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<?", lt) || source.startsWith("<!", lt)) {
      const end = source.indexOf(">", lt);
      i = end === -1 ? source.length : end + 1;
      continue;
    }

    // 속성값 안의 '>' 에 속지 않도록 따옴표 상태를 추적하며 태그 끝을 찾는다.
    let gt = -1;
    let quote: string | null = null;
    for (let k = lt + 1; k < source.length; k += 1) {
      const ch = source[k];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        gt = k;
        break;
      }
    }
    if (gt === -1) break;

    const inner = source.slice(lt + 1, gt).trim();

    if (inner.startsWith("/")) {
      const closing = localName(inner.slice(1).trim());
      // 짝이 맞는 가장 가까운 노드까지 되감는다(어긋난 문서에서 트리가 통째로 무너지지 않게).
      for (let s = stack.length - 1; s > 0; s -= 1) {
        if (stack[s].name === closing) {
          stack.length = s;
          break;
        }
      }
    } else {
      const selfClosing = inner.endsWith("/");
      const body = selfClosing ? inner.slice(0, -1) : inner;
      const nameEnd = body.search(/[\s/]/);
      const name = localName(nameEnd === -1 ? body : body.slice(0, nameEnd));
      const node: XmlNode = { name, children: [], text: "" };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
    }

    i = gt + 1;
  }

  return root;
}

/** 경로(지역명 배열)를 따라 **첫 번째** 노드를 찾는다. 스코프를 강제하는 것이 이 함수의 존재 이유다. */
function pickNode(node: XmlNode, path: readonly string[]): XmlNode | null {
  let current: XmlNode | undefined = node;
  for (const segment of path) {
    current = current?.children.find((child) => child.name === segment);
    if (!current) return null;
  }
  return current ?? null;
}

/** 같은 이름의 형제를 **전부** 찾는다(품목 줄은 반복된다). */
function pickAll(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

function pickText(node: XmlNode, path: readonly string[]): string | null {
  const found = pickNode(node, path);
  if (!found) return null;
  const value = decodeEntities(found.text).trim();
  return value.length > 0 ? value : null;
}

function decodeEntities(raw: string): string {
  return raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

// ─────────────────────────────────────────────
// 값 정규화
// ─────────────────────────────────────────────

/** 하이픈·공백을 제거하고 숫자 10자리일 때만 돌려준다. 10자리가 아니면 신뢰할 수 없는 값이다. */
export function normalizeEtaxBusinessNumber(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length === 10 ? digits : null;
}

/**
 * `yyyyMMdd`(작성일자) 또는 `yyyyMMddHHmmss`(전송일시)를 `YYYY-MM-DD` 로 정규화한다.
 * 하이픈이 섞인 표기(`2026-08-03`)도 받는다.
 */
export function normalizeEtaxDate(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8) return null;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  if (year < 2000 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

/** 금액. 콤마·공백을 제거한다. 음수·비수치는 null(= 모름)로 둔다 — 0 으로 만들지 않는다. */
function parseAmount(raw: string | null): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

const DOC = "TaxInvoiceDocument";
const SETTLEMENT = "TaxInvoiceTradeSettlement";
/**
 * 품목 줄. `TaxInvoice` **바로 아래**에 반복되는 형제다(실계산서 경로 실측 2026-08-05).
 *
 * ⛔ 정규식으로 `NameText` 를 훑지 말 것 — 같은 태그가
 * `InvoicerParty/NameText`(공급자 상호) · `InvoicerParty/SpecifiedPerson/NameText`(대표자명) ·
 * `InvoiceeParty/…` 에도 있어서, 스코프 없이 집으면 **상호·대표자명이 품목명으로 섞여
 * 들어온다.** 이 파일 첫머리의 `ID`·`IssueDateTime` 경고와 정확히 같은 함정이다.
 */
const LINE_ITEM = "TaxInvoiceTradeLineItem";

/** XML 선언에서 encoding 을 읽는다(선언이 없으면 null = UTF-8 가정). */
function readDeclaredEncoding(source: string): string | null {
  const match = /<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(source.slice(0, 200));
  return match ? match[1].toUpperCase() : null;
}

/**
 * 표준 전자세금계산서 XML 을 파싱한다.
 *
 * 루트가 `TaxInvoice` 가 아니면 **null** 을 돌려준다 — 첨부가 계산서가 아닌 경우(발주서·안내문)를
 * 억지로 해석하지 않기 위해서다. 루트는 맞는데 필드가 비는 것은 별개이고, 그때는 null 필드를
 * 그대로 실어 보내 호출부가 「확인 필요」로 표면화한다.
 */
export function parseEtaxInvoiceXml(input: string | Buffer): ParsedEtaxInvoice | null {
  const source = typeof input === "string" ? input : input.toString("utf8");
  if (!source.includes("<")) return null;

  const tree = parseXmlTree(source);
  const invoice = tree.children.find((child) => child.name === "TaxInvoice");
  if (!invoice) return null;

  const declared = readDeclaredEncoding(source);
  const trustNames = declared === null || declared === "UTF-8" || declared === "UTF8";

  return {
    issueId: pickText(invoice, [DOC, "IssueID"]),
    typeCode: pickText(invoice, [DOC, "TypeCode"]),
    purposeCode: pickText(invoice, [DOC, "PurposeCode"]),
    // ⚠️ ExchangedDocument/IssueDateTime(전송일시)이 아니라 TaxInvoiceDocument 스코프여야 한다.
    writtenDate: normalizeEtaxDate(pickText(invoice, [DOC, "IssueDateTime"])),
    invoicerBusinessNumber: normalizeEtaxBusinessNumber(
      pickText(invoice, [SETTLEMENT, "InvoicerParty", "ID"]),
    ),
    invoicerName: trustNames ? pickText(invoice, [SETTLEMENT, "InvoicerParty", "NameText"]) : null,
    invoiceeBusinessNumber: normalizeEtaxBusinessNumber(
      pickText(invoice, [SETTLEMENT, "InvoiceeParty", "ID"]),
    ),
    invoiceeName: trustNames ? pickText(invoice, [SETTLEMENT, "InvoiceeParty", "NameText"]) : null,
    amounts: {
      supplyAmount: parseAmount(
        pickText(invoice, [SETTLEMENT, "SpecifiedMonetarySummation", "ChargeTotalAmount"]),
      ),
      taxAmount: parseAmount(
        pickText(invoice, [SETTLEMENT, "SpecifiedMonetarySummation", "TaxTotalAmount"]),
      ),
      totalAmount: parseAmount(
        pickText(invoice, [SETTLEMENT, "SpecifiedMonetarySummation", "GrandTotalAmount"]),
      ),
    },
    lineItems: pickAll(invoice, LINE_ITEM).map((item) => ({
      sequence: parseAmount(pickText(item, ["SequenceNumeric"])),
      // 인코딩을 못 믿으면 이름은 비운다 — 상호·대표자명과 같은 규칙이다.
      name: trustNames ? pickText(item, ["NameText"]) : null,
      quantity: parseAmount(pickText(item, ["ChargeableUnitQuantity"])),
      unitPrice: parseAmount(pickText(item, ["UnitPrice", "UnitAmount"])),
      supplyAmount: parseAmount(pickText(item, ["InvoiceAmount"])),
      taxAmount: parseAmount(pickText(item, ["TotalTax", "CalculatedAmount"])),
    })),
    declaredEncoding: declared,
  };
}
