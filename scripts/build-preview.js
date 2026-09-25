const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const tmpDir = path.join(__dirname, '../.tmp');
if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
}
process.env.TEMP = tmpDir;
process.env.TMP = tmpDir;

execSync('tsc --noEmit', { stdio: 'inherit' });
execSync('vite build --config src/preview-web/vite.config.ts', { stdio: 'inherit' });
require('../src/preview-web/generate-html.js');
