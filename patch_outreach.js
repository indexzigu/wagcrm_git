const fs = require('fs');
const file = 'src/app/outreach/page.tsx';
let content = fs.readFileSync(file, 'utf8');

// 1. Add import
if (!content.includes('useIsMobile')) {
  content = content.replace(
    'import { OutreachList } from "@/components/crm/outreach-list";',
    'import { OutreachList } from "@/components/crm/outreach-list";\nimport { useIsMobile } from "@/hooks/use-mobile";'
  );
}

// 2. Add hook call
if (!content.includes('const isMobile = useIsMobile();')) {
  content = content.replace(
    'export default function OutreachPage() {',
    'export default function OutreachPage() {\n  const isMobile = useIsMobile();'
  );
}

// 3. Replace rendering logic
// Desktop
const desktopRegex = /\{\/\* 데스크톱 뷰 \*\/\}\s*<div className="hidden md:flex([^>]+)>/;
content = content.replace(desktopRegex, '{isMobile ? (\n          <MobileOutreachView\n            tasks={initialTasks}\n            loading={false}\n            onSelectTask={() => {}}\n            onReminderSent={async () => {}}\n            onCreateCampaign={async () => {}}\n            onStatusChange={async () => {}}\n          />\n        ) : (\n          <div className="flex$1>');

// Mobile
const mobileRegex = /\{\/\* 모바일 뷰 \*\/\}\s*<div className="block md:hidden">\s*<MobileOutreachView[\s\S]*?\/>\s*<\/div>/;
content = content.replace(mobileRegex, '        )}');

fs.writeFileSync(file, content, 'utf8');
console.log("Patched outreach/page.tsx");
