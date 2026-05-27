import { createApp } from 'vue'
import App from './App.vue'
import i18n from './i18n'
import router from './router'

createApp(App).use(i18n).use(router).mount('#app')

// Lógica para atualização automática do PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Recarrega a página quando um novo Service Worker assume o controle
    window.location.reload()
  })

  // Verifica periodicamente por atualizações (opcional, mas recomendado)
  window.addEventListener('load', () => {
    navigator.serviceWorker.getRegistration().then((registration) => {
      if (registration) {
        // Verifica se há atualização a cada 1 hora se o app ficar aberto muito tempo
        setInterval(() => {
          registration.update()
        }, 60 * 60 * 1000)
      }
    })
  })
}
