const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '../../dist-preview-web/index.html');
const outputPath = path.join(__dirname, 'previewHtml.ts');

try {
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');
    const tsContent = `export const previewHtml = ${JSON.stringify(htmlContent)};\n`;
    fs.writeFileSync(outputPath, tsContent);
    console.log('Successfully generated previewHtml.ts');
} catch (error) {
    if (error.code === 'ENOENT') {
        console.warn('Warning: dist-preview-web/index.html not found. This is expected on first run before build.');
        fs.writeFileSync(outputPath, "export const previewHtml = '';\n");
    } else {
        console.error('Error generating previewHtml.ts:', error);
        process.exit(1);
    }
}
