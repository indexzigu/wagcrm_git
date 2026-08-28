import { beforeAll, describe, expect, it } from 'vitest';
import {
  hashPortalPassword,
  verifyPortalPassword,
  generatePortalPassword,
  createPortalSessionValue,
  verifyPortalSessionValue,
  PORTAL_SESSION_MAX_AGE_SEC,
} from '../portal-auth';

beforeAll(() => {
  // 세션 서명 키 — 실제 배포에선 PORTAL_SESSION_SECRET 또는 SUPABASE_SERVICE_ROLE_KEY 파생
  process.env.PORTAL_SESSION_SECRET = 'test-portal-session-secret-0123456789';
});

describe('포털 비밀번호 해시', () => {
  it('bcrypt 라운드트립 — 평문은 저장되지 않고 해시만으로 검증된다', async () => {
    const pw = generatePortalPassword();
    const hash = await hashPortalPassword(pw);
    expect(hash).not.toContain(pw);
    expect(await verifyPortalPassword(pw, hash)).toBe(true);
    expect(await verifyPortalPassword(pw + 'x', hash)).toBe(false);
  });

  it('생성 비밀번호는 10자·헷갈리는 글자(0/O/1/l) 없음', () => {
    for (let i = 0; i < 20; i++) {
      const pw = generatePortalPassword();
      expect(pw).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{10}$/);
    }
  });
});

describe('포털 세션 쿠키 (HMAC 서명)', () => {
  const sellerId = 'seller_1';
  const otherSeller = 'seller_2';

  it('발급 → 검증 라운드트립', async () => {
    const hash = await hashPortalPassword('pw');
    const value = createPortalSessionValue(sellerId, hash);
    expect(verifyPortalSessionValue(value, sellerId, hash)).toBe(true);
  });

  it('다른 셀러의 쿠키는 거부한다', async () => {
    const hash = await hashPortalPassword('pw');
    const value = createPortalSessionValue(sellerId, hash);
    expect(verifyPortalSessionValue(value, otherSeller, hash)).toBe(false);
  });

  it('페이로드 변조(서명 불일치)를 거부한다', async () => {
    const hash = await hashPortalPassword('pw');
    const value = createPortalSessionValue(sellerId, hash);
    const [data, mac] = [value.slice(0, value.lastIndexOf('.')), value.slice(value.lastIndexOf('.') + 1)];
    const forged = Buffer.from(JSON.stringify({ sid: otherSeller, exp: 9999999999, pv: 'x' })).toString('base64url');
    expect(verifyPortalSessionValue(`${forged}.${mac}`, otherSeller, hash)).toBe(false);
    expect(verifyPortalSessionValue(`${data}.AAAA`, sellerId, hash)).toBe(false);
  });

  it('만료된 세션을 거부한다', async () => {
    const hash = await hashPortalPassword('pw');
    const issuedLongAgo = Date.now() - (PORTAL_SESSION_MAX_AGE_SEC + 60) * 1000;
    const value = createPortalSessionValue(sellerId, hash, issuedLongAgo);
    expect(verifyPortalSessionValue(value, sellerId, hash, Date.now())).toBe(false);
  });

  it('비밀번호 재발급(해시 변경) 시 기존 세션이 전부 무효화된다', async () => {
    const oldHash = await hashPortalPassword('old');
    const newHash = await hashPortalPassword('new');
    const value = createPortalSessionValue(sellerId, oldHash);
    expect(verifyPortalSessionValue(value, sellerId, newHash)).toBe(false);
  });

  it('비밀번호 미설정(null 해시)이나 빈 쿠키는 항상 거부', () => {
    expect(verifyPortalSessionValue(undefined, sellerId, null)).toBe(false);
    expect(verifyPortalSessionValue('garbage', sellerId, null)).toBe(false);
  });
});
