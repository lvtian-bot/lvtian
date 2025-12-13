const fs = require('fs');
const path = require('path');

const bundlePath = path.join(__dirname, '../assets/codemirror.bundle.js');
const htmlPath = path.join(__dirname, '../assets/editor.html');

console.log('Combining bundle into editor.html...');

try {
    if (!fs.existsSync(bundlePath)) {
        console.error('Error: codemirror.bundle.js not found. Run build first.');
        process.exit(1);
    }

    const bundleContent = fs.readFileSync(bundlePath, 'utf8');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    console.log(`Current editor.html size: ${(htmlContent.length / 1024 / 1024).toFixed(2)} MB`);

    // robustly replace the CM6 script block
    // We look for the structure: ... <div id="editor"></div> ... <script>...var CM6... </script> ... </body>
    // We will keep everything up to <div id="editor"></div> including that tag.
    // And everything from </body> onwards.

    // NOTE: The previous script might have been appended multiple times or corrupted?
    // Let's assume the header part is small and correct at the beginning.

    const startAnchor = '<div id="editor"></div>';
    const endAnchor = '</body>'; // We'll look for the LAST </body> to be safe, or just the first if we assume structure.

    // To repair the file, we want to find the FIRST occurrence of startAnchor
    // And the LAST occurrence of endAnchor? 
    // Actually, if the file is valid HTML, it should have one body.
    // If it was appended, it might have multiple </body>.

    const startIndex = htmlContent.indexOf(startAnchor);
    const endIndex = htmlContent.lastIndexOf(endAnchor);

    if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
        // Keep header
        const pre = htmlContent.substring(0, startIndex + startAnchor.length);
        // Keep footer
        const post = htmlContent.substring(endIndex);

        console.log('Found anchors. Constructing new HTML...');

        const glueCode = `
    // Glue Code to bridge CodeMirror and React Native
    (function() {
        const postMessage = (data) => {
            if (window.ReactNativeWebView) {
                window.ReactNativeWebView.postMessage(JSON.stringify(data));
            }
        };

        let editor;

        function init() {
            try {
                if (!window.CM6 || !window.CM6.createEditor) {
                    postMessage({ type: 'error', content: 'CM6 library not loaded' });
                    return;
                }

                editor = window.CM6.createEditor(document.getElementById('editor'), '', {
                    onUpdate: (content) => {
                        postMessage({ type: 'autoSave', content: content });
                    }
                });

                // Global helper for React Native injectJavaScript
                window.getContent = function() {
                    const content = editor.getContent();
                    postMessage({ type: 'manualSave', content: content });
                    return content;
                };

                window.setContent = function(content) {
                    editor.setContent(content);
                };

                // Message handling for React Native
                const handleMessage = (event) => {
                    try {
                        const content = event.data;
                        if (typeof content === 'string') {
                             editor.setContent(content);
                        }
                    } catch (err) {
                        postMessage({ type: 'error', content: 'Failed to handle message: ' + err.message });
                    }
                };
                
                // Support both standard and RN specific events
                document.addEventListener("message", handleMessage);
                window.addEventListener("message", handleMessage);

            } catch (e) {
                postMessage({ type: 'error', content: 'Init error: ' + e.message });
            }
        }

        // Initialize when DOM is ready
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            init();
        } else {
            document.addEventListener('DOMContentLoaded', init);
        }
    })();
`;

        const newScriptBlock = `
    <script>
${bundleContent}

${glueCode}
    </script>
`;
        // Check resultant size estimation
        const newSize = pre.length + newScriptBlock.length + post.length;
        console.log(`Estimated new size: ${(newSize / 1024 / 1024).toFixed(2)} MB`);

        const newHtml = pre + newScriptBlock + post;
        fs.writeFileSync(htmlPath, newHtml);
        console.log('Success: editor.html repaired and updated.');
    } else {
        console.error('Error: Could not find acceptable start/end anchors in editor.html.');
        console.log(`Start index: ${startIndex}, End index: ${endIndex}`);
        process.exit(1);
    }

} catch (err) {
    console.error('Error processing files:', err);
    process.exit(1);
}
