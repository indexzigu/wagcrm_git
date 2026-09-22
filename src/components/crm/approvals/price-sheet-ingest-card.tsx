"use client";

import * as React from "react";
import { PaperclipIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PRICE_SHEET_ACCEPT } from "./price-sheet-ingest";
import { PriceSheetIngestSlot, usePriceSheetIngest } from "./price-sheet-ingest-slot";

/**
 * 가격표 파일을 올려 딜 기안으로 만드는 카드.
 *
 * 종전 서식지는 채팅 입력줄의 클립 버튼이었다 — 채팅 은퇴(PR 3)로 그 입구가 사라지는데,
 * 인제스트 흐름 자체는 LLM 턴과 무관한 클라이언트 오케스트레이션이라(업로드 → 추출 →
 * 매핑 → 반영) 화면만 옮기면 그대로 산다. 결재함에 두는 이유는 이 흐름의 종착점이
 * 「딜을 새로 만든다」는 기안이고, 애매한 행은 검토 화면으로 넘어가기 때문이다.
 *
 * 높이는 `shadow-soft-md` — P8 Elevation Ladder 의 md 행(「독립 콘텐츠 패널의 평상시:
 * 설정 폼, 진단 카드」)이다. 판단 기준은 「화면에 몇 개가 동시에 존재하는가」이고 이 카드는
 * 결재함에 단 하나뿐이다.
 *
 * 상태기계·문구·검토 표시는 전부 `PriceSheetIngestSlot` 이 소유한다 — 여기서 다시 그리지
 * 않는다(슬롯이 스크린리더 공지 `role="status"` 도 함께 들고 있다).
 */
export function PriceSheetIngestCard() {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const headingId = React.useId();
  const ingest = usePriceSheetIngest();

  return (
    <section className="rounded-lg border border-border p-4 shadow-soft-md" aria-labelledby={headingId}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id={headingId} className="text-sm font-medium text-foreground">
            가격표 업로드
          </h2>
          <p className="text-xs text-muted-foreground">
            거래처가 보낸 가격표를 올리면 품목을 읽어 새 딜 기안으로 만듭니다
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={ingest.isRunning}
          onClick={() => fileInputRef.current?.click()}
        >
          <PaperclipIcon aria-hidden />
          가격표 업로드
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept={PRICE_SHEET_ACCEPT}
          className="hidden"
          data-testid="price-sheet-file-input"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) ingest.stageFile(file);
            // 같은 파일을 다시 고를 수 있어야 한다 — 값을 비우지 않으면 change 가 안 뜬다.
            event.target.value = "";
          }}
        />
      </div>

      <PriceSheetIngestSlot
        state={ingest.state}
        onConfirm={ingest.confirmUpload}
        onApply={ingest.applyClean}
        onCancel={ingest.cancel}
        onDismiss={ingest.dismiss}
      />
    </section>
  );
}
