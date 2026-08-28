const fs = require('fs');
const file = 'src/components/crm/order-dashboard.tsx';
let content = fs.readFileSync(file, 'utf8');

if (!content.includes("import { CrmShell }")) {
  content = content.replace("import React, { useEffect, useState } from 'react';", "import React, { useEffect, useState } from 'react';\nimport { CrmShell } from './crm-shell';\nimport { Button } from '@/components/ui/button';\nimport { PlusIcon } from 'lucide-react';");
  fs.writeFileSync(file, content);
  console.log("Added imports!");
} else {
  console.log("Imports already exist.");
}
