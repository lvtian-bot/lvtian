import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';

export default {
  input: 'entry.js',
  output: {
    file: '../android/app/src/main/assets/codemirror.bundle.js',
    format: 'iife',
    name: 'CM6', // 全局变量名 window.CM6
    sourcemap: false,
    inlineDynamicImports: true
  },
  plugins: [
    resolve(),
    commonjs(),
    terser() // 压缩代码
  ]
};
