"use client";

import {
  ArrowBigDown,
  ArrowBigUp,
  Building2,
  FileInput,
  FileOutput,
  FileSpreadsheet,
  Loader2,
  Minus,
  UserRound,
} from "lucide-react";
import { badgeSizeClassName } from "@/components/ui/badge";
import { DataEmpty } from "@/components/ui/empty";
import {
  settlementCheckboxCol,
  settlementFluidCol,
  settlementTableStyle,
} from "./settlement-table-layout";
import { formatDate } from "@/lib/format";
import { resolveProfitTone, PROFIT_TONE_TEXT_DENSE } from "@/lib/profit-tone";
import { cn } from "@/lib/utils";
import type { CampaignRow } from "@/lib/crm-types";
import type {
  CampaignMoneySlot,
  TaxInvoiceCounterpart,
  TaxInvoiceDirection,
} from "@/lib/tax-filing-board";
import { resolveCampaignInvoiceSlots, resolveCampaignMoneySlots } from "@/lib/tax-filing-board";

type SlotIcon = typeof Building2;

/**
 * 정산일정·계산서 배지의 **아이콘 문법**(오너 확정 2026-08-26, 시안 승인).
 *
 * 두 열이 각각 170px 를 쓰던 한글 배지(`min-w-16` = 64px)를 글리프 2개(40px)로 바꾼 것이다.
 * 목적은 **가로 스크롤 제거** — 1280px 뷰포트에서 표가 1293px 를 요구해 296px 가 스크롤로
 * 밀려 있었고(오른쪽 끝 「영업이익」이 안 보였다), 이 압축 + 금액 열 여백 다이어트로
 * 994px 가 되어 컨테이너 997px 안에 들어온다.
 *
 * **문법은 「주체 × 행위」 2차원이다:**
 * - 주체 — `Building2`(공급사) / `UserRound`(셀러). ⛔ 새 아이콘을 고르지 말 것:
 *   정산 카드(`campaign-side-panel.tsx` 「브랜드사 정산」/「셀러 정산」 머리글)가 이미 이 둘을
 *   쓴다. 이 표의 행을 누르면 열리는 바로 그 패널이라 같아야 한다.
 * - 행위 — 정산일정은 **돈**의 방향(`ArrowBigDown`=입금 / `ArrowBigUp`=지급),
 *   계산서는 **서류**의 방향(`FileInput`=수취 / `FileOutput`=발행).
 *   ⛔ 계산서를 `FileDown`/`FileUp` 으로 되돌리지 말 것 — 그 둘은 **본체와 접힌 모서리가
 *   완전히 같고** 안쪽 화살표만 6단위(12px 화면에서 3px) 뒤집힌 그림이라, 실제 크기에서
 *   방향이 사라진다(잉크 차이 6.5% — 정산일정 화살표 쌍은 38%). 방향을 상대로 유추할 수도
 *   없다: 같은 공급사라도 브랜드몰은 발행, 자사몰·셀러몰은 수취다(`TAX_INVOICE_OBLIGATION_TABLE`).
 *   `FileInput`/`FileOutput` 은 화살표가 **문서 밖으로 나와** 실루엣 자체가 갈린다(20.2%).
 *
 * ⛔ **계산서 열을 화살표 계열로 되돌리지 말 것 (접근성 검토 차단 사유, 2026-08-26).**
 * 같은 상대에 대해 두 열의 방향은 **항상 반대**다(우리가 계산서를 발행하면 돈이 들어온다 —
 * `resolveCampaignMoneySlots` 주석의 규칙). 두 열이 같은 화살표 어휘를 쓰면 왼쪽에서 배운
 * 「↑ = 나간다」를 오른쪽에 적용하는 순간 **뜻이 정확히 역전된다.** 종이 실루엣이 화살표를
 * 해독하기 전에 "이건 서류다"를 말해 주는 것이 그 혼동을 원천 차단한다. 한글 라벨에는 이
 * 위험이 없었다(「지급」/「발행」은 다른 낱말이라 한 어휘로 묶이지 않는다) — 즉 아이콘화가
 * 새로 만드는 위험이라 아이콘화와 함께 막아야 한다.
 *
 * ⚠️ **`money-direction.ts` 와의 계약 긴장 — 위반이 아니다.** 그 파일은 방향을 "아이콘 + 색
 * 한 쌍"으로 말하라고 하지만 여기서는 화살표만 방향을 지고 색은 **완료 여부**가 쓴다
 * (오너 결정 2026-07-30, 방향 토큰은 자기 틴트 위 3.93 으로 실측 기각). 그 규칙이 막으려던
 * 실사고는 "입금과 지급의 색이 같아 화살표 모양으로만 구분됐다"였는데 여기서는 화살표가
 * 실제로 뒤집히므로 해당하지 않는다. ⛔ 이 주석 없이 두면 다음 세션이 「방향색 누락」으로
 * 오판해 되돌린다.
 *
 * ⛔ **분기는 코드값으로 한다** — `slot.verb`·`slot.shortTitle` 같은 **한글 문자열을 비교하지
 * 말 것.** 문구를 다듬는 순간 조용히 깨지는 부류다(`inapplicableReason` 대신
 * `inapplicableCause` 를 쓰라는 SSOT 주석과 같은 이유).
 */
const COUNTERPART_ICON: Record<TaxInvoiceCounterpart, SlotIcon> = {
  SUPPLIER: Building2,
  SELLER: UserRound,
};

/**
 * 행위 글리프도 **표로 올린다** — 배지 호출부와 아래 범례가 **같은 곳을 읽어야** 한다.
 * ⛔ 호출부의 삼항이나 범례 배열에 아이콘을 손으로 다시 적지 말 것: 한쪽만 고치면
 * 범례가 조용히 거짓말을 시작한다(이 레포가 반복해서 겪은 「같은 판정의 두 번째 인코딩」).
 * 키는 전부 **코드값**이라 한글 문구를 다듬어도 안 깨진다.
 */
const MONEY_KIND_ICON: Record<CampaignMoneySlot["kind"], SlotIcon> = {
  DEPOSIT: ArrowBigDown,
  PAYOUT: ArrowBigUp,
};

const INVOICE_DIRECTION_ICON: Record<TaxInvoiceDirection, SlotIcon> = {
  RECEIVE: FileInput,
  ISSUE: FileOutput,
};

/** 의무가 없는 칸. 수직 화살표·문서와 달리 **가로획**이라 「아직 안 했다」와 섞이지 않는다. */
const INAPPLICABLE_ICON: SlotIcon = Minus;

/**
 * 아이콘 배지 하나. 시각 사용자는 글리프로, 화면리더 사용자는 `sr-only` 로 같은 내용을 받는다.
 *
 * - **접근 가능한 이름은 `sr-only` 텍스트가 소유한다** — 아이콘은 전부 `aria-hidden`.
 *   ⛔ `role="img"` + `aria-label` 로 바꾸지 말 것: 이 표는 배지가 최대 152개(38행 × 2열 × 2줄)라
 *   역할("이미지") 낭독이 그만큼 붙고, `aria-label` 은 브라우저 페이지 내 찾기(Ctrl+F)에 걸리지
 *   않아 오너가 "셀러 지급"으로 행을 찾던 조작이 **조용히 사라진다**.
 * - **`sr-only` 문구는 SSOT 파생이다** — 오늘 화면에 보이던 라벨 그대로에 완료 상태만 덧붙인다.
 *   완료 여부는 지금까지 **색으로만** 전달돼 화면리더에 아예 없던 정보다(SC 1.4.1).
 * - **`title` 은 `aria-hidden` 안쪽 span 이 진다** — 바깥에 두면 이름의 부분집합이 최대 152회
 *   중복 낭독된다. `aria-hidden` 요소의 `title` 은 접근성 트리에 안 오르지만 네이티브 툴팁은
 *   DOM 기반이라 마우스 호버에서 그대로 뜬다(시각 사용자용 해설을 잃지 않는다).
 * - ⚠️ `inline-flex items-center` 는 장식이 아니다 — 없으면 `h-4`(16px) 박스 안에서 글리프가
 *   위로 붙어 날짜와 어긋난다(오너 신고 정렬 결함). ⛔ `badgeSizeClassName.compact` 에 넣어
 *   해결하지 말 것(무관한 소비처가 공유하는 전역 토큰이다).
 * - `min-w-16`·`justify-center` 는 **제거했다** — 라벨 글자 수가 2~6자로 제각각이라 날짜 시작점을
 *   맞추려고 박아 둔 매직 넘버였다. 글리프 2개는 폭이 구조적으로 균일해 그 강제가 불필요하다.
 * - `size-[1.2em]` 은 `text-[10px]` 기준 정확히 12px 이면서, 사용자가 브라우저 최소 글꼴을 키우면
 *   함께 커진다(고정 `size-3` 은 날짜만 커지고 유일한 정보 전달자인 글리프는 안 커진다).
 *   `h-auto min-h-4` 는 그때 `h-4` 가 글리프를 자르지 않게 하는 짝이다.
 */
function SlotIconBadge({
  counterpart,
  ActionIcon,
  actionFilled,
  label,
  tone,
  statusSuffix,
}: {
  counterpart: TaxInvoiceCounterpart | null;
  ActionIcon: typeof Building2;
  actionFilled?: boolean;
  label: string;
  tone: "done" | "todo" | "na";
  statusSuffix: string;
}) {
  // `counterpart === null` 은 몰 정산금 슬롯(현재 판정표에서는 나오지 않는 조합)이다.
  // 주체를 지어내지 않고 행위 글리프만 렌더한다 — 이름은 `sr-only` 가 그대로 진다.
  const SubjectIcon = counterpart ? COUNTERPART_ICON[counterpart] : null;
  // 「해당 없음」 칸은 `statusSuffix` 가 **사유**다(예 "개인 셀러(원천징수 대상)"). 종전에는
  // 그 사유가 `title` 로만 붙어 있어 화면리더 사용자는 0% 받았다 — 이제 이름에 실린다.
  const fullText = [label, statusSuffix].filter(Boolean).join(" ");
  // 완료 테두리는 **불투명**이어야 한다 — 알파를 섞으면 흰 셀 위 1.56:1 로 사실상 안 보인다
  // (구 `ring-primary/45`·`ring-destructive/20` 을 폐기한 것과 같은 실패 유형). 불투명은
  // 흰 셀 5.48 · 배지 fill 5.21 · 선택 행 틴트 5.03 으로 세 표면 모두 통과하고, 완료 여부가
  // **색 말고도** 남아 색각 이상·흑백 시야에서도 구분된다(SC 1.4.1).
  //
  // ⚠️ `na` 와 `todo` 는 **의도적으로 같은 색이다.** 종전에는 「해당 없음」만 한 단계 흐렸는데
  // (4.34:1) 10px 텍스트 AA(4.5) 미달이었고, 두 상태 사이 색 차이는 1.16:1 이라 위계로 읽히지도
  // 않았다 — 아무 일도 못 하면서 기준만 어긴 축이다. 둘의 구분은 **글리프**가 진다
  // (대시 vs 문서/화살표). ⛔ 「해당 없음」을 다시 흐리게 만들지 말 것.
  //
  // ⚠️ 이 근거를 className 속성 **안쪽 주석으로 옮기지 말 것** — 소스 스캔 계약
  // (status-literal-token-alignment)이 그 속성 안을 훑으므로, 금지 문자열을 인용한 주석이
  // 자기 자신을 위반으로 잡는다(이 레포가 세 번 밟은 함정).
  // ⛔ 이 문단에 **백틱을 쓰지 말 것**: 스캐너 정규식이 백틱을 문자열 시작으로 물어 다음
  // 백틱까지 수백 자를 통째로 삼키고, 그러면 진짜 className 블록이 매치에서 빠진다 —
  // 단언이 삼켜진 덩어리를 보고 통과하는 **가짜 초록**이 된다(2026-08-26 실측으로 잡았다).
  //
  // 배지 폭 하한(min-w-10 = 40px)은 오늘 기준 폭 변화가 0이다 — 글리프 2개 배지가 정확히 그
  // 폭이다. 상대가 없는 슬롯(counterpart 가 null 인 몰 정산금)은 글리프가 1개라 24px 로 줄어
  // 그 줄의 날짜만 왼쪽으로 밀리는데, 종전 min-w-16 이 막던 어긋남이 그 경로로만 되살아난다.
  // 하한만 남겨 그날 방어한다.
  return (
    <span
      className={cn(
        badgeSizeClassName.compact,
        "inline-flex h-auto min-h-4 min-w-10 items-center gap-1 font-semibold",
        tone === "done"
          ? "bg-status-success-bg text-status-success ring-1 ring-status-success"
          : "bg-slate-100 text-slate-600",
      )}
    >
      {/* `title` 과 `sr-only` 는 **같은 문자열**이다 — 시각 사용자(호버)와 화면리더가 같은
          내용을 받는다. 중복 낭독 걱정은 없다: `title` 이 `aria-hidden` 요소에 있어 접근성
          트리에 오르지 않고, 네이티브 툴팁만 DOM 기반으로 그대로 뜬다.
          ⛔ `title` 을 이 바깥 span 으로 올리지 말 것(그러면 이름의 사본이 낭독된다). */}
      <span aria-hidden="true" title={fullText} className="inline-flex items-center gap-1">
        {SubjectIcon ? <SubjectIcon className="size-[1.2em]" strokeWidth={2.5} /> : null}
        <ActionIcon
          className="size-[1.2em]"
          strokeWidth={actionFilled ? 1 : 2.5}
          fill={actionFilled ? "currentColor" : "none"}
        />
      </span>
      <span className="sr-only">{fullText}</span>
    </span>
  );
}

interface SettlementTableProps {
  campaigns: CampaignRow[];
  onSelectCampaign: (campaign: CampaignRow) => void;
  onRefresh?: () => Promise<void>;
  loading: boolean;
  /**
   * 선택 상태는 **페이지가 소유한다**(진행·완료 두 표가 하나의 하단 액션 바를 공유하기
   * 위해서다 — 표마다 자기 바를 띄우면 `position: fixed` 라 서로 겹친다).
   */
  selectedIds: string[];
  onToggleRow: (campaignId: string, checked: boolean) => void;
  onToggleAll: (campaignIds: string[], checked: boolean) => void;
}

const formatCurrency = (value: number | null | undefined) => {
  if (value == null) return "-";
  return Math.round(Number(value)).toLocaleString();
};

const formatScheduleDate = (value: string | null | undefined) => {
  if (!value) return "-";
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? `${year.slice(2)}-${month}-${day}` : "-";
};

export function SettlementTable({
  campaigns,
  onSelectCampaign,
  loading,
  selectedIds,
  onToggleRow,
  onToggleAll,
}: SettlementTableProps) {
  const handleSelectAll = (checked: boolean) => {
    onToggleAll(campaigns.map((campaign) => campaign.id), checked);
  };

  // ⛔ 개수 비교(`selectedIds.length === campaigns.length`)로 되돌리지 말 것 — 2026-08-24
  // 실렌더에서 잡힌 결함이다. `selectedIds` 는 이제 **페이지 전역**(진행 중 + 완료 합산)이라
  // 모집단이 이 표와 다르다: 완료 표에서 2건만 골라도 개수가 맞아떨어져 이 표의 헤더가
  // **거짓 체크**되고, 그 상태에서 헤더를 누르면 해제(`false`)가 나가 "전체 선택"이 한 번은
  // 아무것도 선택하지 않는다. 판정은 반드시 **이 표의 행이 전부 들어 있는가**로 한다
  // (완료 표와 같은 형태 — `settlement-selection-bar-single.contract.test.ts` 가 고정한다).
  const isAllSelected =
    campaigns.length > 0 && campaigns.every((campaign) => selectedIds.includes(campaign.id));


  return (
    <div className="relative flex min-h-[120px] flex-col">

      {loading ? (
        <div className="flex flex-1 items-center justify-center py-16 text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-5 animate-spin text-primary" />
          정산 목록 로딩 중...
        </div>
      ) : campaigns.length === 0 ? (
        <div className="flex flex-1 items-center justify-center py-16">
          <DataEmpty icon={FileSpreadsheet} title="정산 진행 중인 캠페인이 없습니다." bordered={false} />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/60 bg-white/50 shadow-soft-sm">
          <div className="overflow-x-auto">
            {/* 폭 규약의 정본은 `settlement-table-layout.ts` 다(완료 표와 공유) — 최소폭·체크박스
                고정폭·유동폭 계산이 모두 거기 있다. 아래 `<col>` 의 숫자는 **최소폭(994px)에서의
                실측 필요폭**이고, 표가 그보다 넓어지면 같은 비율로 함께 벌어진다.
                🪤 종전 `max-w-[1060px]` 상한은 **제거됐다**(오너 요청 2026-08-28) — 상한은 흡수 열
                하나에 죽은 여백이 쌓이는 것을 막았지만 대신 카드 우측에 빈 띠를 남겼고, 유동폭이
                그 여백을 전 열에 흩어 둘 다 없앤다. ⛔ 상한을 되살리지 말 것. */}
            <table
              className="w-full table-fixed border-collapse text-left text-xs"
              style={settlementTableStyle}
            >
              <colgroup>
                <col style={settlementCheckboxCol} />
                {/* ⛔ **캠페인명에 폭을 지정하지 말 것 — 흡수 열이다.** `table-fixed w-full` 은
                    지정폭 합이 컨테이너보다 작으면 남는 폭을 **전 열에 비례 배분**하고, 그러면
                    48px 체크박스 열이 함께 부풀어 완료 표(폭 미지정 흡수 열을 둔다)와 캠페인명
                    시작 좌표가 어긋난다 — 2026-08-25 오너 신고 결함이다.
                    🪤 **종전에는 이 표가 넘쳐서(1293 > 997) 선언폭이 유지돼 우연히 안전했다.**
                    2026-08-26 아이콘화로 총폭이 994 로 줄자 그 우연이 사라져 결함이 되살아났고,
                    1280px 실측은 여유가 3px 뿐이라 **0.1px 로 나와 회귀를 비껴갔다**(1600px 에서
                    체크박스 48→63.59px · 좌표차 15.59px 로 재현). 폭 합이 컨테이너보다 작아지는
                    변경을 할 때는 **넓은 뷰포트에서 다시 잰다.** */}
                <col />
                {/* 브랜드·거래처 — 실측 필요폭 73px(내용 최대 41 + 여백 32)에 13px 여유.
                    종전 110 은 아이콘화 이전 총폭이 이미 넘치던 시절의 값이라 근거가 없었다.
                    ⚠️ 이 둘이 폭 예산의 마지막 완충이다 — 더 줄이면 긴 브랜드명 말줄임이 빨라진다. */}
                <col style={settlementFluidCol(86)} />
                <col style={settlementFluidCol(86)} />
                {/* 정산일정·계산서는 **같은 구조**(아이콘 배지 + 날짜)라 폭도 같다.
                    128 = 여백(8+8) + 배지(40) + 간격(6) + 날짜(61) + 여유 5.
                    ⛔ 다시 좁히지 말 것 — 종전 150px 는 콘텐츠 118px 로 날짜가 두 줄로 감겼다
                    (실측 줄 높이 32px, 오너 신고 2026-08-25). 한글 배지(64px) 시절의 170 에서
                    아이콘화(40px)로 42px 를 반환한 값이다.
                    ⚠️ 아래 폭은 **한 벌로 계산됐다**(합 994 ≤ 컨테이너 997). 금액 4열의 여백을
                    px-4→px-2 로 줄이고 실측 필요폭에 맞춘 것이 전제이므로, 한 열만 되돌리면
                    가로 스크롤이 되살아난다. 실측 근거: 1280px 뷰포트에서 종전 1293px(스크롤
                    296px) → 994px(스크롤 0). */}
                <col style={settlementFluidCol(128)} />
                <col style={settlementFluidCol(128)} />
                <col style={settlementFluidCol(82)} />
                <col style={settlementFluidCol(76)} />
                <col style={settlementFluidCol(76)} />
                <col style={settlementFluidCol(74)} />
              </colgroup>
              <thead>
                <tr className="border-b border-border/70 bg-slate-50/70 font-semibold text-muted-foreground">
                  <th className="px-4 py-3 text-center">
                    <input
                      type="checkbox"
                      checked={isAllSelected}
                      onChange={(event) => handleSelectAll(event.target.checked)}
                      className="size-4 cursor-pointer rounded border-slate-300 text-primary focus:ring-focus-ring"
                      aria-label="모든 정산 항목 선택"
                    />
                  </th>
                  <th className="px-4 py-3">캠페인명</th>
                  <th className="px-4 py-3">브랜드</th>
                  <th className="px-4 py-3">거래처</th>
                  <th className="px-2 py-3">정산일정</th>
                  {/* 헤더 축은 내용 축을 따른다 — 이 표의 나머지 열이 전부 그렇다
                      (금액 열 = text-right 헤더 + 우측 정렬 값). 종전 text-center 는
                      좌측 정렬된 배지 위에 헤더만 가운데 떠 있어 이탈값이었다. */}
                  <th className="px-2 py-3">계산서</th>
                  <th className="px-2 py-3 text-right">총 거래액</th>
                  <th className="px-2 py-3 text-right">영업 수익</th>
                  <th className="px-2 py-3 text-right">판매 대행비</th>
                  <th className="px-2 py-3 text-right">영업이익</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {campaigns.map((campaign) => {
                  const isSelected = selectedIds.includes(campaign.id);
                  const profitTone = resolveProfitTone(campaign.operatingProfit);
                  const invoiceSlots = resolveCampaignInvoiceSlots(campaign);
                  // 정산일정 칸도 계산서 칸과 같은 방식으로 채널 슬롯에서 파생한다 —
                  // 자사몰은 지급(공급사)+지급(셀러) 두 줄이고 입금 줄이 없다(#452,
                  // 정산 카드와 같은 SSOT). 여기서 입금/지급을 하드코딩하면 카드와 갈린다.
                  const moneySlots = resolveCampaignMoneySlots(campaign.salesChannel);

                  return (
                    <tr
                      key={campaign.id}
                      className={`transition-colors hover:bg-slate-50/50 ${
                        isSelected ? "bg-primary/5 hover:bg-primary/5" : ""
                      }`}
                    >
                      <td className="px-4 py-3 text-center">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(event) => onToggleRow(campaign.id, event.target.checked)}
                          className="size-4 cursor-pointer rounded border-slate-300 text-primary focus:ring-focus-ring"
                          aria-label={`${campaign.campaignName ?? "캠페인"} 선택`}
                        />
                      </td>
                      <td className="min-w-0 px-4 py-3">
                        <div className="flex min-w-0 flex-col gap-1">
                          <button
                            type="button"
                            onClick={() => onSelectCampaign(campaign)}
                            className="max-w-full truncate text-left font-medium text-foreground hover:underline"
                          >
                            {campaign.dealName} - {campaign.sellerName}
                            {campaign.roundNumber ? (
                              <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                                ({campaign.roundNumber}차)
                              </span>
                            ) : null}
                          </button>
                          <span className="text-[10px] text-muted-foreground">
                            {formatDate(campaign.startDate)} ~ {formatDate(campaign.endDate)}
                          </span>
                        </div>
                      </td>
                      <td className="min-w-0 px-4 py-3">
                        <span className="block truncate text-[11px] text-slate-600">
                          {campaign.deal?.brandName || "-"}
                        </span>
                      </td>
                      <td className="min-w-0 px-4 py-3">
                        <span className="block truncate text-[11px] text-slate-600">
                          {campaign.partnerName || "-"}
                        </span>
                      </td>
                      <td className="px-2 py-3 text-xs text-slate-600">
                        {/* 이 두 배지의 색은 **자금 방향축이 아니다**(오너 결정 2026-07-30).
                            방향(입금/지급)은 배지의 라벨 텍스트가 이미 말하고, 색이 나르는 정보는
                            `is*Completed` — 즉 **완료 여부**다. 방향축은 같은 행에서 이미 자기 자리를
                            쓰고 있다(아래 판매 대행비 열의 `text-money-out`).
                            ⛔ 방향 토큰(`--money-out`)으로 옮기는 안은 **실측으로 기각**: 자기 /10 틴트
                            위에서 3.93 으로 10px font-semibold 의 AA(4.5) 미달이다. 그 토큰은 흰 배경
                            4.70 이라 `-text` 짝이 없어, 이 안은 신규 토큰 신설을 요구했다(P8 §5).
                            따라서 축은 완료 여부(생애주기/진행)이고 가드레일 2 가 적용된다 — 구
                            blue-50/violet-600 리터럴을 StatusBadge 어휘로 옮긴다. 같은 행 오른쪽 끝
                            "정산 완료" pill 과 같은 어휘다(정산 페이지 상단 Tracker 도 이 어휘를
                            썼지만 그 카드는 #442 로 제거됐다).
                            입금·지급은 **대칭으로** 움직인다(`money-direction.ts` 의 핵심 계약 —
                            한쪽만 칠하면 "지급 = 나쁜 것"으로 오독된다).
                            대비: --status-success on --status-success-bg = 5.21 ✅ */}
                        <div className="flex flex-col gap-1">
                          {/* 줄 구성은 moneySlots(채널 파생)가 정한다 — 자사몰은 「공급사 지급 /
                              셀러 지급」 두 줄(입금 없음), 그 외는 종전과 같은 입금+지급이다.
                              배지에 상대를 병기하는 이유: 자사몰의 두 줄이 같은 「지급」이라
                              상대 없이는 구분이 안 되고, 옆 계산서 칸(「공급사 수취」)과 문법을
                              맞추면 두 칸이 같은 행 안에서 나란히 읽힌다(min-w-16 도 동일). */}
                          {moneySlots.map((slot) => {
                            const completed = Boolean(campaign[slot.flagField]);
                            return (
                              <div key={slot.flagField} className="flex items-center gap-1.5">
                                {/* 행위 글리프는 `slot.kind` **코드값**으로 고른다 — 한글 `verb` 를
                                    비교하지 않는다(SSOT 주석이 반복 경고하는 「두 번째 인코딩」). */}
                                <SlotIconBadge
                                  counterpart={slot.counterpart}
                                  ActionIcon={MONEY_KIND_ICON[slot.kind]}
                                  actionFilled
                                  label={`${slot.counterpartLabel} ${slot.verb}`}
                                  tone={completed ? "done" : "todo"}
                                  statusSuffix={completed ? "완료" : "미완료"}
                                />
                                {/* `whitespace-nowrap` 은 폭이 다시 빠듯해져도 날짜가
                                    두 줄로 감겨 배지와 어긋나지 않게 하는 구조적 가드다.
                                    `tabular-nums` 는 두 줄의 날짜 자릿수를 세로로 맞춘다.
                                    `tracking-tight` 는 오너 요청(2026-08-26) — 8자 날짜에서 2.4px 를
                                    벌어 폭 여유를 3px→5.4px 로 넓힌다. 사용자가 자간을 직접 키우면
                                    그 설정이 이긴다(저자 선언이라 SC 1.4.12 와 충돌하지 않는다). */}
                                <span className="whitespace-nowrap text-[11px] tracking-tight tabular-nums">
                                  {formatScheduleDate(
                                    campaign[slot.expectedField] || campaign[slot.completedAtField],
                                  )}
                                </span>
                              </div>
                            );
                          })}
                          {/* ⛔ 지연 경고를 이 칸에 되살리지 말 것 (2026-08-25 오너 결정).
                              구 판정은 `endDate < 오늘-14 && (입금 || 지급 미완)` 이었고 세 가지가
                              동시에 깨져 있었다.
                              ① **변별력이 없다** — 이 표의 모집단은 리포트 API 가 `endDate` 로 월/연을
                                 자르고(`SettlementService.getSettlementReport`) 상태를
                                 SETTLEMENT_IN_PROGRESS 로 좁힌 결과라, 판정식과 축이 같다. 그래서
                                 과거 달을 열면 **전 행이** 켜지고 이번 달·미래 달은 거의 안 뜬다 —
                                 배지가 말한 것은 "이 건이 늦었다"가 아니라 "지난 달을 보고 있다"였다.
                                 「다음 업무」 열을 걷어낸 것과 같은 붕괴다.
                              ② **재는 대상이 틀렸다** — 약속 날짜는 바로 위가 렌더하는 입금·지급
                                 예정일인데 판정은 그걸 안 보고 종료일+14 라는 대리 지표를 썼다. 그래서
                                 예정일이 아직 미래여도 켜지고(오탐 — 데모 시드 실렌더로 재현했다),
                                 반대로 예정일을 넘겼어도 종료 14일 전이면 안 켜졌다. 한 칸이 자기가
                                 렌더하는 값과 다른 기준으로 경고한 셈이다.
                              ③ **SSOT 사본** — 정산 지연의 정본은 `buildOverdueSettlementItems`
                                 (`src/lib/agenda-settlements.ts`, 대시보드 아젠다)다. 정산 단계 상태 +
                                 예정일 경과 + 그룹 SoT 로 판정한다. 여기 손수 만든 두 번째 규칙이 같은
                                 도메인을 다른 기준으로 말하고 있었다.
                              다시 필요하면 이 칸에서 새로 쓰지 말고 그 SSOT 를 끌어와 소비한다.
                              (남은 공백은 별건 — 예정일이 비어 있으면 SSOT 도 항목을 만들지 않는다.)

                              ⚠️ **2026-08-27 에 생긴 「정산 미착수」(T-062)를 이것의 부활로 읽지 말 것.**
                                 겉보기에는 같은 「종료일 + 14일」 이지만 **모집단이 정반대**라 위 ① 의
                                 붕괴가 구조적으로 없다: 그쪽은 상태가 `ACTIVE`·`CLOSED`, 즉 **아직 정산
                                 단계가 아닌** 캠페인만 본다(`settlement-stage.PRE_SETTLEMENT_SALE_STATUSES`).
                                 이 표의 모집단은 `SETTLEMENT_IN_PROGRESS`·`COMPLETED` 이므로 **두 집합은
                                 정의상 겹치지 않는다** — 이 표에는 한 건도 뜨지 않는다. ② 도 걸리지 않는다:
                                 그쪽이 재는 것은 이 칸이 렌더하는 입금·지급 예정일이 아니라 **「정산을
                                 시작했는가」라는 다른 사실**이고, 액션도 다르다(입금 확인이 아니라 캠페인을
                                 정산 단계로 넘기기). 노출 자리도 이 표가 아니라 「데이터 점검」·「리스크
                                 신호」 카드다(오너 확정 2026-08-27).
                              ⛔ 그러니 **이 주석을 근거로 그 신호를 지우지도, 그 신호를 근거로 여기에
                                 지연 경고를 되살리지도 말 것.** 위 ①②③ 은 여전히 이 칸에 그대로 유효하다. */}
                        </div>
                      </td>
                      <td className="px-2 py-3 text-xs text-slate-600">
                        {/* ⛔ 채널 분기·한글 매핑·완료 판정을 여기서 새로 쓰지 말 것 — 전부
                            `resolveCampaignInvoiceSlots` 와 타임스탬프에서 파생한다. 이 레포는
                            같은 도메인을 세 번 잘못 짚었고(정산 카드가 두 칸을 양쪽 다 「발행」으로
                            하드코딩해 우리몰에서 라벨이 거짓말을 했다) 사본이 네 번째 사고를 만든다.
                            종전 이 자리의 「다음 업무」는 체크리스트 첫 미체크 항목이라 선행 단계가
                            같으면 전 행이 같은 값으로 붕괴했고, 오너가 실제로 계산서를 처리하는
                            정산 카드 경로가 체크리스트를 갱신하지 않아 열이 현실을 안 따라왔다.
                            색은 완료 여부(생애주기 축) 하나만 탄다 — 미완료는 "아직 안 일어남"이라는
                            정상 진행 상태이지 경고가 아니다. ⚠️ 종전 이 자리에 "심각도는 왼쪽
                            정산일정 열의 지연 경고가 소유한다"고 적혀 있었으나 그 경고는 2026-08-25
                            에 제거됐다(왼쪽 칸 묘비 주석 참조). **이 표는 이제 심각도 축을 싣지
                            않는다** — 정산 지연은 대시보드 아젠다가 소유한다. 여기에 심각도를
                            되들이지 말 것(한 칸에 두 축을 얹지 않는다는 규칙은 그대로다). */}
                        <div className="flex flex-col gap-1">
                          {invoiceSlots.map((slot) => {
                            const issuedAt = campaign[slot.field];
                            return (
                              <div key={slot.field} className="flex items-center gap-1.5">
                                {/* 행위 글리프는 `slot.direction` **코드값**으로 고른다.
                                    ISSUE(발행) = 서류가 나간다 · RECEIVE(수취) = 서류가 들어온다.
                                    「해당 없음」은 **주체를 살린 채** 행위 자리만 대시로 바꾼다 —
                                    종전 `"해당 없음"` 문자열은 상대를 지워버려 어느 쪽이 해당
                                    없는지 배지만으로는 알 수 없었다(이 변경으로 정보가 는다).
                                    수직 화살표·문서와 달리 대시는 가로획이라 「아직 안 했다」와
                                    섞이지 않는다. */}
                                <SlotIconBadge
                                  counterpart={slot.counterpart}
                                  ActionIcon={
                                    slot.applicable
                                      ? INVOICE_DIRECTION_ICON[slot.direction]
                                      : INAPPLICABLE_ICON
                                  }
                                  // ⛔ 「해당 없음」만 단독으로 쓰지 말 것 — 종전 문자열이 그랬고,
                                  // 상대를 지워버려 어느 쪽이 해당 없는지 알 수 없었다.
                                  // `shortTitle`(SSOT 파생, 예 "셀러 수취")을 앞에 세워 상대를 살린다.
                                  label={slot.applicable ? slot.shortTitle : `${slot.shortTitle} 해당 없음`}
                                  tone={!slot.applicable ? "na" : issuedAt ? "done" : "todo"}
                                  statusSuffix={
                                    !slot.applicable
                                      ? // 사유는 화면리더에만 실린다 — 종전에는 `title` 로만 붙어 있어
                                        // AT 사용자는 0% 받았다. 행당 최대 1개(개인 셀러 행)라 낭독
                                        // 부담도 작다.
                                        slot.inapplicableReason ?? ""
                                      : issuedAt
                                        ? "완료"
                                        : "미완료"
                                  }
                                />
                                {/* ⛔ 의무가 없어도 값이 있으면 날짜를 지우지 않는다(2026-08-07
                                    설계 §4-2) — 기록이 화면에서 사라지면 오너가 해제할 경로도
                                    없어진다. 프로덕션에 그런 레거시 행이 실재한다.
                                    ⛔ 비적용 날짜를 `text-slate-400` 으로 되돌리지 말 것 — 흰 배경
                                    2.63:1 로 12px 텍스트 AA(4.5) 크게 미달이었다. P8 데이터 그리드
                                    규칙의 "소극 상태는 slate-500 이 하한"(4.76:1)을 따른다. */}
                                {slot.applicable || issuedAt ? (
                                  <span className={cn("whitespace-nowrap text-[11px] tracking-tight tabular-nums", !slot.applicable && "text-slate-500")}>
                                    {formatScheduleDate(issuedAt)}
                                  </span>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      </td>
                      <td className="px-2 py-3 text-right font-medium tabular-nums text-slate-500">
                        {formatCurrency(campaign.actualSales)}
                      </td>
                      <td className="px-2 py-3 text-right font-medium tabular-nums text-slate-600">
                        {formatCurrency(campaign.settlementSales)}
                      </td>
                      {/* 판매 대행비 = 실제로 나가는 돈 → 자금 방향축. 이 표는 매출·비용·이익
                          4열이 나란해 열 식별 자체가 과제라 방향색이 일한다(값은 기존 rose-600
                          과 동일 — 리터럴을 토큰으로 옮긴 것). */}
                      <td className="px-2 py-3 text-right font-medium tabular-nums text-money-out">
                        {formatCurrency(campaign.sellerExpense)}
                      </td>
                      {/* 영업이익은 부호를 따른다 — 이전엔 무조건 emerald-600 이라 적자 캠페인도
                          초록으로 떴다. 규칙은 profit-tone SSOT 소유(여기서 삼항을 새로 쓰지 않는다). */}
                      <td className={`px-2 py-3 text-right font-medium tabular-nums ${(profitTone && PROFIT_TONE_TEXT_DENSE[profitTone]) || ""}`}>
                        {formatCurrency(campaign.operatingProfit)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* 아이콘 문법의 **범례**. 아이콘 배지는 글자를 지운 표기라, 이 줄이 없으면 문법을
              배울 경로가 배지 `title` 호버뿐이 된다 — 마우스를 안 쓰는 사용자에게는 5개 값짜리
              어휘가 **해독 불가**가 된다(접근성 검토 차단 사유 ①, 2026-08-26).
              ⛔ 이 범례를 열 헤더의 `title` 로 되돌리지 말 것: `<th>` 는 포커스 대상이 아니라
              키보드로 띄울 방법이 물리적으로 없고, `<th>` 에 내용이 있으므로 `title` 은 이름이
              아니라 **설명**으로 노출돼 표 탐색 시 셀마다 반복될 수 있다.
              ⚠️ 세로 한 줄(16px)만 쓰고 **가로 폭 예산(994/997)에는 닿지 않는다** — 이 줄을
              표 안의 열로 만들지 말 것. */}
          <SlotIconLegend />
        </div>
      )}
    </div>
  );
}

/**
 * 아이콘 문법 범례 — 위 배지와 **같은 컴포넌트에서 같은 아이콘을 렌더한다.**
 * ⛔ 여기에 아이콘을 손으로 다시 나열하지 말 것: 배지 쪽 매핑만 바꾸면 범례가 조용히
 * 거짓말을 하게 된다(이 레포가 반복해서 겪은 「같은 판정의 두 번째 인코딩」).
 */
function SlotIconLegend() {
  // ⛔ 아이콘을 여기서 손으로 고르지 말 것 — 전부 위 매핑 표에서 읽는다(배지와 한 곳).
  // ⛔ 낱말도 새로 짓지 말 것 — SSOT 어휘(`CampaignMoneySlot.verb` = 입금/지급,
  //    계산서 방향 = 발행/수취)를 그대로 쓴다. 종전 초안은 「돈 들어옴」·「계산서 보냄」처럼
  //    새 낱말을 만들어, 범례에서 배운 말과 배지 호버에 뜨는 말이 서로 달랐다
  //    (styleseed 기계 점검 2번 「한 동작에 한 낱말」 위반).
  const items: { Icon: SlotIcon; filled?: boolean; label: string }[] = [
    { Icon: COUNTERPART_ICON.SUPPLIER, label: "공급사" },
    { Icon: COUNTERPART_ICON.SELLER, label: "셀러" },
    { Icon: MONEY_KIND_ICON.DEPOSIT, filled: true, label: "입금" },
    { Icon: MONEY_KIND_ICON.PAYOUT, filled: true, label: "지급" },
    { Icon: INVOICE_DIRECTION_ICON.RECEIVE, label: "수취" },
    { Icon: INVOICE_DIRECTION_ICON.ISSUE, label: "발행" },
    { Icon: INAPPLICABLE_ICON, label: "해당 없음" },
  ];
  return (
    // 헤더 행과 **같은 어휘**(`border-*/70` + `bg-slate-50/70`)로 묶는다 — 이 표에서 그 조합이
    // 「데이터가 아니라 표의 부속물」을 뜻한다. 실선 하나만 두면 표의 아래쪽 테두리처럼 보여
    // 범례가 붕 뜬다. `overflow-x-auto` **바깥**이라 가로 스크롤이 생겨도 안 밀린다.
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/70 bg-slate-50/70 px-4 py-2 text-[10px] text-slate-600">
      {items.map(({ Icon, filled, label }) => (
        <span key={label} className="inline-flex items-center gap-1">
          <Icon
            // 배지와 같은 규칙 — 고정 `size-3` 이면 문법을 가르치는 이 줄만 사용자 글꼴 확대를
            // 안 따라간다.
            className="size-[1.2em]"
            strokeWidth={filled ? 1 : 2.5}
            fill={filled ? "currentColor" : "none"}
            aria-hidden="true"
          />
          {label}
        </span>
      ))}
    </div>
  );
}
