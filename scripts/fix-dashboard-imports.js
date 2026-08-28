const fs = require('fs');
const path = require('path');

function replaceImports(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  // @/lib/export-utils -> @/lib/order-converter/export-utils
  if (content.includes('@/lib/export-utils')) {
    content = content.replace(/@\/lib\/export-utils/g, '@/lib/order-converter/export-utils');
    changed = true;
  }
  // @/lib/order-parser -> @/lib/order-converter/order-parser
  if (content.includes('@/lib/order-parser')) {
    content = content.replace(/@\/lib\/order-parser/g, '@/lib/order-converter/order-parser');
    changed = true;
  }
  // @/lib/naver-commerce-api -> @/lib/order-converter/naver-commerce-api
  if (content.includes('@/lib/naver-commerce-api')) {
    content = content.replace(/@\/lib\/naver-commerce-api/g, '@/lib/order-converter/naver-commerce-api');
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('Fixed', filePath);
  }
}

function walk(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      walk(fullPath);
    } else if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) {
      replaceImports(fullPath);
    }
  }
}

walk('src/components/crm');
walk('src/hooks');

