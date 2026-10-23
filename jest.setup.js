/* eslint-env jest */
require('react-native-gesture-handler/jestSetup');

jest.mock('react-native-reanimated', () => ({
  useSharedValue: (value) => ({ value }),
  withTiming: (value) => value,
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('react-native-webview', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    WebView: React.forwardRef((props, ref) => React.createElement(View, { ...props, ref })),
    default: React.forwardRef((props, ref) => React.createElement(View, { ...props, ref })),
  };
});

// react-native-keyboard-controller 为原生模块，Jest 环境以普通 View 代替
jest.mock('react-native-keyboard-controller', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    KeyboardAvoidingView: (props) => React.createElement(View, props),
    KeyboardChatScrollView: React.forwardRef((props, ref) => React.createElement(View, { ...props, ref })),
    KeyboardStickyView: (props) => React.createElement(View, props),
    KeyboardAwareScrollView: (props) => React.createElement(View, props),
    KeyboardProvider: (props) => React.createElement(View, props),
  };
});
