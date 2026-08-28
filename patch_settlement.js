const fs = require('fs');
const file = 'src/app/settlement/settlement-page-client.tsx';
let content = fs.readFileSync(file, 'utf8');

// 1. Add import
if (!content.includes('useIsMobile')) {
  content = content.replace(
    'import { SettlementMobileList } from "@/components/crm/settlement-mobile-list";',
    'import { SettlementMobileList } from "@/components/crm/settlement-mobile-list";\nimport { useIsMobile } from "@/hooks/use-mobile";'
  );
}

// 2. Add hook call
if (!content.includes('const isMobile = useIsMobile();')) {
  content = content.replace(
    'export function SettlementPageClient({ initialData }: { initialData: SettlementPageData }) {',
    'export function SettlementPageClient({ initialData }: { initialData: SettlementPageData }) {\n  const isMobile = useIsMobile();'
  );
}

// 3. Replace Active Campaigns rendering
const activeDesktopRegex = /\{\/\* 데스크톱 뷰 \*\/\}\s*<div className="hidden md:block">/;
content = content.replace(activeDesktopRegex, '{isMobile ? (\n                      <SettlementMobileList\n                        campaigns={activeCampaigns}\n                        checklists={checklists}\n                        onSelectCampaign={handleSelectCampaign}\n                        onRefresh={handleRefresh}\n                        loading={loading}\n                      />\n                    ) : (\n                    <div className="block">');

const activeMobileRegex = /\{\/\* 모바일 뷰 \*\/\}\s*<div className="block md:hidden">\s*<SettlementMobileList[\s\S]*?loading=\{loading\}\n\s*\/>\s*<\/div>/;
content = content.replace(activeMobileRegex, '                    )}');


// 4. Replace Completed Campaigns rendering
const completedDesktopRegex = /\{\/\* 데스크톱 뷰 \*\/\}\s*<div className="hidden md:block">/;
content = content.replace(completedDesktopRegex, '{isMobile ? (\n                      <SettlementMobileList\n                        campaigns={completedCampaigns}\n                        checklists={checklists}\n                        onSelectCampaign={handleSelectCampaign}\n                        onRefresh={handleRefresh}\n                        loading={loading}\n                      />\n                    ) : (\n                    <div className="block">');

const completedMobileRegex = /<div className="block md:hidden">\s*<SettlementMobileList[\s\S]*?loading=\{loading\}\n\s*\/>\s*<\/div>/;
content = content.replace(completedMobileRegex, '                    )}');

fs.writeFileSync(file, content, 'utf8');
console.log("Patched settlement-page-client.tsx");
