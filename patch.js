const fs = require('fs');

function removeIsMobileBlock(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let startIndex = content.indexOf('  if (isMobile) {');
  if (startIndex === -1) {
    console.log("Not found in", filePath);
    return;
  }
  let endText = "  // ---------------------------------------------------------------------------";
  if (!content.includes(endText)) {
      endText = "  return (";
  }
  let endIndex = content.indexOf(endText, startIndex);
  if (endIndex === -1) {
    console.log("End marker not found in", filePath);
    return;
  }
  
  // isMobile declaration
  content = content.replace(/const isMobile = useIsMobile\(\);\n\s*/, '');
  content = content.replace(/import \{ useIsMobile \} from "@\/hooks\/use-mobile";\n/, '');
  content = content.replace(/import \{ MobilePipelineView \}.*;\n/, '');
  content = content.replace(/import \{ MobileOutreachView \}.*;\n/, '');

  content = content.substring(0, startIndex) + content.substring(endIndex);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log("Patched", filePath);
}

removeIsMobileBlock('src/components/crm/crm-dashboard.tsx');
removeIsMobileBlock('src/app/outreach/page.tsx');
