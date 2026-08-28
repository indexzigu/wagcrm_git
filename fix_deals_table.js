const fs = require('fs');
const filePath = '/Users/z9/.gemini/antigravity/scratch/wag-crm/src/components/crm/campaign-deals-table.tsx';
let content = fs.readFileSync(filePath, 'utf8');

// 1. handleSave
content = content.replace(
  `            actualSales: settlementWorkspace
              ? (ld.sellingPrice ?? 0) * (ld.orderCount ?? 0)
              : ld.actualSales,`,
  `            actualSales: (ld.sellingPrice ?? 0) * (ld.orderCount ?? 0),`
);

// 2. totals
content = content.replace(
  `      const sales = settlementWorkspace
        ? (cur.sellingPrice ?? 0) * (cur.orderCount ?? 0)
        : (cur.actualSales || 0);`,
  `      const sales = (cur.sellingPrice ?? 0) * (cur.orderCount ?? 0);`
);

// 3. title
content = content.replace(
  `          {settlementWorkspace ? <ClipboardList className="size-4 text-slate-500" /> : null}
          <h3 className={settlementWorkspace ? "text-sm font-semibold text-foreground" : "text-xs font-semibold text-foreground"}>
            {settlementWorkspace ? "매출 상세 내역" : "매출 상세내역"}
          </h3>`,
  `          <ClipboardList className="size-4 text-slate-500" />
          <h3 className="text-sm font-semibold text-foreground">
            매출 상세 내역
          </h3>`
);

// 4. header save button
content = content.replace(
  `          {settlementWorkspace && localDeals.length > 0 ? (
            <Button`,
  `          {localDeals.length > 0 ? (
            <Button`
);

// 5. table opening
content = content.replace(
  `            <div className="overflow-x-auto">
              {settlementWorkspace ? (
                <table className="w-full table-fixed border-collapse text-left text-xs">`,
  `            <div className="overflow-x-auto">
                <table className="w-full table-fixed border-collapse text-left text-xs">`
);

// 6. remove old table and bottom save button
const startIndex = content.indexOf(`            ) : (`);
const endIndex = content.indexOf(`      {/* 정합성 확인 컨펌 다이얼로그 */}`);

if (startIndex !== -1 && endIndex !== -1) {
  content = content.slice(0, startIndex) + `          </div>\n        </div>\n      )}\n` + content.slice(endIndex);
}

fs.writeFileSync(filePath, content);
console.log('File updated successfully.');
