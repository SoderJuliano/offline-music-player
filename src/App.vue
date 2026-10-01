<template>
  <router-view />

  <!-- Global Toast Notification -->
  <div v-if="transferService.toastMessage.value" 
       :class="['global-toast', `toast-${transferService.toastMessage.value.type}`]">
    <span>{{ transferService.toastMessage.value.text }}</span>
  </div>

  <!-- Global Floating Transfer Status Bar (visible across Player and Map) -->
  <div v-if="transferService.incoming.active" class="floating-transfer-pill incoming">
    <div class="pill-content">
      <div class="pill-header">
        <span class="pill-title">⬇️ <strong>{{ transferService.incoming.playlistName }}</strong></span>
        <span class="pill-percent">{{ transferService.incoming.overallPercent }}%</span>
      </div>
      <div class="pill-progress-bg">
        <div class="pill-progress-bar" :style="{ width: transferService.incoming.overallPercent + '%' }"></div>
      </div>
      <div class="pill-details">
        <span class="pill-song">{{ transferService.incoming.currentSongTitle }}</span>
        <span class="pill-time" v-if="transferService.incoming.timeRemaining">{{ transferService.incoming.timeRemaining }}</span>
      </div>
    </div>
    <button class="pill-cancel-btn" @click="transferService.cancelIncomingTransfer" title="Cancelar download">✕</button>
  </div>

  <!-- Outgoing Transfer Indicator -->
  <div v-if="transferService.outgoing.active" class="floating-transfer-pill outgoing">
    <div class="pill-content">
      <div class="pill-header">
        <span class="pill-title">⬆️ Enviando <strong>{{ transferService.outgoing.playlistName }}</strong></span>
        <span class="pill-percent">{{ transferService.outgoing.overallPercent }}%</span>
      </div>
      <div class="pill-progress-bg">
        <div class="pill-progress-bar outgoing-bar" :style="{ width: transferService.outgoing.overallPercent + '%' }"></div>
      </div>
      <div class="pill-details">
        <span class="pill-song">{{ transferService.outgoing.currentSongTitle }}</span>
      </div>
    </div>
    <button class="pill-cancel-btn" @click="transferService.cancelOutgoingTransfer" title="Cancelar envio">✕</button>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { p2pService } from './services/p2p';
import { transferService } from './services/transfer';
import { PlaylistService } from './services/playlist';

// Detectar tipo de dispositivo
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.userAgent.includes("Mac") && "ontouchend" in document);
const deviceType = isMobile ? 'phone' : 'desktop';
const playlistService = new PlaylistService();

onMounted(async () => {
  console.log('[App] Initializing P2P and Transfer services...');
  
  // Inicializar serviço P2P
  await p2pService.init();

  // Enviar localização inicial se disponível
  if ('geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition(pos => {
      const location = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      p2pService.getAllPeerIds().forEach(peerId => {
        p2pService.sendTo(peerId, { 
          type: 'location', 
          payload: { ...location, device: deviceType } 
        });
      });
      p2pService.broadcast({ type: 'location', payload: { ...location, device: deviceType } });
    }, (error) => {
      console.warn('[App] Geolocation initial query notice:', error.message);
    }, {
      enableHighAccuracy: false,
      timeout: 5000,
      maximumAge: 60000
    });
  }

  // Ao conectar com novo peer, trocar localização automaticamente
  p2pService.onConnect = (peerId) => {
    console.log('[App] ✅ New peer connected:', peerId);
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(pos => {
        const location = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        p2pService.sendTo(peerId, { 
          type: 'location', 
          payload: { ...location, device: deviceType } 
        });
      }, (error) => {
        console.warn('[App] Geolocation on connect notice:', error.message);
      }, {
        enableHighAccuracy: false,
        timeout: 5000,
        maximumAge: 60000
      });
    }
  };

  // Handler mestre de dados
  p2pService.addDataHandler(async (peerId: string, data: any) => {
    console.log('[App] 📨 Received message:', data.type, 'from:', peerId);

    // 1. Delegar mensagens de transferência para o TransferService
    const handledByTransfer = await transferService.handleMessage(peerId, data);
    if (handledByTransfer) {
      return;
    }

    // 2. Outras requisições P2P (localização, metadados de playlists)
    if (data.type === 'request-location') {
      if ('geolocation' in navigator) {
        navigator.geolocation.getCurrentPosition(pos => {
          const location = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          p2pService.sendTo(peerId, { 
            type: 'location', 
            payload: { ...location, device: deviceType } 
          });
        }, (error) => {
          console.warn('[App] Geolocation request error:', error.message);
        }, {
          enableHighAccuracy: false,
          timeout: 5000,
          maximumAge: 60000
        });
      }
    } else if (data.type === 'request-playlists') {
      try {
        const playlists = await playlistService.loadPlaylists();
        const playlistsBasic = [] as Array<{ id?: number; name: string; songCount: number }>;
        for (const p of playlists) {
          const count = p.id ? await playlistService.getPlaylistSongCount(p.id) : 0;
          playlistsBasic.push({ id: p.id, name: p.name, songCount: count });
        }
        p2pService.sendTo(peerId, { type: 'playlists-response', payload: { playlists: playlistsBasic } });
      } catch (error) {
        console.error('[App] Error loading playlists for peer:', error);
      }
    } else if (data.type === 'request-playlist-songs-meta') {
      try {
        const playlistId = data.payload.playlistId;
        const page = data.payload.page ?? 1;
        const pageSize = data.payload.pageSize ?? 10;
        const offset = Math.max(0, (page - 1) * pageSize);
        const songs = await playlistService.getSongsForPlaylist(playlistId, pageSize, offset);
        const songsBasic = songs.map((s, idx) => ({
          index: offset + idx,
          title: s.title,
          artist: s.artist,
          album: s.album,
          duration: s.duration
        }));
        const total = await playlistService.getPlaylistSongCount(playlistId);
        p2pService.sendTo(peerId, { type: 'playlist-songs-meta', payload: { playlistId, page, pageSize, total, songs: songsBasic } });
      } catch (error) {
        console.error('[App] Error sending songs meta to peer:', error);
      }
    }
  });
});

onUnmounted(() => {
  console.log('[App] App unmounted');
});
</script>

<style>
/* Resetting default margin and box-sizing */
html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

#app {
  width: 100%;
  height: 100%;
}

/* Global Toast */
.global-toast {
  position: fixed;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  padding: 10px 20px;
  border-radius: 30px;
  font-size: 14px;
  font-weight: 500;
  color: white;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(10px);
  animation: toast-in 0.3s ease-out;
  pointer-events: none;
  max-width: 90vw;
  text-align: center;
}

.toast-info {
  background: rgba(30, 58, 138, 0.9);
  border: 1px solid rgba(96, 165, 250, 0.5);
}

.toast-success {
  background: rgba(22, 101, 52, 0.9);
  border: 1px solid rgba(74, 222, 128, 0.5);
}

.toast-error {
  background: rgba(153, 27, 27, 0.9);
  border: 1px solid rgba(248, 113, 113, 0.5);
}

@keyframes toast-in {
  from { opacity: 0; transform: translate(-50%, -20px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}

/* Floating Transfer Status Pill */
.floating-transfer-pill {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 8000;
  background: rgba(15, 23, 42, 0.92);
  border: 1px solid rgba(59, 130, 246, 0.4);
  backdrop-filter: blur(12px);
  color: white;
  border-radius: 14px;
  padding: 12px 16px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 260px;
  max-width: 380px;
  animation: slide-up 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.floating-transfer-pill.outgoing {
  border-color: rgba(168, 85, 247, 0.5);
}

.pill-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pill-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
}

.pill-title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
}

.pill-percent {
  font-weight: 700;
  color: #60a5fa;
}

.floating-transfer-pill.outgoing .pill-percent {
  color: #c084fc;
}

.pill-progress-bg {
  width: 100%;
  height: 6px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  overflow: hidden;
}

.pill-progress-bar {
  height: 100%;
  background: linear-gradient(90deg, #3b82f6, #60a5fa);
  transition: width 0.2s ease;
}

.pill-progress-bar.outgoing-bar {
  background: linear-gradient(90deg, #9333ea, #c084fc);
}

.pill-details {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: #94a3b8;
}

.pill-song {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 160px;
}

.pill-cancel-btn {
  background: rgba(255, 255, 255, 0.1);
  border: none;
  color: #94a3b8;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  transition: all 0.2s;
  flex-shrink: 0;
}

.pill-cancel-btn:hover {
  background: rgba(239, 68, 68, 0.3);
  color: #f87171;
}

@keyframes slide-up {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (max-width: 600px) {
  .floating-transfer-pill {
    left: 15px;
    right: 15px;
    bottom: 15px;
    max-width: none;
  }
}
</style>