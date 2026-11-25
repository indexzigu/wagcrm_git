/**
 * 정산 메일 첨부의 「피벗」 시트 읽기 — 합성 통합 문서만 쓴다(실물 첨부·바이너리 파일을 커밋하지 않는다).
 * 고정하는 것: ① 발주서 시트(가짜 구매자 정보)는 해석기에 닿지 않고 어떤 결과·실패에도 그 글자가 없다
 * ② 머리 행 위치·열 순서·NFD 시트 이름을 견딘다 ③ 아래쪽 사본 표를 두 번 세지 않는다 ④ 소수·지수 수량·머리 없음은
 * SHEET_LAYOUT_CHANGED ⑤ 암호 파일·깨진 파일은 ATTACHMENT_UNREADABLE.
 */
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  buildPivotOnlyBiffStream,
  isWorkbookContainer,
  MAX_STATEMENT_ATTACHMENT_BYTES,
  parsePivotGrid,
  readStatementPivot,
} from "./statement-pivot-xls";

const FAKE_PII = ["테스트구매자", "010-0000-0000", "가상시 가상로 1"] as const;

const PIVOT_GRID: unknown[][] = [
  ["정산 피벗"],
  [],
  ["옵션명", "합계 : 수량", "합계 : 총판매가"],
  ["구성: 3박스", 4, 120000],
  ["구성: 6박스", 2, 120000],
  ["총합계", 6, 240000],
  [],
  // 아래쪽 사본(작은 글씨) — 두 번 세면 안 된다.
  ["옵션명", "합계 : 수량", "합계 : 총판매가"],
  ["구성: 3박스", 4, 120000],
  ["구성: 6박스", 2, 120000],
  ["총합계", 6, 240000],
];

const ORDER_SHEET: unknown[][] = [
  ["주문일", "주문번호", "품목별 주문번호", "구매자", "연락처", "주소"],
  ["2026-10-01", "2026100100000001", "2026100100000011", FAKE_PII[0], FAKE_PII[1], FAKE_PII[2]],
];

function workbook(options: { pivot?: unknown[][]; pivotName?: string; order?: boolean; orderFirst?: boolean } = {}) {
  const wb = XLSX.utils.book_new();
  const pivot = XLSX.utils.aoa_to_sheet(options.pivot ?? PIVOT_GRID);
  const order = XLSX.utils.aoa_to_sheet(ORDER_SHEET);
  if (options.orderFirst) XLSX.utils.book_append_sheet(wb, order, "발주서");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["정산내역서"], ["합계", 240000]]), "정산내역서");
  XLSX.utils.book_append_sheet(wb, pivot, options.pivotName ?? "피벗");
  if (!options.orderFirst && options.order !== false) XLSX.utils.book_append_sheet(wb, order, "발주서");
  return wb;
}

function xls(options: Parameters<typeof workbook>[0] = {}, bookSST = false): Buffer {
  return XLSX.write(workbook(options), { bookType: "biff8", type: "buffer", bookSST }) as Buffer;
}


function workbookStream(content: Buffer): Buffer {
  const entry = XLSX.CFB.find(XLSX.CFB.read(content, { type: "buffer" }), "/Workbook");
  return Buffer.from(entry!.content as Uint8Array);
}

function cfbWith(streams: Record<string, Buffer>): Buffer {
  const container = XLSX.CFB.utils.cfb_new();
  for (const [name, data] of Object.entries(streams)) XLSX.CFB.utils.cfb_add(container, name, data);
  return Buffer.from(XLSX.CFB.write(container, { type: "buffer" }) as Uint8Array);
}

function expectNoPii(value: unknown) {
  const text = JSON.stringify(value);
  for (const pii of FAKE_PII) expect(text).not.toContain(pii);
}

const EXPECTED = [
  { label: "구성: 3박스", qty: 4 },
  { label: "구성: 6박스", qty: 2 },
];

describe("readStatementPivot — .xls (BIFF8)", () => {
  it("합성 파일에 가짜 구매자 정보가 실제로 들어 있다(양성 대조)", () => {
    const raw = xls();
    expect(raw.includes(Buffer.from(FAKE_PII[0], "utf16le"))).toBe(true);
    // 라이브러리 옵션만으로는 발주서가 해석된다 — 이 모듈이 스트림을 자르는 이유(실측 고정).
    const naive = XLSX.read(raw, { type: "buffer", sheets: ["피벗"] });
    expect(Object.keys(naive.Sheets)).toContain("발주서");
  });

  it("피벗 첫 표만 읽고(아래 사본은 세지 않는다) 옵션명·수량만 돌려준다", () => {
    const result = readStatementPivot(xls());
    expect(result).toEqual({ ok: true, rows: EXPECTED });
    expectNoPii(result);
  });

  it("발주서 시트는 해석기에 닿지 않는다 — 잘라 낸 스트림에는 피벗 시트만 만들어진다", () => {
    for (const bookSST of [false, true]) {
      const raw = xls({}, bookSST);
      const names = XLSX.read(raw, { type: "buffer", bookSheets: true }).SheetNames;
      const cut = buildPivotOnlyBiffStream(workbookStream(raw), names);
      const parsed = XLSX.read(cut, { type: "buffer" });
      expect(Object.keys(parsed.Sheets)).toEqual(["피벗"]);
      expectNoPii(parsed.Sheets);
      // 통합 문자열 표(SST)를 쓰는 파일은 글자가 전역 구간에 있다 — 표째 남지만 어느 셀에도 이어지지 않는다(머리 주석 ⚠️).
      // 글자를 셀에 바로 적는 파일은 잘라 낸 스트림에 그 바이트조차 없다.
      if (!bookSST) {
        for (const pii of FAKE_PII) {
          expect(raw.includes(Buffer.from(pii, "utf16le"))).toBe(true); // 양성 대조: 원본에는 있다
          expect(cut.includes(Buffer.from(pii, "utf16le"))).toBe(false);
        }
      }
      expectNoPii(readStatementPivot(raw));
    }
  });

  it("발주서가 피벗보다 앞에 있어도 피벗만 읽는다", () => {
    const result = readStatementPivot(xls({ orderFirst: true }));
    expect(result).toEqual({ ok: true, rows: EXPECTED });
    expectNoPii(result);
  });

  it("자모 분리(NFD) 시트 이름·옵션명도 찾는다 — 옵션명은 NFC 로 돌려준다", () => {
    const nfdGrid = PIVOT_GRID.slice(0, 6).map((row) =>
      row.map((cell) => (typeof cell === "string" ? cell.normalize("NFD") : cell)),
    );
    const result = readStatementPivot(xls({ pivotName: "피벗".normalize("NFD"), pivot: nfdGrid }));
    expect(result).toEqual({ ok: true, rows: EXPECTED });
  });

  it("피벗 시트가 없으면 SHEET_LAYOUT_CHANGED", () => {
    expect(readStatementPivot(xls({ pivotName: "요약" }))).toEqual({ ok: false, code: "SHEET_LAYOUT_CHANGED" });
  });

  it("암호 레코드(FILEPASS)가 있으면 ATTACHMENT_UNREADABLE — 복호를 시도하지 않는다", () => {
    const stream = workbookStream(xls());
    const bofLength = 4 + stream.readUInt16LE(2);
    const filePass = Buffer.from([0x2f, 0x00, 0x02, 0x00, 0x00, 0x00]);
    const locked = Buffer.concat([stream.subarray(0, bofLength), filePass, stream.subarray(bofLength)]);
    const result = readStatementPivot(cfbWith({ Workbook: locked }));
    expect(result).toEqual({ ok: false, code: "ATTACHMENT_UNREADABLE" });
  });

  it("암호가 걸린 .xlsx(CFB 안의 EncryptionInfo)도 ATTACHMENT_UNREADABLE", () => {
    const result = readStatementPivot(cfbWith({ EncryptionInfo: Buffer.from([1, 2, 3, 4]), EncryptedPackage: Buffer.alloc(16) }));
    expect(result).toEqual({ ok: false, code: "ATTACHMENT_UNREADABLE" });
  });

  it("깨진 시트 구간은 고정 코드로만 실패하고 어떤 글자도 싣지 않는다(예외 경로)", () => {
    const raw = xls();
    const stream = workbookStream(raw);
    // 피벗 시트 구간 한가운데에서 잘라 레코드 길이가 스트림을 넘게 만든다(BoundSheet8: 위치 4바이트 · 플래그 2 · 길이 2 · 이름).
    const nameAt = stream.indexOf(Buffer.from("피벗", "utf16le"));
    const pivotPos = stream.readUInt32LE(nameAt - 8);
    const corrupt = cfbWith({ Workbook: stream.subarray(0, pivotPos + 30) });
    const result = readStatementPivot(corrupt);
    expect(result.ok).toBe(false);
    expect(Object.keys(result).sort()).toEqual(["code", "ok"]);
    expectNoPii(result);
    // 아무 바이트나 — CFB 머리만 맞고 속은 엉망.
    const garbage = Buffer.concat([raw.subarray(0, 8), Buffer.alloc(600, 0x41)]);
    const garbageResult = readStatementPivot(garbage);
    expect(garbageResult).toEqual({ ok: false, code: "ATTACHMENT_UNREADABLE" });
  });

  it("발주서 구간이 깨져 있어도 피벗은 읽는다 — 그 구간은 읽지 않는다", () => {
    const stream = workbookStream(xls());
    const result = readStatementPivot(cfbWith({ Workbook: stream.subarray(0, stream.length - 7) }));
    expect(result).toEqual({ ok: true, rows: EXPECTED });
  });

  it("크기 상한을 넘거나 비었거나 표 파일이 아니면 ATTACHMENT_UNREADABLE", () => {
    expect(readStatementPivot(Buffer.alloc(0))).toEqual({ ok: false, code: "ATTACHMENT_UNREADABLE" });
    expect(readStatementPivot(Buffer.alloc(MAX_STATEMENT_ATTACHMENT_BYTES + 1))).toEqual({
      ok: false,
      code: "ATTACHMENT_UNREADABLE",
    });
    expect(readStatementPivot(Buffer.from("%PDF-1.7 ..."))).toEqual({ ok: false, code: "ATTACHMENT_UNREADABLE" });
  });
});

describe("readStatementPivot — ZIP 표(.xlsx·ods·xlsb)는 v1 에서 읽지 않는다", () => {
  it("모두 ATTACHMENT_UNREADABLE — 해석기에 넘기지 않는다(압축 폭탄 · ods 는 시트 지정을 무시)", () => {
    // 양성 대조: 라이브러리에 그대로 넘기면 ods 는 발주서까지 만든다.
    const ods = XLSX.write(workbook(), { bookType: "ods", type: "buffer" }) as Buffer;
    expect(Object.keys(XLSX.read(ods, { type: "buffer", sheets: ["피벗"] }).Sheets)).toContain("발주서");
    for (const bookType of ["xlsx", "ods", "xlsb"] as const) {
      const content = XLSX.write(workbook(), { bookType, type: "buffer" }) as Buffer;
      expect(content.subarray(0, 2).toString("latin1")).toBe("PK");
      const result = readStatementPivot(content);
      expect(result).toEqual({ ok: false, code: "ATTACHMENT_UNREADABLE" });
      expectNoPii(result);
    }
  });
});

describe("isWorkbookContainer", () => {
  it(".xls 는 표, 같은 CFB 껍데기의 다른 문서(.doc 류)·ZIP·깨진 바이트는 표가 아니다", () => {
    expect(isWorkbookContainer(xls())).toBe(true);
    expect(isWorkbookContainer(cfbWith({ WordDocument: Buffer.alloc(64, 1) }))).toBe(false);
    expect(isWorkbookContainer(XLSX.write(workbook(), { bookType: "xlsx", type: "buffer" }) as Buffer)).toBe(false);
    expect(isWorkbookContainer(Buffer.concat([xls().subarray(0, 8), Buffer.alloc(100, 0x41)]))).toBe(false);
  });
});

describe("parsePivotGrid", () => {
  it("머리 행이 첫 행이 아니고 열 순서가 바뀌어도 읽는다", () => {
    const grid = [[], ["메모"], [null, "합계 : 총판매가", "합계 : 수량", "옵션명"], [null, 1, 3, "가"], [null, 2, 5, "나"], [null, 3, 8, "총합계"]];
    expect(parsePivotGrid(grid)).toEqual([
      { label: "가", qty: 3 },
      { label: "나", qty: 5 },
    ]);
  });

  it("가격이 같은 두 옵션을 옵션명으로 가른다", () => {
    const grid = [["옵션명", "수량", "총판매가"], ["구성: A 1박스", 1, 10000], ["구성: B 1박스", 2, 10000], ["총합계", 3, 20000]];
    expect(parsePivotGrid(grid)).toEqual([
      { label: "구성: A 1박스", qty: 1 },
      { label: "구성: B 1박스", qty: 2 },
    ]);
  });

  it.each([
    ["소수 수량", 1.5],
    ["지수 표기 글자", "1E3"],
    ["음수", -1],
    ["글자", "세 개"],
  ])("%s 는 SHEET_LAYOUT_CHANGED", (_label, qty) => {
    const grid = [["옵션명", "합계 : 수량"], ["가", qty], ["총합계", 1]];
    expect(() => parsePivotGrid(grid)).toThrow("SHEET_LAYOUT_CHANGED");
  });

  it("머리 행이 앞 15행 안에 없으면 SHEET_LAYOUT_CHANGED", () => {
    const grid = [...Array.from({ length: 15 }, () => ["메모"]), ["옵션명", "합계 : 수량"], ["가", 1], ["총합계", 1]];
    expect(() => parsePivotGrid(grid)).toThrow("SHEET_LAYOUT_CHANGED");
  });

  it("수량 열이 없으면 SHEET_LAYOUT_CHANGED", () => {
    expect(() => parsePivotGrid([["옵션명", "합계 : 총판매가"], ["가", 1000], ["총합계", 1000]])).toThrow("SHEET_LAYOUT_CHANGED");
  });

  it("총합계 행이 없으면 표 끝을 믿지 않는다", () => {
    expect(() => parsePivotGrid([["옵션명", "수량"], ["가", 1]])).toThrow("SHEET_LAYOUT_CHANGED");
  });

  it("총합계가 줄 합계와 다르면 SHEET_LAYOUT_CHANGED", () => {
    expect(() => parsePivotGrid([["옵션명", "수량"], ["가", 1], ["나", 2], ["총합계", 4]])).toThrow("SHEET_LAYOUT_CHANGED");
  });

  it("수량이 상한(1,000,000)을 넘으면 SHEET_LAYOUT_CHANGED — 상한까지는 읽는다", () => {
    expect(parsePivotGrid([["옵션명", "수량"], ["가", 1_000_000], ["총합계", 1_000_000]])).toEqual([{ label: "가", qty: 1_000_000 }]);
    expect(() => parsePivotGrid([["옵션명", "수량"], ["가", 1_000_001], ["총합계", 1_000_001]])).toThrow("SHEET_LAYOUT_CHANGED");
    expect(() => parsePivotGrid([["옵션명", "수량"], ["가", "1000001"], ["총합계", "1000001"]])).toThrow("SHEET_LAYOUT_CHANGED");
  });

  it("옵션명 없이 수량만 있는 줄은 SHEET_LAYOUT_CHANGED, 둘 다 빈 줄은 건너뛴다", () => {
    expect(parsePivotGrid([["옵션명", "수량"], [null, null], ["가", 1], ["총합계", 1]])).toEqual([{ label: "가", qty: 1 }]);
    expect(() => parsePivotGrid([["옵션명", "수량"], [null, 2], ["총합계", 2]])).toThrow("SHEET_LAYOUT_CHANGED");
  });

  it("피벗이 옵션 빈칸을 묶은 「(비어 있음)」 줄은 수량이 없으면 건너뛰고 총합계 대조는 그대로다", () => {
    const grid = [["옵션명", "합계 : 수량"], ["가", 3], ["(비어 있음)", null], ["나", 2], ["총합계", 5]];
    expect(parsePivotGrid(grid)).toEqual([
      { label: "가", qty: 3 },
      { label: "나", qty: 2 },
    ]);
    // 수량 0 은 건너뛴다 · 수량이 있으면 어느 옵션 것인지 몰라 멈춘다 · 총합계가 어긋나도 멈춘다.
    expect(parsePivotGrid([["옵션명", "수량"], ["가", 1], ["(비어 있음)", 0], ["총합계", 1]])).toEqual([{ label: "가", qty: 1 }]);
    expect(() => parsePivotGrid([["옵션명", "수량"], ["가", 1], ["(비어 있음)", 2], ["총합계", 3]])).toThrow("SHEET_LAYOUT_CHANGED");
    expect(() => parsePivotGrid([["옵션명", "수량"], ["가", 1], ["(비어 있음)", null], ["총합계", 2]])).toThrow("SHEET_LAYOUT_CHANGED");
  });
});

/** SheetJS 는 BIFF8 에 자동 필터 이름(`_FilterDatabase`)을 쓰지 않는다 — 실제 첨부처럼 전역 구간 끝에 직접 끼운다. */
function withFilterDatabaseNames(content: Buffer, sheetIndexes: number[]): Buffer {
  const stream = workbookStream(content);
  const nameRecord = (sheetIndex: number) => {
    const rgce = Buffer.alloc(11);
    rgce[0] = 0x3b; // PtgArea3d
    const payload = Buffer.alloc(16 + rgce.length);
    payload.writeUInt16LE(0x0021, 0); // 숨김 + 내장 이름
    payload[3] = 1; // 이름 글자 수
    payload.writeUInt16LE(rgce.length, 4);
    payload.writeUInt16LE(sheetIndex + 1, 8); // 시트 번호(1 부터)
    payload[15] = 0x0d; // 내장 이름 번호: _FilterDatabase
    rgce.copy(payload, 16);
    const head = Buffer.alloc(4);
    head.writeUInt16LE(0x0018, 0);
    head.writeUInt16LE(payload.length, 2);
    return Buffer.concat([head, payload]);
  };
  let offset = 0;
  let depth = 0;
  let globalsEof = -1;
  while (offset + 4 <= stream.length) {
    const type = stream.readUInt16LE(offset);
    if (type === 0x0809) depth += 1;
    if (type === 0x000a) {
      depth -= 1;
      if (depth === 0) {
        globalsEof = offset;
        break;
      }
    }
    offset += 4 + stream.readUInt16LE(offset + 2);
  }
  const names = Buffer.concat(sheetIndexes.map(nameRecord));
  const out = Buffer.concat([stream.subarray(0, globalsEof), names, stream.subarray(globalsEof)]);
  for (let at = 0; at < globalsEof; at += 4 + out.readUInt16LE(at + 2)) {
    // 시트 위치는 파일 앞에서부터의 절대 위치라 끼운 만큼 밀린다.
    if (out.readUInt16LE(at) === 0x0085) out.writeUInt32LE(out.readUInt32LE(at + 4) + names.length, at + 4);
  }
  return cfbWith({ Workbook: out });
}

describe("readStatementPivot — 자동 필터가 걸린 실제 첨부 모양", () => {
  const PIVOT_WITH_BLANK_BUCKET: unknown[][] = [
    ["옵션명", "합계 : 수량", "합계 : 총판매가"],
    ["구성: 3박스", 4, 120000],
    ["(비어 있음)", null, null],
    ["구성: 6박스", 2, 120000],
    ["총합계", 6, 240000],
  ];

  it("발주서·피벗 시트에 자동 필터 이름이 있어도 읽는다(실파일에서 첨부 전체가 열리지 않던 결함)", () => {
    const file = withFilterDatabaseNames(xls({ pivot: PIVOT_WITH_BLANK_BUCKET }), [2, 1]);
    // 양성 대조: 끼운 이름 레코드가 실제로 들어 있다.
    const names: number[] = [];
    const stream = workbookStream(file);
    for (let at = 0; at + 4 <= stream.length; at += 4 + stream.readUInt16LE(at + 2)) {
      if (stream.readUInt16LE(at) === 0x0018) names.push(stream.readUInt16LE(at + 12));
    }
    expect(names).toEqual([3, 2]);
    expect(readStatementPivot(file)).toEqual({ ok: true, rows: EXPECTED });
  });

  it("필터 이름이 없는 파일의 결과와 같다", () => {
    expect(readStatementPivot(xls({ pivot: PIVOT_WITH_BLANK_BUCKET }))).toEqual({ ok: true, rows: EXPECTED });
  });
});
