import https from 'https';

const url = 'https://www.instagram.com/p/C6_s-jGv2lJ/';
const options = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
  }
};

https.get(url, options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Status Code:', res.statusCode);
    const ogImageMatch = data.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
    if (ogImageMatch) {
      console.log('Found og:image:', ogImageMatch[1]);
    } else {
      console.log('og:image not found. Length of data:', data.length);
      // console.log(data.slice(0, 1000));
    }
  });
}).on('error', err => {
  console.error('Error:', err.message);
});
