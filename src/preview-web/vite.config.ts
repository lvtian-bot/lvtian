import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
    plugins: [viteSingleFile()],
    root: 'src/preview-web',
    build: {
        outDir: '../../dist-preview-web',
        emptyOutDir: true,
    },
});
