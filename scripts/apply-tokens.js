const fs = require('fs');
const files = process.argv.slice(2);

const IMPORT_LINE = "import { colors as C, fonts as F, sizes as S } from '@/theme.config';";

const replacements = [
  [/const ACCENT = '#00D4AA';?\n?/g, ''],
  [/const ACCENT = '#E8E8E8';?\n?/g, ''],
  [/const FONT = 'GeistPixel-Square';?\n?/g, ''],
  [/'#00D4AA'/g, 'C.accent'],
  [/'#0A0A0A'/g, 'C.bgDeep'],
  [/'#0D0D0D'/g, 'C.bgSidebar'],
  [/'#111111'/g, 'C.bgSurface'],
  [/'#1A1A1A'/g, 'C.border'],
  [/'#E5E7EB'/g, 'C.text1'],
  [/'#6B7280'/g, 'C.text2'],
  [/'#4B5563'/g, 'C.text3'],
  [/'#EF4444'/g, 'C.errorText'],
  [/'#FBBF24'/g, 'C.warning'],
  [/'#F59E0B'/g, 'C.warning'],
  [/fontFamily: 'PressStart2P'/g, "fontFamily: F.family"],
  [/fontFamily: 'GeistPixel-Square'/g, "fontFamily: F.family"],
];

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  
  if (!content.includes("from '@/theme.config'")) {
    const lines = content.split('\n');
    let lastImportIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].match(/from\s+'[^']+';?\s*$/)) {
        lastImportIdx = i;
      }
    }
    if (lastImportIdx >= 0) {
      lines.splice(lastImportIdx + 1, 0, IMPORT_LINE);
      content = lines.join('\n');
    }
  }
  
  for (const [pattern, replacement] of replacements) {
    content = content.replace(pattern, replacement);
  }
  
  fs.writeFileSync(file, content);
  console.log('Updated:', file);
}
