import https from 'https';

const shortcode = 'C6_s-jGv2lJ'; // example
const targetUrl = `https://imginn.com/p/${shortcode}/`;

const options = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  }
};

https.get(targetUrl, options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Status Code:', res.statusCode);
    if (res.statusCode === 200) {
      // Find img src. Imginn usually has <img class="img" src="...">
      const imgMatch = data.match(/<img[^>]+src="([^"]+)"[^>]*>/i);
      if (imgMatch) {
        console.log('Found image:', imgMatch[1]);
      } else {
        console.log('No image found. Data length:', data.length);
      }
    } else {
      console.log('Failed. Status:', res.statusCode);
    }
  });
}).on('error', err => {
  console.error('Error:', err.message);
});
