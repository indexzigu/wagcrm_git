import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const envConfig = dotenv.parse(fs.readFileSync(path.resolve('.env.local')));
const token = envConfig.INSTAGRAM_ACCESS_TOKEN;
const url = 'https://www.instagram.com/p/C6_s-jGv2lJ/';

if (!token) {
  console.log('No INSTAGRAM_ACCESS_TOKEN found.');
  process.exit(1);
}

const endpoint = `https://graph.facebook.com/v20.0/instagram_oembed?url=${encodeURIComponent(url)}&access_token=${token}`;

fetch(endpoint)
  .then(res => res.json())
  .then(data => {
    console.log(JSON.stringify(data, null, 2));
  })
  .catch(err => {
    console.error('Error:', err);
  });
