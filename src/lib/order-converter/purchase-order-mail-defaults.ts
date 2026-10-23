/**
 * 발주서 메일 기본값 SSOT — 제목·본문·KST yyMMdd.
 *
 * 종전엔 데스크톱 `order-dashboard.tsx` 의 `openEmailModal` 안에 리터럴로만 있었다. 모바일
 * 간편 전송(2026-10-23)이 같은 문구를 써야 해서 여기로 올렸다 — 두 화면이 각자 문장을
 * 들고 있으면 한쪽만 고쳐지는 사고가 난다(hand-rolled SSOT copy). 브랜드사가 받는 메일은
 * 어느 화면에서 보냈든 같은 얼굴이어야 한다.
 */

/** KST 기준 yyMMdd — 발주서 파일명·제목이 공유하는 날짜 표기(서버 `purchase-order` 와 동일). */
export function kstYymmdd(now: Date = new Date()): string {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const yy = String(kst.getUTCFullYear()).slice(-2);
  const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kst.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

export type PurchaseOrderMailDefaults = { subject: string; message: string };

export function buildPurchaseOrderMailDefaults(
  sellerName: string,
  now: Date = new Date(),
): PurchaseOrderMailDefaults {
  // 종전 데스크톱 인라인 코드와 바이트 동일하게 — 공백 정리도 하지 않는다(동작 보존).
  const name = sellerName;
  return {
    subject: `[와이그라운드] ${name} ${kstYymmdd(now)} 발주서 보내드립니다.`,
    message: `안녕하세요,
금일 ${name} 발주서를 첨부하여 전달드립니다.
확인후 회신 부탁드립니다.
감사합니다.`,
  };
}
