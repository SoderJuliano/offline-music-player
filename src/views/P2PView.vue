<template>
  <div class="p2p-view-container">
    <router-link to="/" class="back-to-player-btn">← Voltar ao Player</router-link>
    <div id="map"></div>
    <div class="status-overlay">
      <p :class="{ 'connected': connectedPeersCount > 0 }">
        Status: {{ connectedPeersCount > 0 ? `${connectedPeersCount} usuário(s) conectado(s)` : 'Buscando...' }}
      </p>
    </div>
    
    <!-- Lista de dispositivos -->
    <div class="devices-list" v-if="connectedPeersCount > 0">
      <h4>🌐 Dispositivos</h4>
      <div class="device-item" 
           v-for="device in connectedDevices" 
           :key="device.id"
           @click="focusOnDevice(device.id)"
           :title="`Clique para focar em ${device.name}`">
        <span class="device-icon-small">{{ device.icon }}</span>
        <span class="device-name">{{ device.name }}</span>
      </div>
      <div class="device-item my-device">
        <span class="device-icon-small">{{ localDeviceType === 'phone' ? '📱' : '💻' }}</span>
        <span class="device-name">Você</span>
      </div>
    </div>
    
    <!-- Clone Progress Overlay -->
    <div v-if="transferService.incoming.active" class="clone-overlay">
      <div class="clone-progress-card">
        <h3>🎵 Baixando Playlist</h3>
        <p class="playlist-title"><strong>{{ transferService.incoming.playlistName }}</strong></p>
        
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: transferService.incoming.overallPercent + '%' }"></div>
        </div>
        
        <p class="progress-stats">
          <strong>Música {{ transferService.incoming.currentSongIndex }} de {{ transferService.incoming.totalSongs }}</strong>
          ({{ transferService.incoming.overallPercent }}%)
        </p>
        
        <p v-if="transferService.incoming.currentSongTitle" class="current-song">
          🎶 {{ transferService.incoming.currentSongTitle }}
        </p>
        
        <div class="transfer-footer">
          <p class="time-estimate" v-if="transferService.incoming.timeRemaining">
            ⏱️ {{ transferService.incoming.timeRemaining }}
          </p>
          <button class="cancel-transfer-btn" @click="transferService.cancelIncomingTransfer">
            Cancelar Transferência
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, onMounted, onUnmounted, ref } from 'vue';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { p2pService } from '../services/p2p';
import { transferService } from '../services/transfer';

// Basic device detection
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const localDeviceType = isMobile ? 'phone' : 'desktop';

// Icon definitions
const phoneIcon = L.divIcon({ className: 'device-icon', html: '📱' });
const desktopIcon = L.divIcon({ className: 'device-icon', html: '💻' });

export default defineComponent({
  name: 'P2PView',
  setup() {
    let map: L.Map | null = null;
    const connectedPeersCount = ref(0);
    const localUserId = ref('');
    const userLocation = ref<{ lat: number, lng: number } | null>(null);
    const peerMarkers = new Map<string, L.Marker>();
    let locationInterval: any = null;
    let syncInterval: any = null;
    
    // Lista de dispositivos conectados
    const connectedDevices = ref<Array<{ id: string, name: string, icon: string }>>([]);
    
    const updateDevicesList = () => {
      const devices: Array<{ id: string, name: string, icon: string }> = [];
      const allPeerIds = p2pService.getAllPeerIds();
      allPeerIds.forEach(peerId => {
        const marker = peerMarkers.get(peerId);
        let icon = '❔';
        if (marker) {
          const iconHtml = (marker.options.icon as any)?.options?.html;
          icon = iconHtml === '📱' ? '📱' : '💻';
        }
        devices.push({
          id: peerId,
          name: peerId.substring(0, 8) + '...',
          icon
        });
      });
      connectedDevices.value = devices;
    };
    
    const focusOnDevice = (peerId: string) => {
      const marker = peerMarkers.get(peerId);
      if (marker && map) {
        const latLng = marker.getLatLng();
        map.setView(latLng, 16);
        marker.openPopup();
      }
    };

    const addMyMarkerToMap = (location: { lat: number, lng: number }) => {
      if (!map) return;
      const myIcon = localDeviceType === 'phone' ? phoneIcon : desktopIcon;
      const myMarker = L.marker(location, { 
        icon: myIcon,
        zIndexOffset: 1000
      }).addTo(map);
      myMarker.bindPopup('👉 Você está aqui!').openPopup();
      return myMarker;
    };

    const checkGeolocationPermission = async (): Promise<string> => {
      if (!('permissions' in navigator)) {
        return 'prompt';
      }
      try {
        const result = await navigator.permissions.query({ name: 'geolocation' });
        return result.state;
      } catch (e) {
        return 'prompt';
      }
    };

    const requestGeolocation = async (retryCount = 0): Promise<void> => {
      if (!('geolocation' in navigator)) {
        const defaultLocation = { lat: -27.59, lng: -48.54 };
        userLocation.value = defaultLocation;
        addMyMarkerToMap(defaultLocation);
        return;
      }

      const permissionState = await checkGeolocationPermission();

      if (permissionState === 'denied') {
        const defaultLocation = { lat: -27.59, lng: -48.54 };
        userLocation.value = defaultLocation;
        if (map) {
          map.setView(defaultLocation, 13);
          addMyMarkerToMap(defaultLocation);
        }
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          userLocation.value = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          if (map) {
            map.setView(userLocation.value, 15);
            addMyMarkerToMap(userLocation.value);
          }
        }, 
        (error) => {
          console.warn("[P2PView] Geolocation notice:", error.message);
          const defaultLocation = { lat: -27.59, lng: -48.54 };
          userLocation.value = defaultLocation;
          if (map) {
            map.setView(defaultLocation, 13);
            addMyMarkerToMap(defaultLocation);
          }
          if (retryCount < 1 && error.code !== 1) {
            setTimeout(() => requestGeolocation(retryCount + 1), 3000);
          }
        }, 
        {
          enableHighAccuracy: false,
          timeout: 10000,
          maximumAge: 60000
        }
      );
    };
    
    let dataHandler: ((peerId: string, data: any) => Promise<void>) | null = null;

    onMounted(async () => {
      map = L.map('map').setView([-27.59, -48.54], 13);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      }).addTo(map);

      await requestGeolocation();

      localUserId.value = p2pService.getLocalId();
      connectedPeersCount.value = p2pService.getAllPeerIds().length;

      // Data handler para atualizar o mapa e popups
      dataHandler = async (peerId: string, data: any) => {
        switch (data.type) {
          case 'location':
            updateMarker(peerId, data.payload);
            break;
          case 'playlists-response':
            showPlaylistsInPopup(peerId, data.payload.playlists);
            break;
          case 'playlist-songs-meta':
            showSongsInPopup(peerId, data.payload.playlistId, data.payload.songs || [], data.payload.page || 1, data.payload.pageSize || 10, data.payload.total || (data.payload.songs || []).length);
            break;
        }
      };
      
      p2pService.addDataHandler(dataHandler);

      const originalOnConnect = p2pService.onConnect;
      const originalOnDisconnect = p2pService.onDisconnect;

      p2pService.onConnect = (peerId) => {
        connectedPeersCount.value++;
        updateDevicesList();
        p2pService.sendTo(peerId, { type: 'request-location' });
        if (originalOnConnect) originalOnConnect(peerId);
      };

      p2pService.onDisconnect = (peerId) => {
        connectedPeersCount.value = Math.max(0, connectedPeersCount.value - 1);
        const marker = peerMarkers.get(peerId);
        if (marker) {
          marker.remove();
          peerMarkers.delete(peerId);
          updateDevicesList();
        }
        if (originalOnDisconnect) originalOnDisconnect(peerId);
      };

      if (!p2pService.isInitialized()) {
        await p2pService.init();
      }
      
      connectedPeersCount.value = p2pService.getAllPeerIds().length;
      
      // Solicitar localização de todos os peers conectados
      setTimeout(() => {
        const connectedPeers = p2pService.getAllPeerIds();
        connectedPeers.forEach(peerId => {
          p2pService.sendTo(peerId, { type: 'request-location' });
        });
      }, 1500);
      
      // Sync periódico
      syncInterval = setInterval(() => {
        const peers = p2pService.getAllPeerIds();
        connectedPeersCount.value = peers.length;
        updateDevicesList();
      }, 3000);

      // Funções expostas para os botões dentro dos popups HTML do Leaflet
      (window as any).requestPlaylists = (peerId: string) => {
        p2pService.sendTo(peerId, { type: 'request-playlists' });
      };
      
      (window as any).clonePlaylistAction = async (peerId: string, playlistId: number) => {
        await transferService.requestPlaylistClone(peerId, playlistId);
      };

      (window as any).viewPlaylistSongs = (peerId: string, playlistId: number) => {
        p2pService.sendTo(peerId, { type: 'request-playlist-songs-meta', payload: { playlistId, page: 1, pageSize: 10 } });
      };

      (window as any).viewPlaylistSongsPage = (peerId: string, playlistId: number, page: number) => {
        const safePage = Math.max(1, page);
        p2pService.sendTo(peerId, { type: 'request-playlist-songs-meta', payload: { playlistId, page: safePage, pageSize: 10 } });
      };

      (window as any).cloneSingleSongAction = async (peerId: string, playlistId: number, songIndex: number) => {
        await transferService.requestSingleSong(peerId, playlistId, songIndex);
      };
    });

    onUnmounted(() => {
      if (dataHandler) {
        p2pService.removeDataHandler(dataHandler);
      }
      if (locationInterval) clearInterval(locationInterval);
      if (syncInterval) clearInterval(syncInterval);
      
      map?.remove();
      delete (window as any).requestPlaylists;
      delete (window as any).clonePlaylistAction;
      delete (window as any).viewPlaylistSongs;
      delete (window as any).viewPlaylistSongsPage;
      delete (window as any).cloneSingleSongAction;
    });

    const updateMarker = (peerId: string, payload: any) => {
      if (!map) return;
      const { lat, lng, device } = payload;
      const icon = device === 'phone' ? phoneIcon : desktopIcon;
      
      let finalLatLng = new L.LatLng(lat, lng);
      peerMarkers.forEach((marker, id) => {
        if (marker.getLatLng().equals(finalLatLng) && id !== peerId) {
          finalLatLng.lat += 0.0001;
        }
      });

      if (peerMarkers.has(peerId)) {
        peerMarkers.get(peerId)!.setLatLng(finalLatLng).setIcon(icon);
      } else {
        const marker = L.marker(finalLatLng, { icon })
          .addTo(map)
          .bindPopup(`<b>Dispositivo:</b> ${peerId.substring(0, 8)}...<br/><button onclick="requestPlaylists('${peerId}')">Ver Playlists</button>`);
        peerMarkers.set(peerId, marker);
        
        marker.on('popupopen', () => {
          try {
            p2pService.sendTo(peerId, { type: 'request-playlists' });
          } catch (e) {
            console.warn('[P2PView] Error requesting playlists on popupopen:', e);
          }
        });
      }
      
      updateDevicesList();
    };

    const showPlaylistsInPopup = (peerId: string, playlists: any[]) => {
      const marker = peerMarkers.get(peerId);
      if (!marker) return;

      let content = `<b>Playlists de ${peerId.substring(0, 8)}:</b><ul>`;
      if (!playlists || playlists.length === 0) {
        content += '<li>Nenhuma playlist encontrada.</li>';
      } else {
        playlists.forEach(p => {
          const countLabel = `${p.songCount} música${p.songCount !== 1 ? 's' : ''}`;
          if (p.songCount > 5) {
            content += `<li>${p.name} (${countLabel}) <button onclick="clonePlaylistAction('${peerId}', ${p.id})" style="font-size:11px; margin-right:4px;">Baixar todas</button><button onclick="viewPlaylistSongs('${peerId}', ${p.id})" style="font-size:11px;">Ver músicas</button></li>`;
          } else {
            content += `<li>${p.name} (${countLabel}) <button onclick="clonePlaylistAction('${peerId}', ${p.id})" style="font-size:11px; margin-right:4px;">Baixar playlist</button> <button onclick="viewPlaylistSongs('${peerId}', ${p.id})" style="font-size:11px;">Ver músicas</button></li>`;
          }
        });
      }
      content += '</ul>';
      marker.setPopupContent(content).openPopup();
    };

    const showSongsInPopup = (peerId: string, playlistId: number, songs: any[], page: number = 1, pageSize: number = 10, total: number = songs.length) => {
      const marker = peerMarkers.get(peerId);
      if (!marker) return;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      let content = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
        <button onclick="requestPlaylists('${peerId}')" style="font-size:11px;">← Voltar</button>
        <span style="font-size:12px;"><b>Músicas</b> (página ${page}/${totalPages})</span>
      </div><ul>`;
      if (songs.length === 0) {
        content += '<li>Nenhuma música encontrada.</li>';
      } else {
        songs.forEach((s: any, idx: number) => {
          const title = s.title || `Música ${s.index+1}`;
          const artist = s.artist || '';
          const label = artist ? `${title} — ${artist}` : title;
          const absoluteIndex = s.index ?? ((page-1) * pageSize + idx);
          content += `<li>${label} <button onclick="cloneSingleSongAction('${peerId}', ${playlistId}, ${absoluteIndex})" style="font-size:11px;">Baixar</button></li>`;
        });
      }
      content += '</ul>';
      if (totalPages > 1) {
        const prevDisabled = page <= 1 ? 'disabled' : '';
        const nextDisabled = page >= totalPages ? 'disabled' : '';
        content += `<div style="margin-top:8px; display:flex; justify-content:space-between;">
          <button ${prevDisabled} onclick="viewPlaylistSongsPage('${peerId}', ${playlistId}, ${page - 1})" style="font-size:11px;">◀️ Anterior</button>
          <button ${nextDisabled} onclick="viewPlaylistSongsPage('${peerId}', ${playlistId}, ${page + 1})" style="font-size:11px;">Próxima ▶️</button>
        </div>`;
      }
      marker.setPopupContent(content).openPopup();
    };

    return { 
      connectedPeersCount, 
      connectedDevices, 
      focusOnDevice, 
      localDeviceType,
      transferService 
    };
  }
});
</script>

<style>
.device-icon {
  font-size: 24px;
  text-align: center;
  line-height: 1;
}

.p2p-view-container {
  width: 100vw;
  height: 100vh;
  position: relative;
}

#map {
  width: 100%;
  height: 100%;
}

.back-to-player-btn {
  position: absolute;
  top: 15px;
  left: 15px;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.75);
  color: white;
  border: 1px solid rgba(255, 255, 255, 0.2);
  backdrop-filter: blur(10px);
  border-radius: 8px;
  padding: 10px 16px;
  font-size: 0.95em;
  font-weight: 500;
  cursor: pointer;
  text-decoration: none;
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  transition: all 0.2s;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.back-to-player-btn:hover {
  background: rgba(0, 0, 0, 0.9);
  transform: translateY(-1px);
}

.status-overlay {
  position: absolute;
  top: 15px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
  background: rgba(0, 0, 0, 0.75);
  border: 1px solid rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(10px);
  color: #fca5a5;
  padding: 8px 16px;
  border-radius: 20px;
  font-size: 0.9em;
  pointer-events: none;
  transition: color 0.3s;
}

.status-overlay .connected {
  color: #86efac;
}

/* Lista de dispositivos */
.devices-list {
  position: fixed;
  background: rgba(15, 23, 42, 0.88);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: white;
  padding: 15px;
  border-radius: 12px;
  z-index: 1000;
  max-height: 50vh;
  overflow-y: auto;
  box-shadow: 0 8px 25px rgba(0, 0, 0, 0.4);
}

.devices-list h4 {
  margin: 0 0 10px 0;
  font-size: 13px;
  font-weight: 600;
  color: #86efac;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.device-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  margin: 5px 0;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
}

.device-item:hover {
  background: rgba(255, 255, 255, 0.18);
  transform: translateX(3px);
}

.device-item.my-device {
  background: rgba(76, 175, 80, 0.2);
  border: 1px solid rgba(76, 175, 80, 0.5);
  cursor: default;
}

.device-item.my-device:hover {
  transform: none;
}

.device-icon-small {
  font-size: 18px;
  line-height: 1;
}

.device-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (min-width: 768px) {
  .devices-list {
    top: 80px;
    right: 15px;
    min-width: 200px;
    max-width: 260px;
  }
}

@media (max-width: 767px) {
  .devices-list {
    bottom: 80px;
    left: 15px;
    right: 15px;
    max-height: 30vh;
    padding: 10px;
    -webkit-overflow-scrolling: touch;
  }
}

/* Modal Overlay */
.clone-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.8);
  backdrop-filter: blur(8px);
  z-index: 9000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  box-sizing: border-box;
}

.clone-progress-card {
  background: #1e293b;
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: white;
  padding: 26px 24px;
  border-radius: 18px;
  width: 100%;
  max-width: 380px;
  text-align: center;
  box-shadow: 0 15px 45px rgba(0, 0, 0, 0.6);
  animation: card-appear 0.25s ease-out;
}

@keyframes card-appear {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

.clone-progress-card h3 {
  margin: 0 0 8px 0;
  font-size: 1.3em;
  color: #60a5fa;
}

.playlist-title {
  font-size: 1.1em;
  margin: 4px 0 16px 0;
  color: #f1f5f9;
  word-break: break-word;
}

.progress-bar {
  width: 100%;
  height: 14px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  overflow: hidden;
  margin: 14px 0;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #3b82f6, #60a5fa);
  transition: width 0.3s ease;
}

.progress-stats {
  font-size: 13px;
  color: #cbd5e1;
  margin: 8px 0;
}

.current-song {
  font-weight: 600;
  color: #38bdf8;
  font-size: 13px;
  margin: 12px 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.transfer-footer {
  margin-top: 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
}

.time-estimate {
  font-size: 12px;
  color: #94a3b8;
  margin: 0;
}

.cancel-transfer-btn {
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.4);
  color: #fca5a5;
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.cancel-transfer-btn:hover {
  background: rgba(239, 68, 68, 0.3);
  color: #f87171;
}

.leaflet-popup-content {
  max-height: 55vh;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
</style>