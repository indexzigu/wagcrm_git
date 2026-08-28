const { chromium } = require('playwright-core');

async function run() {
  console.log("Launching browser...");
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });
  
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.error('PAGE ERROR:', err.message));
  
  try {
    console.log("Navigating to http://127.0.0.1:3000 ...");
    await page.goto('http://127.0.0.1:3000', { waitUntil: 'networkidle', timeout: 15000 });
    console.log("Page loaded successfully!");
    
    const title = await page.title();
    console.log("Page Title:", title);
    
    const screenshotPath = '/Users/z9/.gemini/antigravity/scratch/wag-crm/screenshot_test.png';
    await page.screenshot({ path: screenshotPath });
    console.log("Screenshot saved to:", screenshotPath);
  } catch (error) {
    console.error("Navigation failed:", error);
  } finally {
    await browser.close();
    console.log("Browser closed.");
  }
}

run().catch(console.error);
