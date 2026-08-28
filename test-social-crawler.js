import https from 'https';

const TEST_URL = 'https://www.instagram.com/p/C6_s-jGv2lJ/';

const CRAWLERS = [
  { name: 'WhatsApp', ua: 'WhatsApp/2.21.12.21 A' },
  { name: 'Facebook', ua: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
  { name: 'Twitter', ua: 'Twitterbot/1.0' },
  { name: 'Google', ua: 'Googlebot/2.1 (+http://www.google.com/bot.html)' }
];

async function testCrawlers() {
  console.log('=== 소셜 크롤러 위장 테스트 ===');
  console.log('목표: 인스타그램이 카카오톡/페이스북 등에만 썸네일을 허용하는지 확인\n');

  for (const crawler of CRAWLERS) {
    console.log(`[테스트] ${crawler.name} 봇으로 위장 중...`);
    
    await new Promise(resolve => {
      https.get(TEST_URL, { headers: { 'User-Agent': crawler.ua } }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const ogMatch = data.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
          if (ogMatch) {
            console.log(`✅ 성공 (${crawler.name}): 썸네일 발견! -> ${ogMatch[1].substring(0, 50)}...`);
          } else {
            console.log(`❌ 실패 (${crawler.name}): Status ${res.statusCode}, og:image 없음`);
          }
          console.log('---');
          resolve();
        });
      }).on('error', err => {
        console.log(`❌ 에러: ${err.message}`);
        resolve();
      });
    });
  }
}

testCrawlers();
