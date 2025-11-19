/**
 * @format
 */

// Polyfill for cos-js-sdk-v5 compatibility in React Native

// The SDK expects navigator.userAgent to exist, which it doesn't always in RN.

if (typeof navigator !== 'undefined' && !navigator.userAgent) {

  navigator.userAgent = 'ReactNative'; // Or any non-empty string

}



import {AppRegistry} from 'react-native';

import App from './App';

import {name as appName} from './app.json';



AppRegistry.registerComponent(appName, () => App);


