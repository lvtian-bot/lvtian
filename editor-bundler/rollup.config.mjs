import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';

export default {
  input: 'entry.js',
  output: {
    file: '../assets/codemirror.bundle.js',
    format: 'iife',
    name: 'CM6', // 全局变量名 window.CM6
    sourcemap: false,
    inlineDynamicImports: true
  },
  plugins: [
    resolve(),
    commonjs(),
    {
      name: 'replace-http-with-https',
      renderChunk(code) {
        return code.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, 'https://www.w3.org/2000/svg');
      }
    },
    terser() // 压缩代码
  ]
};
