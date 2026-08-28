const fs = require('fs');

function removeIsMobileBlock(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  const startStr = "  if (isMobile) {";
  const startIndex = content.indexOf(startStr);
  if (startIndex !== -1) {
    const endStr = "  return (";
    const endIndex = content.indexOf(endStr, startIndex);
    if (endIndex !== -1) {
      content = content.substring(0, startIndex) + content.substring(endIndex);
    }
  }
  
  content = content.replace(/const isMobile = useIsMobile\(\);\n\s*/g, '');
  content = content.replace(/import \{ useIsMobile \} from "@\/hooks\/use-mobile";\n/g, '');
  content = content.replace(/import \{ MobilePipelineView \} from "\.\/mobile-pipeline-view";\n/g, '');
  content = content.replace(/import \{ MobileOutreachView \} from "@\/components\/crm\/mobile-outreach-view";\n/g, '');
  
  fs.writeFileSync(filePath, content, 'utf8');
}

removeIsMobileBlock('src/components/crm/crm-dashboard.tsx');
removeIsMobileBlock('src/app/outreach/page.tsx');
