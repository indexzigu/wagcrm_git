import { toast as sonnerToast, type ExternalToast } from "sonner";

/**
 * 앱 전역 토스트 창구 — 컴포넌트는 `sonner` 가 아니라 이 모듈에서 `toast` 를 가져온다.
 *
 * 왜 래퍼가 필요한가: sonner 2.0.7 은 **종류별 기본 수명**을 지원하지 않는다(`<Toaster>`
 * 의 `duration`·`toastOptions.duration` 은 성공·오류에 똑같이 걸린다). 그런데 오류 토스트는
 * 복구 방법을 담고 있어서 4초 타이머에 묶이면 읽기 전에 사라진다(interfaces 점검 #10,
 * 2026-09-24). 그래서 `toast.error` 만 **닫을 때까지 유지**로 바꾸고, 나머지는 sonner 를
 * 그대로 통과시킨다. 닫기 버튼은 `ui/sonner.tsx` 의 `<Toaster closeButton>` 이 단다.
 *
 * ⛔ `import { toast } from "sonner"` 를 다시 쓰지 말 것 — 그 오류 토스트는 4초 뒤 사라진다.
 * `toast-import-boundary.contract.test.ts` 가 이 모듈과 `ui/sonner.tsx` 밖의 sonner import 를 막는다.
 *
 * Proxy 로 감싸는 이유: `toast` 는 함수이면서 메서드 묶음이라(`toast("…")`·`toast.success`)
 * 타입을 `typeof sonnerToast` 그대로 유지하려면 전 멤버를 복제해야 한다. Proxy 는 `error`
 * 하나만 가로채고 나머지 호출·속성은 **호출 시점에** sonner 로 넘긴다 — 테스트가
 * `vi.mock("sonner")` 로 갈아 끼운 목도 그대로 받는다.
 */

/** 오류 토스트의 수명 — 사용자가 닫을 때까지 남는다. */
export const ERROR_TOAST_DURATION = Number.POSITIVE_INFINITY;

function persistentError(message: Parameters<typeof sonnerToast.error>[0], data?: ExternalToast) {
  // 같은 문구의 오류는 한 장으로 합친다 — 저절로 사라지지 않으므로, 인라인 저장처럼 되풀이되는
  // 실패(네트워크가 잠깐 끊긴 채 칸 여러 개를 고칠 때)가 닫아야 할 토스트를 건수만큼 쌓는다.
  // 호출부가 `id` 를 주면 그 id 가 이긴다(로딩 토스트를 오류로 바꾸는 흐름).
  const dedupeId = typeof message === "string" ? `error:${message}` : undefined;
  // 수명은 정책이 호출부 값을 이긴다(뒤에 둔다) — 호출부마다 다시 고르면 이 모듈을 둔 의미가 없다.
  return sonnerToast.error(message, {
    id: dedupeId,
    ...data,
    duration: ERROR_TOAST_DURATION,
  });
}

export const toast: typeof sonnerToast = new Proxy(sonnerToast, {
  get(target, property, receiver) {
    if (property === "error") return persistentError;
    return Reflect.get(target, property, receiver);
  },
});

export type NotifyType = "info" | "success" | "error";

/**
 * 종류를 문자열로 받는 호출부(주문 변환 모달의 `addToast(msg, type)` 계약)용 어댑터.
 * 종전 자체 토스트 훅(`hooks/useToast.ts`, 3.5초 · live region 없음 · 색으로만 종류 구분)을
 * 이 함수로 흡수했다 — sonner 는 알림 영역(`aria-live`)과 종류 아이콘을 이미 갖고 있다.
 */
export function notify(message: string, type: NotifyType = "info") {
  if (type === "success") return toast.success(message);
  if (type === "error") return toast.error(message);
  return toast.info(message);
}
