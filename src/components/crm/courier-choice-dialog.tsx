'use client';

import React, { useState } from 'react';
import { DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ShippingDialogFrame } from './shipping/modals/ShippingDialogFrame';
import {
  NAVER_COURIER_OPTIONS,
  isCourierChoiceComplete,
  type CourierChoices,
  type UnresolvedCourierGroup,
} from '@/lib/order-converter/courier-code';

// 택배사 선택 창 — 송장 등록 도중 「택배사를 못 읽은 송장」이 있을 때 뜬다(오너 확정 2026-10-05).
//
// 이 창이 지키는 것은 하나다: **운영자가 고르기 전에는 아무것도 네이버로 나가지 않는다.**
// 그래서 ① 어떤 택배사도 미리 골라 두지 않고 ② 모든 묶음을 고르기 전에는 등록 버튼이 잠기며
// ③ 취소·Esc·바깥 클릭은 전부 「아무것도 하지 않음」이다. 고를 수 있는 택배사는 서버가 받는
// 목록 그대로다(`NAVER_COURIER_OPTIONS`) — 목록 밖 택배사를 여기서 다른 택배사로 등록하면
// 틀린 택배사가 실제 주문에 남으므로, 그 경우의 출구는 취소뿐이라고 창 안에 적어 둔다.

type CourierChoiceDialogProps = {
  /** 택배사를 못 읽은 송장 묶음 — 파일에 적힌 글자별(빈 칸 포함). */
  groups: readonly UnresolvedCourierGroup[];
  /** 취소 — 호출부는 아무것도 보내지 않고 끝낸다. */
  onCancel: () => void;
  /** 모든 묶음을 고른 뒤에만 불린다. 묶음 key → 네이버 택배사 코드. */
  onConfirm: (choices: CourierChoices) => void;
};

export default function CourierChoiceDialog({ groups, onCancel, onConfirm }: CourierChoiceDialogProps) {
  const [choices, setChoices] = useState<Record<string, string>>({});
  const totalCount = groups.reduce((sum, g) => sum + g.count, 0);
  const complete = isCourierChoiceComplete(groups, choices);
  const remaining = groups.filter((g) => !choices[g.key]).length;

  return (
    <ShippingDialogFrame onClose={onCancel} className="sm:max-w-md max-h-[85vh]">
      <div className="p-5 border-b border-slate-100 bg-white rounded-t-2xl shrink-0">
        <DialogTitle className="text-lg font-bold text-slate-800">택배사를 확인해 주세요</DialogTitle>
        <p className="text-sm text-slate-600 mt-1">
          송장 <span className="tabular-nums">{totalCount.toLocaleString()}</span>건의 택배사를 알아보지 못했습니다. 고른
          택배사가 실제 주문에 등록됩니다. 취소하면 아무것도 등록하지 않습니다.
        </p>
      </div>

      <div className="p-5 overflow-y-auto [scrollbar-gutter:stable]">
        <p className="text-xs text-slate-700 mb-3">
          목록에 없는 택배사(예: 경동택배)는 비슷한 택배사로 고르지 말고, 취소한 뒤 네이버 판매자센터에서 직접 등록해
          주세요.
        </p>
        <ul className="space-y-2">
          {groups.map((group) => (
            <li key={group.key || '__empty__'} className="flex items-center justify-between gap-3">
              <span className="min-w-0 text-sm text-slate-700">
                <span className="font-medium break-all">{group.label}</span>
                <span className="block text-xs text-slate-500 tabular-nums">{group.count.toLocaleString()}건</span>
              </span>
              <Select
                value={choices[group.key] ?? ''}
                onValueChange={(code) => setChoices((prev) => ({ ...prev, [group.key]: code }))}
              >
                <SelectTrigger className="w-40 shrink-0" aria-label={`${group.label} 택배사 선택`}>
                  <SelectValue placeholder="택배사 선택" />
                </SelectTrigger>
                <SelectContent>
                  {NAVER_COURIER_OPTIONS.map((option) => (
                    <SelectItem key={option.code} value={option.code}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </li>
          ))}
        </ul>
      </div>

      <div className="p-5 border-t border-slate-100 bg-slate-50 rounded-b-2xl flex justify-end items-center gap-2 shrink-0">
        <p id="courier-remaining" role="status" className="mr-auto text-xs text-slate-600">
          {remaining > 0 ? `택배사를 고르지 않은 묶음 ${remaining}개` : '모두 선택했습니다'}
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="px-5 py-2 text-sm text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 font-bold transition-colors"
        >
          취소
        </button>
        <button
          type="button"
          disabled={!complete}
          aria-describedby="courier-remaining"
          onClick={() => {
            if (complete) onConfirm(choices);
          }}
          className="px-5 py-2 text-sm text-primary-foreground bg-primary rounded-lg hover:bg-primary/95 font-bold shadow-soft-md transition-[background-color,opacity] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          선택한 택배사로 등록
        </button>
      </div>
    </ShippingDialogFrame>
  );
}
