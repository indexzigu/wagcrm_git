"use client";

/**
 * 홈택스 건별발급 로컬 헬퍼로 **계산서 1장**을 보내는 공용 플로우.
 *
 * 소비처가 둘이다 — 월 단위 세무 처리 보드(`tax-filing-dialog.tsx`)와 정산 상세 카드
 * (`settlement-section.tsx`). ⛔ 복제하지 말 것: 이 플로우에는 눈에 안 보이는 규칙이
 * 세 개 있고, 사본은 그중 하나를 반드시 잃는다.
 *   ① 헬퍼 깨우기는 **클릭 제스처 안에서** 해야 한다(Chrome 외부 프로토콜 제한).
 *      health 확인과 스킴 열기 사이에 다른 await 를 끼우면 조용히 막힌다.
 *   ② 로그인이 풀렸을 때 **발행을 다시 쏘지 않는다** — 재시도가 로그인 단계를 다시
 *      클릭해 오너가 누르던 인증서 창을 초기화한다. 읽기 전용 상태 조회만 폴링한다.
 *   ③ 재시도는 **한 번만**. 그 뒤에도 로그인이 필요하면 오너 창만 계속 흔든다.
 *
 * **발급·전자서명은 헬퍼가 절대 누르지 않는다** — 폼 입력까지만 하고 멈추는 것이
 * 설계의 안전장치다(`docs/private/specs/2026-08-05-hometax-local-helper-design.md`).
 */
import { useCallback, useState } from "react";
import { toast } from "sonner";
import type { TaxInvoiceRow } from "@/lib/tax-invoice-builder";
import {
  checkHometaxHelperHealth,
  sendInvoiceToHometaxHelper,
  wakeHometaxHelper,
  waitForHometaxHelper,
  waitForHometaxLogin,
  HOMETAX_HELPER_INSTALL_COMMAND,
  HOMETAX_HELPER_START_COMMAND,
} from "@/lib/hometax-helper-client";

export type TaxInvoiceValidationDetail = {
  campaignId: string;
  campaignName: string;
  missingFields: string[];
};

export type HometaxIssueTarget = {
  /** 전송 중 표시를 거는 키 — 보드는 행 키, 카드는 캠페인 id 를 쓴다. */
  key: string;
  /** ⚠️ 그룹이면 멤버 전원 — 계산서는 그룹당 한 장이라 부분 전송이 금액을 갈리게 한다. */
  campaignIds: string[];
  /** 성공 토스트에 쓰는 상대 이름. */
  counterpartName: string;
};

export function useHometaxIssue(options?: {
  onValidationDetails?: (details: TaxInvoiceValidationDetail[]) => void;
}): {
  sendingKey: string | null;
  sendToHometax: (target: HometaxIssueTarget) => Promise<void>;
} {
  const [sendingKey, setSendingKey] = useState<string | null>(null);
  const onValidationDetails = options?.onValidationDetails;

  const sendToHometax = useCallback(
    async (target: HometaxIssueTarget) => {
      if (sendingKey) return;
      setSendingKey(target.key);
      try {
        // ① 제스처 안에서 깨운다.
        let healthy = await checkHometaxHelperHealth();
        if (!healthy) {
          wakeHometaxHelper();
          const wakingToast = toast.loading("홈택스 헬퍼를 켜는 중입니다…");
          healthy = await waitForHometaxHelper();
          toast.dismiss(wakingToast);
        }
        if (!healthy) {
          toast.error(
            `홈택스 로컬 헬퍼를 켜지 못했습니다. 오너 Mac 에서 \`${HOMETAX_HELPER_INSTALL_COMMAND}\` 로 깨우기 앱을 설치했는지 확인하거나, 터미널에서 \`${HOMETAX_HELPER_START_COMMAND}\` 로 직접 켠 뒤 다시 시도하세요.`,
          );
          return;
        }

        // 페이로드는 XLSX 와 같은 라우트·같은 빌더에서 받는다 — 화면·파일·헬퍼 금액이
        // 갈릴 수 없다. 별도 타입을 만들지 말 것.
        const res = await fetch("/api/settlement/tax-invoice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ campaignIds: target.campaignIds, format: "json" }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          const details = Array.isArray(body?.details) ? (body.details as TaxInvoiceValidationDetail[]) : null;
          if (details && details.length > 0 && onValidationDetails) {
            onValidationDetails(details);
            toast.error("발행 데이터 생성에 실패했습니다. 아래 상세를 확인하세요.");
          } else if (details && details.length > 0) {
            // 상세를 놓을 자리가 없는 호출부(카드) — 무엇이 빠졌는지를 토스트에 싣는다.
            // 「실패했습니다」만 띄우면 오너가 어디를 채워야 할지 알 수 없다.
            // ⚠️ 그룹이면 details 가 멤버 수만큼 온다 — `details[0]` 만 쓰면 나머지 멤버의
            //    누락 필드가 조용히 사라진다. 전량을 합쳐 중복만 제거한다. 필드 목록이
            //    비어 있을 수도 있으므로(콜론만 남는 문구) 그때는 일반 문구로 떨어진다.
            const missingFields = [...new Set(details.flatMap((detail) => detail.missingFields))].filter(Boolean);
            toast.error(
              missingFields.length > 0
                ? `발행 데이터가 부족합니다: ${missingFields.join(", ")}`
                : "발행 데이터 생성에 실패했습니다. 세무 처리 화면에서 상세를 확인하세요.",
            );
          } else {
            toast.error(body?.error ?? "발행 데이터 생성에 실패했습니다.");
          }
          return;
        }

        const data = (await res.json()) as { rows: TaxInvoiceRow[] };
        // 행 1개 = 계산서 1장이 이 경로의 계약이다(캠페인/그룹당 ISSUE 의무는 최대 1개 —
        // TAX_INVOICE_OBLIGATION_TABLE 구조상 보장). 여럿이 오면 어떤 장을 채울지 우리가
        // 조용히 고르면 안 되므로 중단한다.
        if (!Array.isArray(data.rows) || data.rows.length !== 1) {
          toast.error(
            `발행 데이터가 1건이 아닙니다(${data.rows?.length ?? 0}건). 세무 처리의 XLSX 경로를 사용하세요.`,
          );
          return;
        }

        let result = await sendInvoiceToHometaxHelper(data.rows[0]);

        // ② 로그인이 풀렸으면 상태만 폴링한다(발행을 다시 쏘지 않는다).
        if (result.status === "NEED_LOGIN") {
          const controller = new AbortController();
          const waitingToast = toast.loading(
            result.message ?? "홈택스 로그인이 필요합니다. 헬퍼가 연 창에서 로그인해 주세요.",
            { duration: Infinity, action: { label: "취소", onClick: () => controller.abort() } },
          );
          const loggedIn = await waitForHometaxLogin({ signal: controller.signal });
          toast.dismiss(waitingToast);
          if (!loggedIn) {
            toast.error("홈택스 로그인을 확인하지 못했습니다. 로그인을 마친 뒤 다시 누르세요.");
            return;
          }
          // ③ 재시도는 한 번만.
          result = await sendInvoiceToHometaxHelper(data.rows[0]);
          if (result.status === "NEED_LOGIN") {
            toast.error("로그인 후에도 홈택스가 로그인 상태로 보이지 않습니다. 열린 창의 상태를 확인해 주세요.");
            return;
          }
        }

        if (result.status === "AWAITING_SIGNATURE") {
          // 비밀번호 창까지 갔다 — **아직 발급 전이다.** 「발급했습니다」로 읽히면
          // 오너가 창을 닫아 버릴 수 있으므로, 남은 행위를 문구가 분명히 말해야 한다.
          toast.success(
            result.message ??
              `${target.counterpartName} 건의 인증서 비밀번호 창까지 진행했습니다. 비밀번호를 눌러 발급을 마치세요.`,
            { duration: 12_000 },
          );
        } else if (result.status === "AWAITING_CONFIRM") {
          // 헬퍼가 발급 버튼까지 눌렀고 홈택스 확인 창이 떠 있다 — **아직 발급 전이다.**
          // 「발급했습니다」로 읽히면 오너가 창을 닫아 버릴 수 있으므로, 지금 할 일이
          // 화면에 남아 있다는 것을 문구가 분명히 말해야 한다.
          toast.success(
            result.message ??
              `${target.counterpartName} 건의 발급 확인 창이 떴습니다. 내용을 확인하고 직접 발급하세요.`,
            { duration: 12_000 },
          );
        } else if (result.status === "FILLED") {
          // ⛔ **`result.message` 를 버리지 않는다**(2026-08-08). 헬퍼는 「발급하기를 왜
          //    못 눌렀는지」를 이 필드에 담는데(버튼 잠김·확인 창 미확인 등), 종전처럼
          //    고정 문구만 띄우면 그 사유가 **어디에도 도달하지 못하고 사라진다** —
          //    실제로 오너가 "발급하기를 안 누르는데?"만 보고 원인을 알 수 없었다.
          toast.success(
            result.message
              ? `${target.counterpartName}: ${result.message}`
              : `${target.counterpartName} 건을 홈택스 창에 채웠습니다. 내용 검토 후 직접 발급하세요.`,
            { duration: 12_000 },
          );
        } else if (result.status === "NEEDS_CHOICE") {
          // **실패가 아니다** — 폼은 채워졌고 홈택스가 사람이 누를 창을 띄운 것뿐이다.
          toast.warning(
            result.message ?? "홈택스가 선택 창을 띄웠습니다. 열린 창에서 직접 선택한 뒤 발급하세요.",
            { duration: 12_000 },
          );
        } else {
          toast.error(
            `자동 입력이 중간에 멈췄습니다(${result.step}). 열린 홈택스 창에서 이어서 수동 입력하세요.`,
          );
        }
      } catch {
        toast.error("홈택스 로컬 헬퍼와의 통신에 실패했습니다. 헬퍼 상태를 확인하세요.");
      } finally {
        setSendingKey(null);
      }
    },
    [sendingKey, onValidationDetails],
  );

  return { sendingKey, sendToHometax };
}
