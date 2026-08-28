import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs/promises';
import {
  applyOrderExcelRules,
  DEFAULT_NEW_WORKBOOK_RULES,
  type OrderExcelRules,
} from './excel-rules';

// F4 Phase 2 (F4_ORDER_MAPPING_ENGINE_PLAN.md §3~4): 브랜드별 열 배치 하드코딩을
// 열 매핑 규칙(OrderExcelRules) 단일 경로로 수렴. 브랜드는 거래처 orderExcelRules로
// 시드돼 있고(뉴트리원·명성/트리프), 규칙 미지정 시에만 표준 발주서(new-workbook)로 폴백한다.
// 레거시 하드코딩 규칙(TRIPP/NUTRIONE_LEGACY_RULES)은 제거됨(2026-07-08, §7) — 골든 오라클은
// __tests__/golden-rules.fixture.ts + excel-generator-parity 스냅샷에 회귀 테스트로 보존.
// 수식 shift·스타일 복제·'코드' 시트 bigram 내리채우기 등 구조 기계는 여기 잔존(설계 D5).

export interface OrderData {
  주문일: string;
  상품주문번호: string;
  구매자명: string;
  구매자연락처: string;
  수취인명: string;
  수취인연락처1: string;
  수취인연락처2?: string;
  우편번호: string;
  배송지: string;
  옵션정보: string;
  수량: number;
  배송비: string | number;
  배송메시지: string;
  사은품: string;
  상품코드?: string;
  검증?: string;
  공구판매가?: number;
}

export interface ExcelGeneratorParams {
  orders: OrderData[];
  templateId: string;
  sellerName?: string;
  mappings?: any[];
  // F4-②: 명시되면 양식 분기를 이 값으로. 없으면 templateId로 유추(레거시 호환).
  formatAdapter?: 'template-file' | 'tripp';
  // F4 Phase 2: 거래처 확정 규칙. 존재하면 write.mode가 유일 권위(formatAdapter 무시, 설계 D3).
  excelRules?: OrderExcelRules | null;
  // fill-template 템플릿 스냅샷 바이트(규칙 확정 시 복사본). 없으면 public/{templateId} 레거시 경로.
  templateBuffer?: Buffer;
}

export async function generateOrderExcelBuffer({ orders, templateId, sellerName, mappings, excelRules, templateBuffer }: ExcelGeneratorParams): Promise<Buffer> {
  // 규칙 확정본(excelRules)이 최우선. 없으면 표준 발주서(new-workbook)로 폴백한다 —
  // 알려진 브랜드(뉴트리원·명성)는 거래처 orderExcelRules로 시드돼 있어 이 폴백에 도달하지 않는다.
  const rules = excelRules ?? DEFAULT_NEW_WORKBOOK_RULES;
  const ctx = { sellerName };

  // 휴먼에러 게이트: 수량 필드가 채워지는 열 — 값이 1이 아니면 빨간 글자(모든 양식 공통, 소유자 2026-07-08).
  // 다량 주문(2개+)을 1개로 착각해 덜 보내는 사고 방지. fill-template은 기존 템플릿 폰트를 보존하며
  // 색만 덮어쓴다(new-workbook은 폰트가 없어 동일 결과).
  const quantityCols = new Set(
    rules.columns.filter((c) => c.source.type === 'field' && c.source.field === '수량').map((c) => c.col)
  );
  const highlightMultiQty = (cell: ExcelJS.Cell, col: number, value: unknown) => {
    if (!quantityCols.has(col)) return;
    const qty = Number(value);
    if (!Number.isFinite(qty) || qty === 1) return;
    // fill-template은 참조행 스타일 객체를 후속 행들이 공유하므로, 폰트를 바로 바꾸면
    // 다량 행의 빨강이 공유 스타일을 오염시켜 수량 1 행까지 번진다. 이 셀만의 독립 스타일로
    // 분리한 뒤 색만 덮어써 격리한다(기존 템플릿 폰트는 clone이 보존).
    cell.style = structuredClone(cell.style);
    cell.font = { ...cell.font, color: { argb: 'FFFF0000' } };
  };

  if (rules.write.mode === 'new-workbook') {
    // 새 워크북에 규칙의 헤더·열 배치대로 기록 (트리프·표준 발주서 등 new-workbook 브랜드).
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(rules.write.sheetName);

    const headerRow = sheet.getRow(rules.write.headerRow);
    rules.columns.forEach((column) => {
      headerRow.getCell(column.col).value = column.header;
    });
    headerRow.commit();

    orders.forEach((order, i) => {
      const row = sheet.getRow(rules.write.dataStartRow + i);
      applyOrderExcelRules(order, rules, ctx).forEach(({ col, value }) => {
        const cell = row.getCell(col);
        cell.value = value;
        highlightMultiQty(cell, col, value);
      });
      row.commit();
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  // fill-template (뉴트리원 등): 업로드 스냅샷(templateBuffer) 또는 레거시 public 템플릿을 채움
  let fileBuffer: Buffer | ArrayBuffer = templateBuffer as Buffer;
  if (!fileBuffer) {
    const templatePath = path.join(process.cwd(), 'public', `${templateId}_template.xlsx`);
    try {
      fileBuffer = await fs.readFile(templatePath);
    } catch (err: any) {
      console.error('Template Read Error:', err.message, templatePath);
      try {
        const fallbackPath = path.join(process.cwd(), '.next', 'server', 'app', 'public', `${templateId}_template.xlsx`);
        fileBuffer = await fs.readFile(fallbackPath);
      } catch {
        throw new Error(`발주서 템플릿(${templateId})을 찾을 수 없습니다. 거래처 발주 설정에서 발주서 양식을 업로드·확정하세요.`);
      }
    }
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer as any);

  // 불필요한 탭 지우기 (대상 시트·'코드' 탭만 남김)
  const sheetIdsToRemove: number[] = [];
  workbook.eachSheet((s) => {
    if (s.name !== rules.write.sheetName && s.name !== '코드') {
      sheetIdsToRemove.push(s.id);
    }
  });
  sheetIdsToRemove.forEach(id => workbook.removeWorksheet(id));

  // '코드' 탭에 매핑 데이터 덮어쓰기 (병합된 셀 등 기존 서식 충돌 방지를 위해 완전 재생성)
  // 게이트는 규칙(codeSheet.enabled) 소관, 생성 규약(bigram 내리채우기 포함)은 엔진 잔존.
  if (rules.write.codeSheet?.enabled && mappings && Array.isArray(mappings) && mappings.length > 0) {
    let codeSheet = workbook.getWorksheet('코드');
    if (codeSheet) {
      workbook.removeWorksheet(codeSheet.id);
    }
    codeSheet = workbook.addWorksheet('코드');
    codeSheet.addRow(['상품명', '옵션명', '상품코드', '단가']);

    let currentRowIndex = 2;
    let lastProductName = '';
    let lastOptionName = '';

    // 두 문자열 간의 형태소(Bigram) 유사도를 계산하는 헬퍼 함수
    const calculateSimilarity = (str1: string, str2: string): number => {
      if (!str1 || !str2) return 0;
      const s1 = str1.replace(/\s+/g, '').toLowerCase();
      const s2 = str2.replace(/\s+/g, '').toLowerCase();

      if (s1 === s2) return 1;
      if (s1.length < 2 || s2.length < 2) return s1.includes(s2) || s2.includes(s1) ? 1 : 0;

      const set1 = new Set();
      for (let i = 0; i < s1.length - 1; i++) set1.add(s1.slice(i, i + 2));

      let matches = 0;
      const set2 = new Set();
      for (let i = 0; i < s2.length - 1; i++) {
        const bg = s2.slice(i, i + 2);
        if (!set2.has(bg)) {
          set2.add(bg);
          if (set1.has(bg)) matches++;
        }
      }
      return (2 * matches) / (set1.size + set2.size);
    };

    mappings.forEach((m: any) => {
      let currentProductName = m.productName || m.상품명 || m.name || '';
      const currentOptionName = m.optionName || m.옵션명 || '';

      // A열(상품명)이 비어있고 이전 상품명이 존재할 때, 옵션명의 유사도가 30% 이상일 경우에만 병합 셀로 간주하여 내리채우기
      if (!currentProductName && lastProductName) {
        const similarity = calculateSimilarity(currentOptionName, lastOptionName);
        if (similarity > 0.3) {
          currentProductName = lastProductName;
        }
      }

      if (currentProductName) {
        lastProductName = currentProductName;
      }
      lastOptionName = currentOptionName;

      const row = codeSheet.getRow(currentRowIndex++);
      row.getCell(1).value = currentProductName;
      row.getCell(2).value = currentOptionName;
      row.getCell(3).value = m.brandCode || m.상품코드 || '';
      row.getCell(4).value = m.price || m.공구판매가 || 0;
      row.commit();
    });
  }

  const sheet = workbook.getWorksheet(rules.write.sheetName) || workbook.worksheets[0];
  const refRowIdx = rules.write.dataStartRow;
  const refRow = sheet.getRow(refRowIdx);

  // 참조행 수식 미리 교정 ('코드'! 등) - 원본 참조 행
  refRow.eachCell({ includeEmpty: true }, (cell) => {
    if (cell.type === ExcelJS.ValueType.Formula) {
      const formulaStr = cell.formula || ((cell as any).sharedFormula ? cell.formula : undefined);
      if (formulaStr) {
        // 이미 홑따옴표가 없는 경우에만 씌움 ('단어'! 형태로 치환)
        let fixedFormula = formulaStr.replace(/(^|[^'])([가-힣A-Za-z0-9_]+)!/g, "$1'$2'!");
        // 맨 앞 등호 또는 + 제거
        fixedFormula = fixedFormula.replace(/^[=+]+/, '');
        cell.value = { formula: fixedFormula };
      }
    }
  });

  // 수식 행 번호 조정 로직
  const shiftFormula = (formula: string, diff: number) => {
    const shifted = formula.replace(/(\$?[A-Z]+)(\$?(\d+))/g, (match, col, rowStr, rowNum) => {
      if (rowStr.startsWith('$')) return match;
      return `${col}${parseInt(rowNum) + diff}`;
    });
    return shifted;
  };

  // 참조행 셀 템플릿을 데이터 기입 "이전"에 스냅샷한다.
  // (기존 결함: 첫 데이터 행의 guard-true 기입이 참조행 수식(P·Q·R)을 값으로 바꾼 뒤
  //  복사 루프가 라이브 참조행을 읽어 이후 매핑 실패 행의 VLOOKUP 폴백이 null로 소실 —
  //  2026-07-07 소유자 승인 수정, 픽스처 재생성)
  type RefCellSnapshot = {
    col: number;
    style: ExcelJS.Cell['style'];
    dataValidation: ExcelJS.Cell['dataValidation'];
    formula: string | null; // 수식 셀이면 프리픽스 교정된 수식 문자열
    rawValue: ExcelJS.CellValue; // 수식 문자열을 못 얻는 수식 셀(공유 슬레이브 등)의 원본 값
  };
  const refCellSnapshots: RefCellSnapshot[] = [];
  refRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    const isFormula = cell.type === ExcelJS.ValueType.Formula;
    const formulaStr = isFormula
      ? cell.formula || ((cell as any).sharedFormula ? cell.formula : undefined)
      : undefined;
    refCellSnapshots.push({
      col: colNumber,
      style: cell.style,
      dataValidation: cell.dataValidation,
      formula: formulaStr ?? null,
      rawValue: isFormula && !formulaStr ? cell.value : null,
    });
  });

  const dataCount = orders.length;

  for (let i = 0; i < dataCount; i++) {
    const currentRowIdx = refRowIdx + i;
    const row = sheet.getRow(currentRowIdx);

    // 첫 행이 아닌 경우 참조행 스냅샷에서 스타일 및 수식 복사
    if (currentRowIdx > refRowIdx) {
      refCellSnapshots.forEach((snap) => {
        const targetCell = row.getCell(snap.col);
        targetCell.style = snap.style;
        targetCell.dataValidation = snap.dataValidation;

        if (snap.formula) {
          targetCell.value = { formula: shiftFormula(snap.formula, i) };
        } else if (snap.rawValue !== null) {
          targetCell.value = snap.rawValue;
        } else {
          targetCell.value = null;
        }
      });
    }

    // 열 값 기입은 규칙 소관 — guard 불충족 열은 미접촉(템플릿 수식 보존 의도)
    applyOrderExcelRules(orders[i], rules, ctx).forEach(({ col, value }) => {
      const cell = row.getCell(col);
      cell.value = value;
      highlightMultiQty(cell, col, value); // 수량≠1 빨강(기존 템플릿 폰트 보존)
    });

    row.commit();
  }

  // 템플릿에 남은 쓰레기 행 삭제
  const totalTemplateRows = sheet.rowCount;
  if (totalTemplateRows >= refRowIdx + dataCount) {
     const startDeleteIdx = refRowIdx + dataCount;
     // bulk spliceRows 대신 뒤에서부터 하나씩 지우는 것이 가장 안전함
     for (let r = totalTemplateRows; r >= startDeleteIdx; r--) {
       sheet.spliceRows(r, 1);
     }
  }

  const outputBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(outputBuffer);
}
