"use client";

import { useEffect, useState } from "react";
import { AlertTriangleIcon } from "lucide-react";
import type { OfferDiagnosis } from "@/lib/offer/offer-diagnostic";

/**
 * 콘텐츠 가이드 생성 버튼 옆의 오퍼 경고 (C3 M3 · C2 M4 ① 해소).
 *
 * 지원하는 판단: **"카피를 다듬기 전에 오퍼를 먼저 봐야 하나"**.
 * 오퍼가 약하면 카피를 아무리 고쳐도 전환이 오르지 않는다 — 그런데 운영자는
 * 보통 "자료가 없다"를 문제로 느끼고 생성 버튼부터 누른다.
 *
 * ## 왜 다이얼로그가 아닌가 (스펙 §4-3 에서 의도적으로 벗어남)
 *
 * 스펙 초안은 클릭 시 확인창("먼저 보시겠습니까? [진단 보기] [그래도 생성]")을
 * 제안했다. 그러지 않은 이유:
 * - **오퍼 진단 섹션이 이미 같은 패널에 있다**(C2 M2) — 확인창은 같은 정보를
 *   두 번 묻는 셈이고, 매번 클릭을 하나 더 요구한다.
 * - `campaign-setup.ts` 의 교훈: 운영자에게 추가 행동을 요구하면 **우회하는
 *   법부터 배운다**. 확인창은 "그래도 생성"을 반사적으로 누르는 습관을 만든다.
 *
 * 그래서 **차단도, 확인도 하지 않고 옆에 세워둔다**. 미충족이 0건이면 아무것도
 * 렌더하지 않아 노이즈가 남지 않는다.
 *
 * ⛔ 생성을 막지 않는다(C2 스펙 §2 — 자동 차단 아님). 오퍼 개선은 브랜드 협상이
 * 필요해 즉시 못 고치는 경우가 많다.
 */
export function OfferDiagnosticHint({ dealId }: { dealId: string }) {
  const [failedLabels, setFailedLabels] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    // 오퍼 진단 섹션과 같은 엔드포인트를 각자 호출한다(읽기 전용·순수 계산이라
    // 가볍다). 상태를 공유하려면 딜 패널 전체를 리팩터해야 해서 그 비용이 더 크다.
    fetch(`/api/deals/${dealId}/offer-diagnostic`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: OfferDiagnosis | null) => {
        if (!alive || !body || !Array.isArray(body.rows)) return;
        setFailedLabels(
          body.rows.filter((r) => r.verdict === "FAIL").map((r) => r.label),
        );
      })
      // 경고를 못 불러온 것으로 생성을 막지 않는다 — 조용히 접는다.
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [dealId]);

  if (failedLabels.length === 0) return null;

  return (
    <p className="mt-1 flex items-start gap-1 text-[11px] text-status-caution-text">
      <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
      <span>
        오퍼 미충족 {failedLabels.length}건({failedLabels.join(" · ")}): 카피를
        다듬어도 오퍼가 약하면 전환이 오르지 않습니다. 아래 오퍼 진단을 먼저
        확인하세요.
      </span>
    </p>
  );
}
