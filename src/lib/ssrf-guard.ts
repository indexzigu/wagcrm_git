// SSRF 방어 공용 가드 — 서버가 외부에서 받은 URL을 직접 fetch하기 전에 호출한다.
// (mediaRehost·rehostReferenceThumbnail의 wsrv→원본 폴백 경로가 임의 URL을 그대로
// fetch하므로, 내부망·클라우드 메타데이터(169.254.169.254)로의 요청을 차단한다 — R3 리뷰 지적.)
//
// 설계: 리터럴 IP 차단 방식. 호스트명 allowlist는 IG CDN 도메인 변동(scontent-*.cdninstagram.com,
// *.fna.fbcdn.net 등)에 취약해 썸네일 가용성 회귀 위험이 있어 기각. WHATWG URL 파서가
// 정수·8진·16진 IPv4 표기(2130706433, 0177.0.0.1, 0x7f000001)를 dotted-decimal로
// 정규화해 주므로, 정규화 후 문자열 검사만으로 우회 표기까지 커버된다.
// ponytail: DNS 리바인딩(공개 호스트명→사설 IP resolve)과 리다이렉트 경유 우회는 미방어 —
// 서버리스에서 resolve 후 검증 비용이 커서 제외. 필요해지면 undici Agent의 connect 훅으로
// 연결 시점 IP를 검증하는 것이 업그레이드 경로.

/** dotted-decimal IPv4가 사설·내부 대역인가 (WHATWG 정규화를 거친 유효 IPv4 가정) */
function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || // 0.0.0.0/8 — 다수 스택에서 localhost로 라우팅되는 실효 우회로
    a === 10 || // RFC1918
    a === 127 || // 루프백
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    (a === 169 && b === 254) // 링크로컬 + 클라우드 메타데이터(169.254.169.254)
  );
}

const V4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

// 임베디드 IPv4 추출 — IPv4-mapped(::ffff:_/96)와 IPv4-compat(::_/96, deprecated지만
// 여전히 파싱·라우팅됨. `[::127.0.0.1]`이 `::7f00:1`로 직렬화돼 mapped 검사를 우회하는
// 벡터를 R3 후속 리뷰가 실증) 둘 다 커버한다. URL 직렬화는 hex형이지만 dotted 표기도
// 방어적으로 받는다. `::ffff:1` 같은 모호 표기는 저대역으로 해석해 차단 쪽으로 기운다.
const V6_EMBEDDED_DOTTED = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/;
const V6_EMBEDDED_HEX = /^::(?:ffff:)?(?:([0-9a-f]{1,4}):)?([0-9a-f]{1,4})$/;

function embeddedV4(host: string): string | null {
  const dotted = V6_EMBEDDED_DOTTED.exec(host);
  if (dotted) return dotted[1];
  const hex = V6_EMBEDDED_HEX.exec(host);
  if (hex) {
    const hi = parseInt(hex[1] ?? "0", 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return null;
}

/** 대괄호를 벗긴 IPv6 리터럴이 사설·내부 대역인가 */
function isPrivateV6(host: string): boolean {
  if (host === "::" || host === "::1") return true; // 미지정·루프백
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // 링크로컬 fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // ULA fc00::/7 (IPv6판 RFC1918)
  const v4 = embeddedV4(host);
  return v4 !== null && isPrivateV4(v4);
}

/**
 * http/https 스킴 + 공개 호스트임을 검증하고 파싱된 URL을 반환한다.
 * 위반 시 throw — 호출부의 기존 에러 경로(catch→thumbFailed 마킹 / per-item catch)로 흘러간다.
 */
export function assertPublicHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`URL 파싱 불가: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`URL 스킴 불허: ${url.protocol}`);
  }
  // named host는 FQDN 후행점을 보존한다(`localhost.` — IPv4 리터럴은 파서가 제거, 비대칭).
  // 후행점을 벗겨 `localhost.` 우회를 차단한다 (R3 후속 리뷰 실증 벡터).
  const host = url.hostname.replace(/\.+$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error(`내부 호스트로의 요청 차단: ${host}`);
  }
  if (host.startsWith("[") && host.endsWith("]")) {
    if (isPrivateV6(host.slice(1, -1))) {
      throw new Error(`사설·내부 IP로의 요청 차단: ${host}`);
    }
  } else if (V4_LITERAL.test(host) && isPrivateV4(host)) {
    throw new Error(`사설·내부 IP로의 요청 차단: ${host}`);
  }
  return url;
}
