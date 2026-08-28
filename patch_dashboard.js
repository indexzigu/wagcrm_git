const fs = require('fs');
const file = 'src/components/crm/crm-dashboard.tsx';
let content = fs.readFileSync(file, 'utf8');

// 1. Add import
if (!content.includes('useIsMobile')) {
  content = content.replace(
    'import { useCampaigns } from "@/hooks/useCampaigns";',
    'import { useCampaigns } from "@/hooks/useCampaigns";\nimport { useIsMobile } from "@/hooks/use-mobile";'
  );
}

// 2. Add hook call
if (!content.includes('const isMobile = useIsMobile();')) {
  content = content.replace(
    'const [isCreationSheetOpen, setIsCreationSheetOpen] = useState(false);',
    'const [isCreationSheetOpen, setIsCreationSheetOpen] = useState(false);\n  const isMobile = useIsMobile();'
  );
}

// 3. Replace rendering logic
// We need to replace:
// <div className="hidden md:flex min-h-0 ...
// ...
// </div>
// {/* 모바일 뷰 */}
// <div className="block md:hidden">
//   <MobilePipelineView ... />
// </div>

// We will use regex to find and replace.
const desktopRegex = /\{\/\* 데스크톱 뷰 \*\/\}\s*<div className="hidden md:flex([^>]+)>/;
content = content.replace(desktopRegex, '{isMobile ? (\n          <MobilePipelineView\n            campaigns={filteredCampaigns}\n            onOpenCampaign={openCampaign}\n          />\n        ) : (\n          <div className="flex$1>');

const mobileRegex = /\{\/\* 모바일 뷰 \*\/\}\s*<div className="block md:hidden">\s*<MobilePipelineView[\s\S]*?\/>\s*<\/div>/;
content = content.replace(mobileRegex, '        )}');

fs.writeFileSync(file, content, 'utf8');
console.log("Patched crm-dashboard.tsx");
