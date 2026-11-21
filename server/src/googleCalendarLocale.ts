import { createInstance } from 'i18next';

const resources = {
    en: { translation: { returnToApp: 'Return to Lvtian to check the connection status.' } },
    zh: { translation: { returnToApp: '请返回绿天 App 查看连接状态。' } },
};
const i18n = createInstance();
await i18n.init({ resources, fallbackLng: 'en', initAsync: false });

export function calendarCallbackLocale(header?: string): { language: 'en' | 'zh'; text: string } {
    const preferences = (header ?? '').split(',').map(entry => {
        const [tag, weight] = entry.trim().toLowerCase().split(';').map(part => part.trim());
        const q = weight === undefined ? 1 : /^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(weight) ? Number(weight.slice(2)) : 0;
        return { language: tag.split('-')[0], q };
    }).filter(({ q }) => q > 0).sort((a, b) => b.q - a.q);
    const preferred = preferences.find(({ language }) => language === 'zh' || language === 'en')?.language;
    const language = preferred === 'zh' ? 'zh' : 'en';
    return { language, text: i18n.getFixedT(language)('returnToApp') };
}
