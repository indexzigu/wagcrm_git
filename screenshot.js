 
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
  // Click bypass login if on login page
  const bypass = page.getByText('개발 환경 바이패스 로그인');
  if (await bypass.isVisible({ timeout: 2000 }).catch(() => false)) {
    await bypass.click();
    await page.waitForURL('**/dashboard**', { timeout: 10000 }).catch(() => {});
    await page.waitForLoadState('networkidle');
  }
  await page.screenshot({
    path: '/Users/z9/.gemini/antigravity/brain/3117e502-1288-4130-979e-cc2286d59455/dashboard.png',
    fullPage: true,
  });
  await browser.close();
})();
