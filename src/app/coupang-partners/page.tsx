import type { Metadata } from "next";

// 쿠팡 파트너스 채널 인증용 공개 페이지(폐쇄 링크 — nav 미노출, 검색 비색인).
// 로그인 없이 열려야 심사자가 볼 수 있으므로 미들웨어 인증 허용목록에 경로가 등록돼 있고
// (src/lib/supabase/middleware.ts), CRM 사이드바/모바일 내비에서도 제외돼 독립 렌더된다.
// 에디터 추천(블로거/인플루언서 큐레이션) 톤의 상품 소개 페이지 — 배너는 PICKS 배열로 관리.
export const metadata: Metadata = {
  title: "그립형 미니 보조배터리, 색깔별로 골라봤어요 · WAG PICK",
  description:
    "매일 들고 다니는 물건일수록 예쁘고 편해야 하니까. 에디터가 직접 고른 그립형 미니 보조배터리 컬러 3종 추천.",
  robots: { index: false, follow: false },
};

// 쿠팡 파트너스 iframe 배너. 상품 추가/교체는 이 배열만 수정하면 된다.
const PICKS: {
  color: string;
  swatch: string; // 컬러칩 배경
  tagline: string;
  comment: string;
  html: string;
}[] = [
  {
    color: "화이트",
    swatch: "bg-slate-100 border-slate-300",
    tagline: "뭘 골라야 할지 모르겠다면",
    comment:
      "어떤 폰, 어떤 가방에도 무난하게 어울리는 기본 색. 사무실 책상 위에 올려둬도 튀지 않아서 하나만 산다면 저는 화이트를 고릅니다.",
    html: '<iframe src="https://coupa.ng/cnR31v" width="120" height="240" frameborder="0" scrolling="no" referrerpolicy="unsafe-url" browsingtopics></iframe>',
  },
  {
    color: "옐로우",
    swatch: "bg-yellow-200 border-yellow-300",
    tagline: "충전 속도까지 챙기고 싶다면",
    comment:
      "보기만 해도 기분 좋아지는 컬러. 상품명에 22.5W가 붙은 고속충전 라인이라, 급할 때 빨리 채우고 나가는 분들께 특히 추천해요.",
    html: '<iframe src="https://coupa.ng/cnR32t" width="120" height="240" frameborder="0" scrolling="no" referrerpolicy="unsafe-url" browsingtopics></iframe>',
  },
  {
    color: "오렌지",
    swatch: "bg-orange-300 border-orange-400",
    tagline: "가방 속에서 바로 찾고 싶다면",
    comment:
      "포인트 컬러라 가방 안에서 한눈에 보입니다. 물건 자주 잃어버리는 편이라면 의외로 이게 정답. 민트색 스트랩 조합도 귀여워요.",
    html: '<iframe src="https://coupa.ng/cnR32P" width="120" height="240" frameborder="0" scrolling="no" referrerpolicy="unsafe-url" browsingtopics></iframe>',
  },
];

const REASONS = [
  {
    title: "한 손에 잡히는 그립 사이즈",
    body: "충전하면서 폰을 쓰는 시간이 의외로 길죠. 손에 쥐는 그립형이라 지하철에서도 부담이 없습니다.",
  },
  {
    title: "케이블 일체형",
    body: "파우치 뒤져서 케이블 찾는 일이 없어요. 본체에 케이블이 달려 있어서 꺼내서 바로 꽂으면 끝.",
  },
  {
    title: "로켓배송",
    body: "오늘 주문하면 내일 도착. 여행 전날 밤에 생각나도 늦지 않았습니다.",
  },
];

const FOR_WHOM = [
  "출퇴근길에 영상·게임으로 배터리가 순삭되는 분",
  "여행 갈 때 케이블 챙기는 걸 매번 까먹는 분",
  "책상 위 물건도 색깔 맞춰 두고 싶은 분",
  "부모님·친구 실용 선물을 찾고 있는 분",
];

export default function CoupangPartnersPage() {
  return (
    // 루트 AppShellFrame의 flex 래퍼 자식이라 w-full 필수 — 없으면 내용 폭으로 수축해 좌측 정렬됨
    <div className="min-h-svh w-full bg-[#FBFAF8] text-slate-800">
      <main className="mx-auto w-full max-w-3xl px-5 pb-16">
        {/* 헤더 */}
        <header className="flex items-center justify-between border-b border-slate-200/70 py-5">
          <p className="text-sm font-black tracking-[0.25em] text-slate-900">
            WAG<span className="text-rose-500">PICK</span>
          </p>
          <p className="text-[11px] font-medium uppercase tracking-widest text-slate-500">
            Editor&apos;s Curation
          </p>
        </header>

        {/* 히어로 */}
        <section className="pt-10">
          <p className="text-xs font-semibold uppercase tracking-widest text-rose-500">
            This Week&apos;s Pick · 테크 액세서리
          </p>
          <h1 className="mt-3 text-3xl font-bold leading-snug text-slate-900 sm:text-4xl">
            요즘 가방에 항상 들어있는 것,
            <br />
            그립형 미니 보조배터리
          </h1>
          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-slate-500">
            매일 들고 다니는 물건일수록 작고, 예쁘고, 편해야 한다고 생각해요. 한동안
            이것저것 써보다 요즘 정착한 게 이 그립형 미니 보조배터리라서, 색깔별로
            정리해 소개합니다.
          </p>
          <div className="mt-5 flex items-center gap-3 text-xs text-slate-500">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-900 text-[10px] font-bold text-white">
              W
            </span>
            <span>
              <span className="font-medium text-slate-600">WAG 에디터</span> · 2026. 07
              · 직접 써보고 씁니다
            </span>
          </div>
        </section>

        {/* 추천 이유 3가지 */}
        <section className="mt-12">
          <h2 className="text-lg font-bold text-slate-900">
            왜 하필 <span className="text-rose-500">그립형</span>이냐면요
          </h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {REASONS.map((r, i) => (
              <div
                key={r.title}
                className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-soft-sm"
              >
                <p className="text-xs font-bold text-rose-400">0{i + 1}</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">{r.title}</p>
                <p className="mt-1.5 text-[13px] leading-relaxed text-slate-500">{r.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* 컬러별 픽 (파트너스 배너) */}
        <section className="mt-14">
          <h2 className="text-lg font-bold text-slate-900">컬러별로 골라봤어요</h2>
          <p className="mt-1 text-sm text-slate-500">
            같은 제품군이어도 색에 따라 쓰임이 달라지더라고요. 카드 속 이미지를 누르면
            쿠팡 상세 페이지로 이동합니다.
          </p>

          <div className="mt-6 space-y-4">
            {PICKS.map((pick, i) => (
              <article
                key={pick.color}
                className="flex flex-col gap-5 rounded-2xl border border-slate-200/70 bg-white p-5 shadow-soft-sm sm:flex-row sm:items-center"
              >
                {/* 배너 */}
                <div className="flex shrink-0 justify-center">
                  <div
                    className="overflow-hidden rounded-xl border border-slate-100"
                    dangerouslySetInnerHTML={{ __html: pick.html }}
                  />
                </div>
                {/* 코멘트 */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block h-3.5 w-3.5 rounded-full border ${pick.swatch}`}
                      aria-hidden
                    />
                    <p className="text-sm font-bold text-slate-900">
                      PICK {i + 1} · {pick.color}
                    </p>
                  </div>
                  <p className="mt-2 text-[15px] font-semibold leading-snug text-slate-800">
                    “{pick.tagline}”
                  </p>
                  <p className="mt-2 text-sm leading-relaxed text-slate-500">{pick.comment}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* 이런 분께 추천 */}
        <section className="mt-14 rounded-2xl bg-slate-900 p-6 text-white sm:p-8">
          <h2 className="text-lg font-bold">이런 분께 추천해요</h2>
          <ul className="mt-4 space-y-2.5">
            {FOR_WHOM.map((line) => (
              <li key={line} className="flex items-start gap-2.5 text-sm leading-relaxed text-slate-200">
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-rose-500 text-[10px] font-bold">
                  ✓
                </span>
                {line}
              </li>
            ))}
          </ul>
          <p className="mt-5 text-xs leading-relaxed text-slate-500">
            가격과 재고는 자주 바뀌니, 위 카드에서 오늘 가격을 직접 확인해 보세요.
          </p>
        </section>

        {/* 제휴 고지 + 푸터 */}
        <footer className="mt-12 border-t border-slate-200/70 pt-6">
          <p className="text-xs leading-relaxed text-slate-500">
            이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를
            제공받습니다. 소개된 상품의 가격·재고·배송 정보는 쿠팡 판매 페이지 기준이며
            실제와 다를 수 있습니다.
          </p>
          <p className="mt-3 text-xs text-slate-300">
            © WAG PICK: 직접 쓰는 물건만 소개하는 큐레이션 채널
          </p>
        </footer>
      </main>
    </div>
  );
}
