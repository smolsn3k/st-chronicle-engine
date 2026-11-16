/**
 * Tiny i18n layer for Chronicle Engine.
 *
 * English strings are the keys, so a missing translation simply falls back
 * to the English text. To add a language, create locales/<code>.js with an
 * object of { 'English text': 'Translation' } and register it in DICTS below.
 * Placeholders look like {name}.
 */
import ru from './locales/ru.js';

export const LANGUAGES = [
    { id: 'auto', name: 'Auto' },
    { id: 'en', name: 'English' },
    { id: 'ru', name: 'Русский' },
];

const DICTS = { ru };
let current = 'en';

/** Follow SillyTavern's UI language, then the browser language. */
export function detectLanguage() {
    let raw = '';
    try { raw = localStorage.getItem('language') || ''; } catch { /* storage may be blocked */ }
    if (!raw) raw = navigator.language || '';
    const code = raw.toLowerCase().split(/[-_]/)[0];
    return DICTS[code] ? code : 'en';
}

export function setLanguage(pref) {
    const id = !pref || pref === 'auto' ? detectLanguage() : pref;
    current = id === 'en' || DICTS[id] ? id : 'en';
}

export const getLanguage = () => current;

/** Translate a key and fill {placeholders}. */
export function tr(key, params) {
    const dict = DICTS[current];
    let s = (dict && dict[key]) || key;
    if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
    return s;
}
