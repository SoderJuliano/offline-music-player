import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'player',
      // This will be our safe, isolated player component
      component: () => import('../views/PlayerView.vue'),
    },
    {
      path: '/mapa',
      name: 'mapa',
      // This is the new, separate page for P2P sharing
      component: () => import('../views/P2PView.vue'),
    },
  ],
});

export default router;