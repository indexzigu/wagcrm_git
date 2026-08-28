import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { isBotScanPath, __testing } from '../bot-scan-paths';
import { RESERVED_PORTAL_SLUGS, isValidPortalSlug } from '../portal-slug';

const { BOT_SCAN_SEGMENTS } = __testing;

describe('isBotScanPath — prod 실측 표적을 끊는다', () => {
  // 2026-08-02 prod 실측: 아래 두 경로가 **200 + 49KB** 를 받고 있었다(셀러 포털 catch-all
  // → auth 왕복 → DB 조회 → PPR 셸이 이미 나가 notFound() 가 상태를 못 바꿈).
  it('실측된 스캐너 경로를 봇으로 판정한다', () => {
    for (const path of ['/wp-admin', '/xmlrpc.php', '/wp-login.php', '/.env', '/.git/config']) {
      expect(isBotScanPath(path), path).toBe(true);
    }
  });

  it('⚠️ 이 판정을 통과하는 경로들이 실제로 슬러그 형식이었다 — 그래서 200 이 나왔다', () => {
    // 이 단언이 깨지면 "봇이 왜 포털로 들어갔는가"의 전제가 사라진 것이다(회귀가 아니라
    // 구조 변경이므로 판정 자체를 다시 설계할 것).
    expect(isValidPortalSlug('wp-admin')).toBe(true);
    expect(isValidPortalSlug('xmlrpc.php')).toBe(true);
  });

  it('확장자·CMS 세그먼트를 대소문자 무시로 판정한다', () => {
    for (const path of ['/WP-Admin', '/XMLRPC.PHP', '/backup.SQL', '/shell.Php']) {
      expect(isBotScanPath(path), path).toBe(true);
    }
  });

  it('중간 세그먼트에 표적이 있어도 잡는다', () => {
    expect(isBotScanPath('/foo/wp-admin/install.php')).toBe(true);
    expect(isBotScanPath('/a/b/.git/HEAD')).toBe(true);
  });
});

describe('음성 대조군 — 앱이 실제로 서빙하는 것을 죽이면 안 된다', () => {
  it('공개 정적·메타 경로는 봇이 아니다', () => {
    for (const path of [
      '/robots.txt', // 미들웨어가 인증에서 제외한 크롤러 지시문 — 죽으면 전면 스캔이 되돌아온다
      '/sitemap.xml',
      '/manifest.webmanifest',
      '/favicon.ico',
      '/.well-known/apple-app-site-association',
      '/icon-192.png',
      '/monitoring', // Sentry 터널
    ]) {
      expect(isBotScanPath(path), path).toBe(false);
    }
  });

  it('셀러 슬러그는 점을 포함할 수 있다 — 점만으로 봇 판정하지 않는다', () => {
    for (const path of ['/ga.on', '/user.name', '/some.seller', '/na_ri', '/abc-123']) {
      expect(isBotScanPath(path), path).toBe(false);
    }
  });

  it('루트와 앱 내부 경로는 봇이 아니다', () => {
    for (const path of ['/', '/login', '/api/agenda', '/p/abc123', '/sellers/1', '/reports/pnl']) {
      expect(isBotScanPath(path), path).toBe(false);
    }
  });
});

describe('계약 — 봇 세그먼트는 실재 라우트를 침범하지 않는다', () => {
  it('BOT_SCAN_SEGMENTS ∩ RESERVED_PORTAL_SLUGS = ∅ (겹치면 실재 라우트가 404 된다)', () => {
    const overlap = [...BOT_SCAN_SEGMENTS].filter((s) => RESERVED_PORTAL_SLUGS.has(s));
    expect(overlap, `겹침: ${overlap.join(', ')}`).toEqual([]);
  });

  it('src/app 의 어떤 최상위 라우트도 봇으로 판정되지 않는다', () => {
    const appDir = join(__dirname, '..', '..', 'app');
    const segments = readdirSync(appDir).filter((name) => {
      if (name.startsWith('(') || name.startsWith('[') || name.startsWith('_')) return false;
      return statSync(join(appDir, name)).isDirectory();
    });
    expect(segments.length).toBeGreaterThan(5); // 스캔이 무너지면 계약도 무의미 — sanity
    for (const seg of segments) {
      expect(isBotScanPath(`/${seg}`), `src/app/${seg} 가 봇으로 판정됨`).toBe(false);
    }
  });
});
