const fs = require('fs');
const path = require('path');

const filesToCheck = [
  path.join(__dirname, 'assets', 'codemirror.bundle.js'),
  path.join(__dirname, 'assets', 'editor.html')
];

filesToCheck.forEach(filePath => {
  console.log(`\nChecking file: ${filePath}`);
  try {
    if (!fs.existsSync(filePath)) {
      console.log('File not found.');
      return;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const searchString = 'http://';
    let index = content.indexOf(searchString);

    if (index === -1) {
      console.log('No "http://" found.');
    } else {
      console.log('Found occurrences:');
      while (index !== -1) {
        const start = Math.max(0, index - 50);
        const end = Math.min(content.length, index + 50);
        console.log(`--- Index ${index} ---`);
        console.log(content.substring(start, end));
        index = content.indexOf(searchString, index + 1);
      }
    }
  } catch (err) {
    console.error('Error reading file:', err);
  }
});
