"use client";

// T3 셀러 분석 리포트 → PDF 저장 버튼 (클라이언트 아일랜드, RSC 페이지에 삽입).
// 리포 관행(settlement-table.tsx)과 동일하게 브라우저 네이티브 인쇄(window.print)를 사용 —
// 별도 PDF 라이브러리·서버 헤드리스 없이 "다른 이름으로 저장 → PDF"로 산출. 인쇄 CSS는
// globals.css의 @media print + data-print-root 스코프가 앱 크롬을 숨기고 리포트만 렌더한다.
import { useCallback } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/** 파일명에 부적합한 문자 정리(브라우저 기본 저장명 = document.title). */
function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "셀러분석리포트";
}

export function PrintReportButton({ name }: { name: string }) {
  const handlePrint = useCallback(() => {
    const date = new Date().toISOString().slice(0, 10);
    const fileName = `${sanitize(name)}_셀러분석리포트_${date}`;
    const prevTitle = document.title;
    document.title = fileName; // 저장 대화상자 기본 파일명
    const restore = () => {
      document.title = prevTitle;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.print();
  }, [name]);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={handlePrint}
      className="no-print h-8 gap-1.5 text-xs"
    >
      <Printer className="size-3.5" />
      PDF 저장
    </Button>
  );
}
