import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import 'intl-pluralrules';

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

i18n
  .use(initReactI18next) // passes i18n down to react-i18next
  .init({
    resources,
    lng: 'zh', // default language
    fallbackLng: 'en', // fallback language
    compatibilityJSON: 'v3', // To make it work with Android
    interpolation: {
      escapeValue: false, // react already safes from xss
    },
  });

export default i18n;
