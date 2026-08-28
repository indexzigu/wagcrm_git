import { describe, it, expect } from "vitest";
import { assertPublicHttpUrl } from "../ssrf-guard";

describe("assertPublicHttpUrl", () => {
  describe("허용 — 공개 http/https URL은 파싱된 URL을 반환", () => {
    it.each([
      "https://wsrv.nl/?w=360&url=https%3A%2F%2Fexample.com%2Fa.jpg",
      "https://scontent-ssn1-1.cdninstagram.com/v/t51.jpg?x=1",
      "https://instagram.fsel3-1.fna.fbcdn.net/v/t51.jpg",
      "https://img.youtube.com/vi/abc/hqdefault.jpg",
      "http://93.184.216.34/a.jpg", // 공인 IPv4 리터럴은 허용
      "http://172.32.0.1/", // 172.16/12 대역 바로 바깥(경계값)
      "http://[2606:4700::6810:84e5]/", // 공인 IPv6
    ])("%s", (url) => {
      const parsed = assertPublicHttpUrl(url);
      expect(parsed).toBeInstanceOf(URL);
    });

    it("반환된 URL은 정규화된 파싱 결과다", () => {
      expect(assertPublicHttpUrl("https://wsrv.nl/?w=360").hostname).toBe("wsrv.nl");
    });
  });

  describe("거부 — 파싱 불가·비http 스킴", () => {
    it("파싱 불가 문자열", () => {
      expect(() => assertPublicHttpUrl("not a url")).toThrow(/파싱 불가/);
    });
    it.each(["javascript:alert(1)", "data:image/png;base64,AAAA", "ftp://example.com/a.jpg", "file:///etc/passwd"])(
      "%s",
      (url) => {
        expect(() => assertPublicHttpUrl(url)).toThrow(/스킴 불허/);
      }
    );
  });

  describe("거부 — 사설·내부 IPv4 리터럴", () => {
    it.each([
      "http://10.0.0.1/",
      "http://10.255.255.255/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.0.10/admin",
      "http://127.0.0.1:8080/",
      "http://169.254.169.254/latest/meta-data/", // 클라우드 메타데이터
      "http://0.0.0.0:3000/",
    ])("%s", (url) => {
      expect(() => assertPublicHttpUrl(url)).toThrow(/사설·내부 IP/);
    });
  });

  describe("거부 — 우회 표기 (WHATWG URL 정규화로 잡힘)", () => {
    it.each([
      "http://2130706433/", // 정수형 127.0.0.1
      "http://0x7f000001/", // 16진 127.0.0.1
      "http://0177.0.0.1/", // 8진 첫 옥텟
      "http://0xA9.0xFE.0xA9.0xFE/", // 16진 169.254.169.254
    ])("%s", (url) => {
      expect(() => assertPublicHttpUrl(url)).toThrow(/사설·내부 IP/);
    });
  });

  describe("거부 — 사설·내부 IPv6 리터럴", () => {
    it.each([
      "http://[::1]/", // 루프백
      "http://[::]/", // 미지정
      "http://[fe80::1]/", // 링크로컬
      "http://[febf::1]/", // 링크로컬 대역 상한
      "http://[fd00::1]/", // ULA
      "http://[fc00::1]/", // ULA 대역 하한
      "http://[::ffff:127.0.0.1]/", // IPv4-mapped 루프백
      "http://[::ffff:10.0.0.1]/", // IPv4-mapped RFC1918
      "http://[::ffff:a9fe:a9fe]/", // IPv4-mapped 169.254.169.254 (hex 표기)
      "http://[::127.0.0.1]/", // IPv4-compat 루프백 (R3 후속 리뷰 Major — ::7f00:1로 직렬화)
      "http://[::7f00:1]/", // 위와 동일 주소의 hex 직렬화 형태
      "http://[::a9fe:a9fe]/", // IPv4-compat 169.254.169.254
      "http://[::a]/", // IPv4-compat 0.0.0.10 (0/8)
      "http://[0:0:0:0:0:0:0:1]/", // ::1의 확장 표기 (축약형으로 재직렬화됨)
    ])("%s", (url) => {
      expect(() => assertPublicHttpUrl(url)).toThrow(/사설·내부 IP/);
    });

    it("링크로컬 대역 밖 fec0::은 허용(deprecated site-local은 차단 대상 아님)", () => {
      expect(() => assertPublicHttpUrl("http://[fec0::1]/")).not.toThrow();
    });
  });

  describe("거부 — localhost 호스트명", () => {
    it.each([
      "http://localhost:3000/",
      "http://api.localhost/",
      "http://localhost./", // FQDN 후행점 우회 (R3 후속 리뷰 Major — named host는 후행점 보존)
      "http://api.localhost./",
    ])("%s", (url) => {
      expect(() => assertPublicHttpUrl(url)).toThrow(/내부 호스트/);
    });
  });

  describe("회귀 방어 — 방어됨이 실측 확인된 케이스 고정", () => {
    it("userinfo 삽입은 hostname 기준으로 판정된다", () => {
      expect(() => assertPublicHttpUrl("http://safe.com@10.0.0.1/")).toThrow(/사설·내부 IP/);
    });
    it.each(["http://127.1/", "http://10.1/"])("IPv4 축약형 %s (WHATWG가 4옥텟으로 정규화)", (url) => {
      expect(() => assertPublicHttpUrl(url)).toThrow(/사설·내부 IP/);
    });
    it("172.16/12 하한 바로 아래(172.15.255.255)는 허용", () => {
      expect(() => assertPublicHttpUrl("http://172.15.255.255/")).not.toThrow();
    });
  });
});
