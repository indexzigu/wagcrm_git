const fs = require('fs');

const files = [
  'src/app/settlement/settlement-page-client.tsx',
  'src/lib/settlement-statement.ts'
];

files.forEach(file => {
  if (fs.existsSync(file)) {
    let content = fs.readFileSync(file, 'utf8');
    content = content.replace(/자사 순수수료율/g, '영업이익율');
    fs.writeFileSync(file, content, 'utf8');
    console.log("Updated " + file);
  }
});
