import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  RESERVED_PORTAL_SLUGS,
  isValidPortalSlug,
  suggestPortalSlug,
  isPortalPublicPath,
  extractPortalSlug,
} from '../portal-slug';

describe('isValidPortalSlug', () => {
  it('계정명 형태의 슬러그를 허용한다', () => {
    for (const ok of ['gaon', 'ga.on', 'na_ri', 'abc-123', '7pick']) {
      expect(isValidPortalSlug(ok), ok).toBe(true);
    }
  });

  it('형식 불량(대문자·한글·짧음·특수문자·선행 기호·연속 점)을 거부한다', () => {
    for (const bad of ['Gaon', '김본명', 'ab', '.abc', 'a b', 'a/b', 'ga..on', 'a'.repeat(32), '']) {
      expect(isValidPortalSlug(bad), bad).toBe(false);
    }
  });

  it('예약어(내부 라우트·정적 경로)를 거부한다', () => {
    for (const reserved of ['sellers', 'api', 'login', 'p', 'settlement', 'dashboard']) {
      expect(isValidPortalSlug(reserved), reserved).toBe(false);
    }
  });
});

describe('RESERVED_PORTAL_SLUGS 계약 — src/app 최상위 라우트는 전부 예약돼야 한다', () => {
  it('src/app 의 모든 최상위 라우트 세그먼트가 예약어에 포함된다 (누락 = 슬러그 선점/공개 오판 위험)', () => {
    const appDir = join(__dirname, '..', '..', 'app');
    const segments = readdirSync(appDir).filter((name) => {
      if (name.startsWith('(') || name.startsWith('[') || name.startsWith('_')) return false;
      return statSync(join(appDir, name)).isDirectory();
    });
    expect(segments.length).toBeGreaterThan(5); // 스캔 자체가 무너지면 계약도 무의미 — sanity
    for (const seg of segments) {
      expect(RESERVED_PORTAL_SLUGS.has(seg), `src/app/${seg} 가 RESERVED_PORTAL_SLUGS 에 없음`).toBe(true);
    }
  });
});

describe('suggestPortalSlug', () => {
  it('SNS 핸들을 정규화한다 (@ 제거·소문자·불용문자 제거)', () => {
    expect(suggestPortalSlug('@Gaon')).toBe('gaon');
    expect(suggestPortalSlug('  na_ri ')).toBe('na_ri');
  });

  it('정규화 불가(한글 핸들 등)면 null', () => {
    expect(suggestPortalSlug('김본명')).toBeNull();
    expect(suggestPortalSlug('')).toBeNull();
    expect(suggestPortalSlug(null)).toBeNull();
  });

  it('예약어로 정규화되면 null (제안 단계에서 걸러 저장 시도 자체를 막는다)', () => {
    expect(suggestPortalSlug('@sellers')).toBeNull();
  });
});

describe('isPortalPublicPath — proxy 공개 경로 판정', () => {
  it('슬러그 루트와 카드 경로만 공개', () => {
    expect(isPortalPublicPath('/gaon')).toBe(true);
    expect(isPortalPublicPath('/gaon/')).toBe(true);
    expect(isPortalPublicPath('/gaon/card/cmr1abc')).toBe(true);
  });

  it('내부 라우트·중첩 경로·형식 불량은 비공개(로그인 게이트 유지)', () => {
    for (const path of [
      '/',
      '/sellers',
      '/sellers/123',
      '/api/sellers',
      '/settlement',
      '/gaon/other',
      '/gaon/card',
      '/Gaon',
      '/p', // 예약 세그먼트 — /p/<token> 공개는 별도 규칙이 담당
    ]) {
      expect(isPortalPublicPath(path), path).toBe(false);
    }
  });
});

describe('extractPortalSlug — isPortalPublicPath 와 같은 판정에서 슬러그 값을 꺼낸다', () => {
  it('슬러그 루트·카드 경로에서 기본 슬러그를 추출한다', () => {
    expect(extractPortalSlug('/gaon')).toBe('gaon');
    expect(extractPortalSlug('/gaon/')).toBe('gaon');
    expect(extractPortalSlug('/gaon/card/cmr1abc')).toBe('gaon');
  });

  it('isPortalPublicPath 가 false 인 경로는 전부 null — 두 함수의 판정이 어긋나지 않는다', () => {
    for (const path of [
      '/',
      '/sellers',
      '/sellers/123',
      '/api/sellers',
      '/settlement',
      '/gaon/other',
      '/gaon/card',
      '/Gaon',
      '/p',
    ]) {
      expect(extractPortalSlug(path), path).toBeNull();
      expect(isPortalPublicPath(path), path).toBe(false);
    }
  });
});
