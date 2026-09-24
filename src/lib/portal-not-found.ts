// 셀러 포털 「없는 링크」 안내 문구의 SSOT.
// 두 곳이 같은 문구를 쓴다 — ① 페이지 구간의 notFound() 화면(`PortalNotFound`, React)
// ② proxy 게이트가 미등록 슬러그를 페이지에 닿기 전에 끊는 조기 404(`updateSession`).
// ②는 렌더·DB 를 태우지 않으려고 React 를 거치지 않으므로, 문구를 각자 적으면 조용히 갈라진다.
export const PORTAL_NOT_FOUND_TITLE = "리포트를 찾을 수 없어요";
export const PORTAL_NOT_FOUND_REASON = "링크가 만료되었거나 주소가 잘못 입력되었을 수 있어요.";
export const PORTAL_NOT_FOUND_ACTION = "담당 매니저에게 새 링크를 요청해 주세요.";

// proxy 조기 404 의 본문. 종전엔 본문 없는 404 라 카톡 링크로 들어온 셀러가 흰 화면만 봤다
// (오너 결정 2026-09-24: 흰 화면 대신 짧은 한국어 안내).
// ⛔ 요청 값(슬러그·경로·쿼리)을 여기에 끼워 넣지 말 것 — 모듈 로드 시 고정되는 정적 문자열이라
// 반사형 주입(XSS)이 구조적으로 불가능한 것이 이 형태의 요점이다. 외부 자원·스크립트도 두지 않는다
// (이 경로는 봇 스캔까지 받는 자리라 추가 요청을 만들면 안 된다).
export const PORTAL_NOT_FOUND_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${PORTAL_NOT_FOUND_TITLE}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:0 16px;background:#f8fafc;color:#0f172a;font-family:system-ui,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;text-align:center;line-height:1.6;word-break:keep-all}h1{margin:0;font-size:18px}p{margin:12px 0 0;font-size:14px;color:#475569}</style>
</head>
<body>
<main>
<h1>${PORTAL_NOT_FOUND_TITLE}</h1>
<p>${PORTAL_NOT_FOUND_REASON}<br>${PORTAL_NOT_FOUND_ACTION}</p>
</main>
</body>
</html>
`;
