import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import 'intl-pluralrules';
import { getLocales } from 'expo-localization';

// Import translation files
import en from './locales/en.json';
import zh from './locales/zh.json';

const resources = {
  en: {
    translation: en,
  },
  zh: {
    translation: zh,
  },
};

// 跟随系统语言：中文系统用中文，其他用英文（fallback）
const systemLanguageCode = getLocales()[0]?.languageCode ?? 'en';
const defaultLng = systemLanguageCode.toLowerCase().startsWith('zh') ? 'zh' : 'en';

i18n
  .use(initReactI18next) // passes i18n down to react-i18next
  .init({
    resources,
    lng: defaultLng,
    fallbackLng: 'en', // fallback language
    compatibilityJSON: 'v4', // To make it work with Android
    interpolation: {
      escapeValue: false, // react already safes from xss
    },
  });

export default i18n;
