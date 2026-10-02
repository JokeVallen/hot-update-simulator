// 支持的语言列表
export const locales = ['en', 'zh-CN'];
export const defaultLocale = 'zh-CN';

let currentLocale = defaultLocale;
let messages = {};

// 加载语言包（Vite 支持直接 import JSON）
async function loadLocale(locale) {
    try {
        const module = await import(`./${locale}.json`);
        messages = module.default;
        currentLocale = locale;
        return messages;
    } catch (err) {
        console.error(`Failed to load locale: ${locale}`, err);
        // fallback 到默认语言
        if (locale !== defaultLocale) {
            return loadLocale(defaultLocale);
        }
        return {};
    }
}

// 获取翻译文本，支持嵌套路径，例如 'nav.presets'
export function t(key, params = {}) {
    let text = messages[key] || key;
    Object.keys(params).forEach(param => {
        text = text.replace(`{${param}}`, params[param]);
    });
    return text;
}

// 替换页面中所有带有 data-i18n 属性的元素文本
export function translatePage() {
    const elements = document.querySelectorAll('[data-i18n]');
    elements.forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (key) {
            const text = t(key);
            // 如果元素是 input/textarea，使用 placeholder 或 value
            if (el.tagName === 'INPUT' && el.hasAttribute('placeholder')) {
                el.placeholder = text;
            } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                el.value = text;
            } else {
                el.innerText = text;
            }
        }
    });
    // 处理动态生成的标题（document.title）
    const titleKey = document.querySelector('title')?.getAttribute('data-i18n');
    if (titleKey) {
        document.title = t(titleKey);
    }
}

// 切换语言
export async function setLocale(locale) {
    if (!locales.includes(locale)) {
        console.warn(`Unsupported locale: ${locale}`);
        return false;
    }
    await loadLocale(locale);
    translatePage();
    // 触发自定义事件，方便其他模块监听语言变化
    window.dispatchEvent(new CustomEvent('localeChanged', { detail: { locale } }));
    return true;
}

// 初始化：加载默认语言并翻译页面
export async function initI18n() {
    await loadLocale(defaultLocale);
    translatePage();
}