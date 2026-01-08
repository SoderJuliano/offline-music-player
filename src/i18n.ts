import { createI18n } from 'vue-i18n'
import en from './locales/en.json'
import ptBR from './locales/pt-BR.json'

const userLang = navigator.language

const i18n = createI18n({
  legacy: false, // Use Composition API for Vue 3
  locale: userLang.startsWith('pt') ? 'pt-BR' : 'en',
  fallbackLocale: 'en', // Fallback to English if a translation is missing
  messages: {
    en: en,
    'pt-BR': ptBR,
  },
})

export default i18n
