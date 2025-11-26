module.exports = {
  root: true,
  extends: '@react-native',
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'all', // Treat caught errors as variables
        caughtErrorsIgnorePattern: '^_', // Ignore caught errors starting with _
      },
    ],
  },
};
