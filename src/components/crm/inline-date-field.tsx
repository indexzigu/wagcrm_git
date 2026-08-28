"use client";

import { useCallback, useRef } from "react";

/**
 * 즉시 저장되는 날짜 입력의 **커밋 시점 SSOT**.
 *
 * **왜 필요한가(실사고 2026-08-04, 오너 보고):** `<input type="date">` 는 세 세그먼트가
 * 채워지는 **중간 상태마다** `change` 를 쏜다. `2026-07-20` 을 치면 일 세그먼트에 `2` 를
 * 넣는 순간(브라우저가 두 번째 자릿수를 기다리는 동안) 이미 `2026-07-02` 로 이벤트가
 * 나간다. 그 값을 곧장 서버에 저장하고 응답으로 `value` 를 되받는 **제어 컴포넌트**는
 * 입력칸을 `02` 로 못박아 **두 번째 자릿수를 칠 수 없게** 만든다. 달력 팝업에서 월만
 * 이동해도 저장이 튀는 것도 같은 뿌리다.
 *
 * **처방은 디바운스가 아니라 커밋 시점 이동이다** — 타이핑 중에는 아무것도 저장하지 않고
 * **필드를 떠날 때(blur)와 Enter** 에만 한 번 커밋한다. 타이머를 쓰지 않으므로 "얼마나
 * 기다렸나"에 따라 동작이 갈리지 않는다. 이 패턴은 이 레포에서 이미 검증됐다 —
 * `campaign-side-panel.tsx` 의 기간 편집(`EditableDateField`)이 같은 구조이고 같은
 * 증상을 내지 않는다. 이 컴포넌트는 그 관용구를 공용화한 것이다.
 *
 * ⛔ `value` 를 `value={...}` 로 바꾸지 말 것(제어 전환) — 그 순간 위 결함이 되살아난다.
 * 외부 값 변경은 `key` 를 통한 재마운트로 반영한다.
 */
export type InlineDateFieldProps = {
  /** `YYYY-MM-DD` 또는 빈 문자열. 커밋되지 않은 사용자 입력은 여기 반영되지 않는다. */
  value: string;
  /** 값이 실제로 바뀐 채 blur·Enter 로 확정됐을 때만 호출된다. */
  onCommit: (next: string) => void | Promise<void>;
  disabled?: boolean;
  className?: string;
  id?: string;
  min?: string;
  max?: string;
  "aria-label"?: string;
};

export function InlineDateField({
  value,
  onCommit,
  disabled,
  className,
  id,
  min,
  max,
  "aria-label": ariaLabel,
}: InlineDateFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleBlur = useCallback(() => {
    const next = inputRef.current?.value ?? "";
    if (next === value) return;
    void onCommit(next);
  }, [value, onCommit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.currentTarget.blur(); // blur 핸들러가 커밋을 소유한다(경로 하나).
      } else if (e.key === "Escape") {
        // 원래 값으로 되돌린 뒤 떠난다 — blur 의 동등 비교가 커밋을 자연히 건너뛴다.
        e.currentTarget.value = value;
        e.currentTarget.blur();
      }
    },
    [value],
  );

  return (
    <input
      // key: 외부(서버) 값이 바뀌면 재마운트로 defaultValue 를 다시 심는다.
      key={value}
      ref={inputRef}
      type="date"
      defaultValue={value}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      disabled={disabled}
      className={className}
      id={id}
      min={min}
      max={max}
      aria-label={ariaLabel}
    />
  );
}
