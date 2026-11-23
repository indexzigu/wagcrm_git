/**
 * 브랜드 정산 메일 첨부(.xls BIFF8)의 **「피벗」 시트만** 읽는 순수 모듈(봇 정산 대조 v1).
 *
 * v1 은 .xls(CFB) 만 받는다 — 브랜드가 보내는 첨부가 BIFF8 이다. .xlsx·ods 등 ZIP 표는 읽지 않고 「못 읽음」으로
 * 센다(코드 리뷰 2026-11-23: ZIP 해제에 출력 상한이 없어 압축 폭탄 위험 · ods 해석기는 시트 지정을 무시한다).
 *
 * 첨부에는 시트가 셋 있다(오너 메일함 실측 2026-11-23): 정산내역서(본문과 같은 표) · 피벗(네이버 옵션 글자 그대로의
 * 옵션명·수량·총판매가) · 발주서(주문마다 **구매자 이름·연락처·주소**). 이 모듈이 내보내는 것은 피벗의
 * 「옵션명·수량」 두 칸뿐이다.
 *
 * ## ⛔ 발주서 시트는 해석하지 않는다 — 그런데 라이브러리 옵션으로는 막을 수 없었다
 *
 * `XLSX.read(…, { sheets: [이름] })` 는 .xls 에서 듣지 않는다. xlsx@0.18.5 의 BIFF8(.xls) 해석기는 이 옵션을
 * 보지 않고 모든 시트의 셀을 객체로 만든다(2026-11-23 합성 파일로 실측 — 세 시트가 다 만들어지고 직렬화에 가짜
 * 구매자 이름이 그대로 나왔다). 그래서 .xls 는 **읽기 전에 스트림을 잘라** 피벗 시트만 남긴다:
 *  1. CFB 컨테이너에서 Workbook 스트림을 꺼낸다(다른 스트림 — 문서 속성 등 — 은 넘기지 않는다).
 *  2. 전역 구간(첫 BOF ~ 짝 EOF)을 레코드 단위로 훑어 BoundSheet8(시트 이름·시작 위치)을 모은다. 암호 레코드
 *     (FILEPASS)가 있으면 그 자리에서 「못 읽음」.
 *  3. 새 스트림 = 전역 구간 + 피벗 시트 구간. 해석기는 시트 구간을 BoundSheet8 의 시작 위치로 이름에 잇는다
 *     (`Directory[pos]`) — 그래서 피벗의 시작 위치를 새 자리(전역 구간 끝)로 고쳐 쓰고, 나머지 시트의 시작 위치는
 *     스트림 밖 값으로 바꿔 어느 구간에도 이어지지 않게 한다(레코드 길이는 그대로라 전역 구간의 다른 위치가 안 밀린다).
 *  4. 그 스트림만 `XLSX.read` 에 넣는다 — 발주서 시트의 셀 레코드는 해석기에 **도달하지 않는다**.
 * ⚠️ 엑셀이 만든 파일은 글자를 통합 문자열 표(SST, 전역 구간)에 모아 두므로 구매자 이름 **글자**는 그 표째 메모리에
 *    풀린다 — 이건 어떤 방법으로도 못 피한다(피벗 옵션명도 같은 표에 있다). 그 표는 어느 셀에도 이어지지 않고, 이
 *    함수는 워크북을 돌려주지 않으며 함수가 끝나면 버려진다. 호출부가 받는 것은 옵션명·수량 줄뿐이다.
 *
 * ## ⛔ 실패 문구는 고정 낱말이다
 * 셀 값·시트 이름·파일 이름·라이브러리 오류 문구를 결과에 싣지 않는다 — 라이브러리 오류 문구에는 셀 값이 섞일 수
 * 있다. 결과는 코드 두 개(`ATTACHMENT_UNREADABLE` · `SHEET_LAYOUT_CHANGED`)뿐이다. console.* 도 쓰지 않는다.
 */
import * as XLSX from "xlsx";
import { normalizeForCompare, toNfc } from "../text-normalize";

/** 피벗 시트 이름(오너 메일함 실측). 비교는 NFC + 앞뒤 공백 제거 뒤 정확 일치. */
export const PIVOT_SHEET_NAME = "피벗";
/** 머리 행(옵션명·수량)을 찾는 범위 — 이 안에 없으면 양식이 바뀐 것으로 본다. */
export const PIVOT_HEADER_SCAN_ROWS = 15;
/** 피벗 한 표의 줄 수 상한 — 넘으면 양식이 바뀐 것으로 본다(옵션이 이렇게 많은 공구는 없다). */
export const MAX_PIVOT_ROWS = 500;
/** 첨부 크기 상한(메일 스캔과 같은 값을 쓴다). */
export const MAX_STATEMENT_ATTACHMENT_BYTES = 2 * 1024 * 1024;

export type PivotRow = { label: string; qty: number };

export type PivotReadFailureCode = "ATTACHMENT_UNREADABLE" | "SHEET_LAYOUT_CHANGED";

export type PivotReadResult = { ok: true; rows: PivotRow[] } | { ok: false; code: PivotReadFailureCode };

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

const RT_BOF = 0x0809;
const RT_EOF = 0x000a;
const RT_BOUNDSHEET8 = 0x0085;
const RT_FILEPASS = 0x002f;

function startsWith(buffer: Buffer, bytes: readonly number[]): boolean {
  return buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);
}

class PivotReadError extends Error {
  constructor(readonly code: PivotReadFailureCode) {
    // 고정 문구 — 셀 값·이름을 싣지 않는다.
    super(code);
  }
}

function fail(code: PivotReadFailureCode): never {
  throw new PivotReadError(code);
}

function sameSheetName(name: string): boolean {
  return toNfc(name).trim() === PIVOT_SHEET_NAME;
}

type BoundSheet = { recordOffset: number; pos: number; name: string };

/** BoundSheet8 의 ShortXLUnicodeString(글자 수 1바이트 · 플래그 1바이트 · 글자) — 시트 이름. */
function readBoundSheetName(stream: Buffer, payloadStart: number, payloadEnd: number): string {
  const cch = stream[payloadStart + 6];
  const highByte = (stream[payloadStart + 7] & 0x01) === 1;
  const start = payloadStart + 8;
  const end = start + (highByte ? cch * 2 : cch);
  if (end > payloadEnd) fail("ATTACHMENT_UNREADABLE");
  return highByte ? stream.toString("utf16le", start, end) : stream.toString("latin1", start, end);
}

/** BOF ~ 짝 EOF 구간의 끝 위치(EOF 레코드 다음). 안쪽 BOF(차트 등)는 깊이로 넘긴다. */
function substreamEnd(stream: Buffer, start: number): number {
  let offset = start;
  let depth = 0;
  while (offset + 4 <= stream.length) {
    const type = stream.readUInt16LE(offset);
    const length = stream.readUInt16LE(offset + 2);
    const next = offset + 4 + length;
    if (next > stream.length) fail("ATTACHMENT_UNREADABLE");
    if (type === RT_BOF) depth += 1;
    if (type === RT_EOF) {
      depth -= 1;
      if (depth === 0) return next;
    }
    offset = next;
  }
  return fail("ATTACHMENT_UNREADABLE");
}

/**
 * Workbook 스트림 → 「전역 구간 + 피벗 시트 구간」 스트림(머리 주석 1~3). 피벗 시트가 없으면 SHEET_LAYOUT_CHANGED.
 * 시트 이름 목록은 `bookSheets` 로 따로 읽어 이 훑기 결과와 맞는지 본다 — 두 해석이 갈리면 손대지 않는다.
 */
export function buildPivotOnlyBiffStream(workbookStream: Buffer, expectedSheetNames: readonly string[]): Buffer {
  const stream = workbookStream;
  if (stream.length < 4 || stream.readUInt16LE(0) !== RT_BOF) fail("ATTACHMENT_UNREADABLE");
  const sheets: BoundSheet[] = [];
  let offset = 0;
  let depth = 0;
  let globalsEnd = -1;
  while (offset + 4 <= stream.length) {
    const type = stream.readUInt16LE(offset);
    const length = stream.readUInt16LE(offset + 2);
    const payloadStart = offset + 4;
    const next = payloadStart + length;
    if (next > stream.length) fail("ATTACHMENT_UNREADABLE");
    if (type === RT_BOF) depth += 1;
    // 암호가 걸린 통합 문서 — 복호하지 않는다(라이브러리의 기본 암호 시도도 타지 않게 여기서 멈춘다).
    if (type === RT_FILEPASS) fail("ATTACHMENT_UNREADABLE");
    if (type === RT_BOUNDSHEET8) {
      if (length < 8) fail("ATTACHMENT_UNREADABLE");
      sheets.push({
        recordOffset: offset,
        pos: stream.readUInt32LE(payloadStart),
        name: readBoundSheetName(stream, payloadStart, next),
      });
    }
    if (type === RT_EOF) {
      depth -= 1;
      if (depth === 0) {
        globalsEnd = next;
        break;
      }
    }
    offset = next;
  }
  if (globalsEnd < 0 || sheets.length === 0) fail("ATTACHMENT_UNREADABLE");
  if (
    sheets.length !== expectedSheetNames.length ||
    sheets.some((sheet, index) => toNfc(sheet.name) !== toNfc(expectedSheetNames[index] ?? ""))
  ) {
    fail("ATTACHMENT_UNREADABLE");
  }
  const pivots = sheets.filter((sheet) => sameSheetName(sheet.name));
  if (pivots.length !== 1) fail("SHEET_LAYOUT_CHANGED");
  const pivot = pivots[0];
  if (pivot.pos < globalsEnd || pivot.pos + 4 > stream.length || stream.readUInt16LE(pivot.pos) !== RT_BOF) {
    fail("ATTACHMENT_UNREADABLE");
  }
  const pivotEnd = substreamEnd(stream, pivot.pos);

  const globals = Buffer.from(stream.subarray(0, globalsEnd));
  sheets.forEach((sheet, index) => {
    // 피벗은 전역 구간 바로 뒤로, 나머지는 스트림 밖(서로 다른 값 — 해석기가 위치로 이름을 묶는다)으로.
    const pos = sheet === pivot ? globalsEnd : (0xffffff00 + index) >>> 0;
    globals.writeUInt32LE(pos, sheet.recordOffset + 4);
  });
  return Buffer.concat([globals, stream.subarray(pivot.pos, pivotEnd)]);
}

type Grid = unknown[][];

/**
 * 첨부가 엑셀 통합 문서 컨테이너인가 — CFB 이고 안에 Workbook(또는 옛 Book) 스트림이 있다. 같은 CFB 껍데기를 쓰는
 * .doc·.hwp·.msg 를 표로 세지 않으려고(메일 스캔이 부른다). 디렉터리만 보고 셀은 읽지 않는다. 판정 불가는 false.
 */
export function isWorkbookContainer(content: Buffer): boolean {
  if (!startsWith(content, CFB_MAGIC)) return false;
  try {
    const container = XLSX.CFB.read(content, { type: "buffer" });
    return Boolean(XLSX.CFB.find(container, "/Workbook") ?? XLSX.CFB.find(container, "/Book"));
  } catch {
    return false;
  }
}

function pivotGridFromBiff(content: Buffer): Grid {
  const names = XLSX.read(content, { type: "buffer", bookSheets: true }).SheetNames ?? [];
  if (!names.some(sameSheetName)) fail("SHEET_LAYOUT_CHANGED");
  const container = XLSX.CFB.read(content, { type: "buffer" });
  const entry = XLSX.CFB.find(container, "/Workbook") ?? XLSX.CFB.find(container, "/Book");
  if (!entry?.content) fail("ATTACHMENT_UNREADABLE");
  const pivotOnly = buildPivotOnlyBiffStream(Buffer.from(entry.content as Uint8Array), names);
  const workbook = XLSX.read(pivotOnly, { type: "buffer", cellFormula: false, cellHTML: false, cellStyles: false });
  // 피벗 말고 다른 시트가 만들어졌으면 자르기가 실패한 것이다 — 읽지 않고 멈춘다.
  const built = Object.keys(workbook.Sheets ?? {});
  if (built.length !== 1 || !sameSheetName(built[0])) fail("ATTACHMENT_UNREADABLE");
  return XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[built[0]], { header: 1, raw: true, defval: null });
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return toNfc(value).trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** 수량 한 칸의 상한 — 출력 스키마의 개수 상한과 같다(넘으면 그 자리에서 양식 변경으로 멈춘다). */
export const MAX_PIVOT_QTY = 1_000_000;

/** 수량 칸 — 0 이상 정수만(상한 이하). 소수·지수 표기·글자·상한 초과는 양식이 바뀐 것으로 본다. */
function readQty(value: unknown): number {
  let qty: number | null = null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) qty = value;
  else if (typeof value === "string" && /^\d{1,9}$/.test(value.trim())) qty = Number(value.trim());
  if (qty === null || qty > MAX_PIVOT_QTY) return fail("SHEET_LAYOUT_CHANGED");
  return qty;
}

const isTotalRow = (text: string) => normalizeForCompare(text) === "총합계";

/**
 * 그리드 → 옵션 줄. 머리 행(「옵션명」이 든 칸과 「수량」이 든 칸)을 앞 15행 안에서 찾고, 그 아래를 「총합계」 행까지
 * 읽는다. ⚠️ 시트 아래쪽에 같은 표의 사본(작은 글씨)이 한 벌 더 있다 — 첫 「총합계」에서 멈춰야 두 번 세지 않는다.
 * 총합계 수량이 줄 합계와 다르면 양식이 바뀐 것으로 본다(표 경계를 잘못 읽은 신호).
 */
export function parsePivotGrid(grid: Grid): PivotRow[] {
  let headerRow = -1;
  let labelCol = -1;
  let qtyCol = -1;
  for (let r = 0; r < Math.min(grid.length, PIVOT_HEADER_SCAN_ROWS); r += 1) {
    const cells = (grid[r] ?? []).map(cellText).map(normalizeForCompare);
    const label = cells.findIndex((text) => text.includes("옵션명"));
    const qty = cells.findIndex((text, index) => index !== label && text.includes("수량"));
    if (label >= 0 && qty >= 0) {
      headerRow = r;
      labelCol = label;
      qtyCol = qty;
      break;
    }
  }
  if (headerRow < 0) fail("SHEET_LAYOUT_CHANGED");

  const byLabel = new Map<string, PivotRow>();
  let sum = 0;
  for (let r = headerRow + 1; r < grid.length; r += 1) {
    const row = grid[r] ?? [];
    const label = cellText(row[labelCol]);
    const firstFilled = row.map(cellText).find((text) => text !== "") ?? "";
    if (isTotalRow(label) || isTotalRow(firstFilled)) {
      const total = row[qtyCol];
      if (total !== null && total !== undefined && cellText(total) !== "" && readQty(total) !== sum) {
        fail("SHEET_LAYOUT_CHANGED");
      }
      return [...byLabel.values()];
    }
    const qtyCell = row[qtyCol];
    const hasQty = qtyCell !== null && qtyCell !== undefined && cellText(qtyCell) !== "";
    if (label === "") {
      if (hasQty) fail("SHEET_LAYOUT_CHANGED");
      continue;
    }
    if (!hasQty) fail("SHEET_LAYOUT_CHANGED");
    const qty = readQty(qtyCell);
    sum += qty;
    const existing = byLabel.get(label);
    if (existing) existing.qty += qty;
    else byLabel.set(label, { label, qty });
    if (byLabel.size > MAX_PIVOT_ROWS) fail("SHEET_LAYOUT_CHANGED");
  }
  // 총합계 행이 없으면 표 끝을 확신할 수 없다.
  return fail("SHEET_LAYOUT_CHANGED");
}

/**
 * 첨부 한 개 → 피벗 옵션 줄. .xls(CFB)만 받는다 — ZIP(.xlsx·ods)·그 밖은 ATTACHMENT_UNREADABLE. 어떤 예외도 고정
 * 코드로만 바뀐다. 암호가 걸린 파일: .xls 는 FILEPASS 레코드, 암호 .xlsx 는 CFB 안의 암호 스트림(EncryptionInfo)으로
 * 나타난다 — 둘 다 「못 읽음」이다(복호하지 않는다).
 */
export function readStatementPivot(content: Buffer): PivotReadResult {
  try {
    if (content.length === 0 || content.length > MAX_STATEMENT_ATTACHMENT_BYTES) return { ok: false, code: "ATTACHMENT_UNREADABLE" };
    if (!startsWith(content, CFB_MAGIC)) return { ok: false, code: "ATTACHMENT_UNREADABLE" };
    const container = XLSX.CFB.read(content, { type: "buffer" });
    const encrypted = XLSX.CFB.find(container, "/EncryptionInfo") ?? XLSX.CFB.find(container, "/EncryptedPackage");
    if (encrypted) return { ok: false, code: "ATTACHMENT_UNREADABLE" };
    return { ok: true, rows: parsePivotGrid(pivotGridFromBiff(content)) };
  } catch (error) {
    // 라이브러리 예외 문구는 버린다(셀 값이 섞일 수 있다).
    return { ok: false, code: error instanceof PivotReadError ? error.code : "ATTACHMENT_UNREADABLE" };
  }
}
