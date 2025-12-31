const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '../../dist-web/index.html');
const outputPath = path.join(__dirname, 'editorHtml.ts');

try {
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');
    const tsContent = `export const editorHtml = ${JSON.stringify(htmlContent)};`;
    fs.writeFileSync(outputPath, tsContent);
    console.log('Successfully generated editorHtml.ts');
} catch (error) {
    // If file not found (first run), just warn
    if (error.code === 'ENOENT') {
        console.warn('Warning: dist-web/index.html not found. This is expected on first run before build.');
        // Write an empty placeholder to prevent TS errors on first clone
        fs.writeFileSync(outputPath, "export const editorHtml = '';");
    } else {
        console.error('Error generating editorHtml.ts:', error);
        process.exit(1);
    }
}
