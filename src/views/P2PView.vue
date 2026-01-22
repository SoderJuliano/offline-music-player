<template>
  <div class="p2p-view-container">
    <router-link to="/" class="back-to-player-btn">← Voltar ao Player</router-link>
    <div id="map"></div>
    <div class="status-overlay">
      <p :class="{ 'connected': connectedPeersCount > 0 }">
        Status: {{ connectedPeersCount > 0 ? `${connectedPeersCount} usuário(s) conectado(s)` : 'Buscando...' }}
      </p>
    </div>
    <!-- Debug overlay desabilitado para evitar travamentos -->
    <div v-if="cloneProgress.active" class="clone-overlay">
      <div class="clone-progress-card">
        <h3>🎵 Clonando Playlist</h3>
        <p><strong>{{ cloneProgress.playlistName }}</strong></p>
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: cloneProgress.percent + '%' }"></div>
        </div>
        <p><strong>Música {{ cloneProgress.current }} de {{ cloneProgress.total }}</strong> ({{ cloneProgress.percent }}%)</p>
        <p v-if="cloneProgress.currentSong" class="current-song">{{ cloneProgress.currentSong }}</p>
        <p class="time-estimate" v-if="cloneProgress.timeRemaining">⏱️ {{ cloneProgress.timeRemaining }}</p>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, onMounted, onUnmounted, ref, watch } from 'vue';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { p2pService } from '../services/p2p';
import { PlaylistService } from '../services/playlist';

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
    const playlistService = new PlaylistService();
    let locationInterval: any = null;
    
    // Debug logs visiveis na tela (DESABILITADO)
    const debugLogs = ref<string[]>([]);
    const addDebugLog = (msg: string) => {
      // Desabilitado para evitar travamentos
      // const timestamp = new Date().toLocaleTimeString();
      // debugLogs.value.push(`[${timestamp}] ${msg}`);
      // if (debugLogs.value.length > 10) debugLogs.value.shift();
      console.log('[DEBUG]', msg);
    };
    
    // Clone progress state
    const cloneProgress = ref({
      active: false,
      playlistName: '',
      current: 0,
      total: 0,
      percent: 0,
      currentSong: '',
      timeRemaining: '',
      startTime: 0,
      newPlaylistId: 0,
      sourcePeerId: ''
    });
    
    // Buffer for receiving chunked songs
    const songChunksBuffer = new Map<string, { chunks: string[], totalChunks: number, metadata: any, processed?: boolean }>();

    onMounted(async () => {
      addDebugLog('🗺️ Mapa montado');
      map = L.map('map').setView([-27.59, -48.54], 13);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      }).addTo(map);

      if ('geolocation' in navigator) {
        addDebugLog('📍 Pedindo localização...');
        console.log('[P2PView] Requesting geolocation...');
        navigator.geolocation.getCurrentPosition(pos => {
          userLocation.value = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          addDebugLog(`✅ Localização obtida: ${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`);
          console.log('[P2PView] Geolocation obtained:', userLocation.value);
          map!.setView(userLocation.value, 15);
          const myIcon = localDeviceType === 'phone' ? phoneIcon : desktopIcon;
          const myMarker = L.marker(userLocation.value, { 
            icon: myIcon,
            zIndexOffset: 1000 // Garantir que fique acima dos outros
          }).addTo(map!);
          myMarker.bindPopup('👉 Você está aqui!').openPopup();
          console.log('[P2PView] ✅ My marker added to map at', userLocation.value);
        }, (error) => {
            console.error("[P2PView] Geolocation error:", error.message);
        }, {
          enableHighAccuracy: false,
          timeout: 5000,
          maximumAge: 60000
        });
      }

      localUserId.value = p2pService.getLocalId();
      addDebugLog(`🆔 Meu ID: ${localUserId.value.substring(0, 8)}`);
      
      // Atualizar contador de peers conectados
      connectedPeersCount.value = p2pService.getAllPeerIds().length;
      addDebugLog(`👥 Peers já conectados: ${connectedPeersCount.value}`);

      // Configurar callbacks apenas para esta view (não reinicializar o serviço)
      const originalOnConnect = p2pService.onConnect;
      const originalOnDisconnect = p2pService.onDisconnect;
      const originalOnData = p2pService.onData;

      p2pService.onConnect = (peerId) => {
        console.log('[P2PView] ✅ Peer connected:', peerId);
        addDebugLog(`✅ Peer conectou: ${peerId.substring(0, 8)}`);
        connectedPeersCount.value++;
        
        // Pedir localização do peer que acabou de conectar
        addDebugLog(`📤 → ${peerId.substring(0, 8)}: request-location`);
        p2pService.sendTo(peerId, { type: 'request-location' });
        
        // Chamar callback original do App.vue também
        if (originalOnConnect) originalOnConnect(peerId);
      };

      p2pService.onDisconnect = (peerId) => {
        connectedPeersCount.value = Math.max(0, connectedPeersCount.value - 1);
        const marker = peerMarkers.get(peerId);
        if (marker) {
          marker.remove();
          peerMarkers.delete(peerId);
        }
        // Chamar callback original do App.vue também
        if (originalOnDisconnect) originalOnDisconnect(peerId);
      };

      p2pService.onData = async (peerId, data) => {
        console.log('[P2PView] Received data from', peerId, ':', data.type);
        addDebugLog(`📨 ← ${peerId.substring(0, 8)}: ${data.type}`);
        
        // Chamar callback original do App.vue PRIMEIRO
        if (originalOnData) {
          await originalOnData(peerId, data);
        }
        
        // Depois processar no P2PView
        switch (data.type) {
          case 'location':
            addDebugLog(`📍 ← ${peerId.substring(0, 8)}: location`);
            console.log('[P2PView] 📍 Received location from', peerId, data.payload);
            updateMarker(peerId, data.payload);
            console.log('[P2PView] ✅ Marker updated for', peerId, '- Total markers:', peerMarkers.size);
            break;
          case 'request-playlists':
            try {
              const playlists = await playlistService.loadAllPlaylistsWithSongs();
              // Send only basic info without songs to avoid overflow
              const playlistsBasic = playlists.map(p => ({
                id: p.id,
                name: p.name,
                songCount: p.songs.length
              }));
              p2pService.sendTo(peerId, { type: 'playlists-response', payload: { playlists: playlistsBasic } });
            } catch (error) {
              console.error('[P2PView] Error loading playlists:', error);
            }
            break;
          case 'playlists-response':
            showPlaylistsInPopup(peerId, data.payload.playlists);
            break;
          case 'request-clone':
            await handleCloneRequest(peerId, data.payload.playlistId);
            break;
          case 'clone-start':
            // Criar nova playlist com nome formatado
            const newPlaylistName = `[${peerId.substring(0, 8)}] ${data.payload.playlistName}`;
            const newPlaylistId = await playlistService.addPlaylist(newPlaylistName);
            
            console.log('[P2PView] 🆕 Clone started:', newPlaylistName, 'ID:', newPlaylistId, 'Songs:', data.payload.totalSongs);
            
            cloneProgress.value = {
              active: true,
              playlistName: newPlaylistName,
              current: 0,
              total: data.payload.totalSongs,
              percent: 0,
              currentSong: 'Aguardando primeira música...',
              timeRemaining: 'Calculando...',
              startTime: Date.now(),
              newPlaylistId: newPlaylistId,
              sourcePeerId: peerId
            };
            
            console.log('[P2PView] Progress initialized:', cloneProgress.value);
            break;
          case 'clone-song-meta':
            const key = `${peerId}-${data.payload.songIndex}`;
            if (!songChunksBuffer.has(key)) {
              songChunksBuffer.set(key, { 
                chunks: new Array(data.payload.totalChunks), 
                totalChunks: data.payload.totalChunks, 
                metadata: data.payload 
              });
            } else {
              songChunksBuffer.get(key)!.metadata = data.payload;
            }
            break;
          case 'clone-song-chunk':
            await handleSongChunk(peerId, data.payload);
            break;
          case 'clone-complete':
            await finalizeClone(peerId, data.payload);
            break;
          case 'clone-error':
            cloneProgress.value.active = false;
            alert('Erro ao clonar playlist: ' + data.payload.message);
            songChunksBuffer.clear();
            break;
        }
      };

      // P2P já foi inicializado no App.vue, não precisa reinicializar
      // Apenas garantir que está inicializado
      if (!p2pService.getLocalId()) {
        console.log('[P2PView] P2P not initialized yet, initializing...');
        await p2pService.init();
      }
      
      // Aguardar 3 segundos para garantir que conexões WebRTC completem
      addDebugLog('⏳ Aguardando conexões...');
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Pedir localização de todos os peers já conectados
      const connectedPeers = p2pService.getAllPeerIds();
      addDebugLog(`📤 Pedindo localização de ${connectedPeers.length} peer(s)`);
      console.log('[P2PView] Connected peers:', connectedPeers);
      console.log('[P2PView] Requesting location from', connectedPeers.length, 'peer(s)...');
      
      connectedPeers.forEach(peerId => {
        addDebugLog(`📤 → ${peerId.substring(0, 8)}: request-location`);
        console.log('[P2PView] 📤 Sending request-location to', peerId);
        p2pService.sendTo(peerId, { type: 'request-location' });
      });
      
      // Continuar pedindo a cada 5s caso ainda não tenha marcadores (máximo 3 tentativas)
      let attempts = 0;
      locationInterval = setInterval(() => {
        attempts++;
        if (attempts > 3) {
          clearInterval(locationInterval);
          addDebugLog('⚠️ Parou de tentar após 3 tentativas');
          return;
        }
        
        const peers = p2pService.getAllPeerIds();
        if (peerMarkers.size === 0 && peers.length > 0) {
          addDebugLog(`🔄 Tentativa ${attempts}/3: pedindo localização`);
          peers.forEach(peerId => {
            p2pService.sendTo(peerId, { type: 'request-location' });
          });
        } else if (peerMarkers.size > 0) {
          clearInterval(locationInterval);
          addDebugLog('✅ Marcadores carregados!');
        }
      }, 5000);

      (window as any).requestPlaylists = (peerId: string) => {
        p2pService.sendTo(peerId, { type: 'request-playlists' });
      };
      
      (window as any).clonePlaylistAction = async (peerId: string, playlistId: number) => {
        p2pService.sendTo(peerId, { type: 'request-clone', payload: { playlistId } });
      };
    });

    onUnmounted(() => {
      // Limpar intervalo de localização
      if (locationInterval) {
        clearInterval(locationInterval);
      }
      
      // NÃO destruir o serviço P2P, deixar rodando em background
      // Apenas limpar o mapa e funções globais desta view
      map?.remove();
      delete (window as any).requestPlaylists;
      delete (window as any).clonePlaylistAction;
    });

    const updateMarker = (peerId: string, payload: any) => {
      if (!map) {
        console.warn('[P2PView] ⚠️ Cannot update marker - map not initialized');
        return;
      }
      const { lat, lng, device } = payload;
      console.log('[P2PView] 🗺️ Updating marker:', peerId, 'at', lat, lng, 'device:', device);
      const icon = device === 'phone' ? phoneIcon : desktopIcon;
      
      let finalLatLng = new L.LatLng(lat, lng);
      
      peerMarkers.forEach((marker, id) => {
        if (marker.getLatLng().equals(finalLatLng) && id !== peerId) {
          finalLatLng.lat += 0.0001; // Apply offset
        }
      });

      if (peerMarkers.has(peerId)) {
        peerMarkers.get(peerId)!.setLatLng(finalLatLng).setIcon(icon);
      } else {
        const marker = L.marker(finalLatLng, { icon })
          .addTo(map)
          .bindPopup(`<b>Dispositivo:</b> ${peerId.substring(0, 8)}...<br/><button onclick="requestPlaylists('${peerId}')">Ver Playlists</button>`);
        peerMarkers.set(peerId, marker);
      }
    };

    const showPlaylistsInPopup = (peerId: string, playlists: any[]) => {
      const marker = peerMarkers.get(peerId);
      if (!marker) return;

      let content = `<b>Playlists de ${peerId.substring(0, 8)}:</b><ul>`;
      if (playlists.length === 0) {
        content += '<li>Nenhuma playlist encontrada.</li>';
      } else {
        playlists.forEach(p => {
          content += `<li>${p.name} (${p.songCount} música${p.songCount !== 1 ? 's' : ''}) <button onclick="clonePlaylistAction('${peerId}', ${p.id})" style="font-size:11px;">Clonar</button></li>`;
        });
      }
      content += '</ul>';
      marker.setPopupContent(content).openPopup();
    };
    
    const handleCloneRequest = async (peerId: string, playlistId: number) => {
      try {
        const playlist = await playlistService.getPlaylistWithSongs(playlistId);
        if (!playlist || !playlist.songs.length) {
          p2pService.sendTo(peerId, { type: 'clone-error', payload: { message: 'Playlist vazia ou não encontrada' } });
          return;
        }
        
        // Send metadata first
        p2pService.sendTo(peerId, { 
          type: 'clone-start', 
          payload: { 
            playlistName: playlist.name,
            totalSongs: playlist.songs.length
          } 
        });
        
        // Send each song in chunks (16KB per chunk to stay safe)
        const CHUNK_SIZE = 16 * 1024;
        for (let i = 0; i < playlist.songs.length; i++) {
          const song = playlist.songs[i];
          const dataStr = song.data; // base64 string
          const totalChunks = Math.ceil(dataStr.length / CHUNK_SIZE);
          
          // Send song metadata
          p2pService.sendTo(peerId, {
            type: 'clone-song-meta',
            payload: {
              songIndex: i,
              title: song.title,
              artist: song.artist,
              album: song.album,
              duration: song.duration,
              playlistId: song.playlistId,
              totalChunks
            }
          });
          
          // Send chunks
          for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
            const start = chunkIndex * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, dataStr.length);
            const chunk = dataStr.substring(start, end);
            
            p2pService.sendTo(peerId, {
              type: 'clone-song-chunk',
              payload: {
                songIndex: i,
                chunkIndex,
                totalChunks,
                data: chunk
              }
            });
            
            // Small delay between chunks to avoid overwhelming
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
        
        // Send completion
        p2pService.sendTo(peerId, { 
          type: 'clone-complete', 
          payload: { playlistName: playlist.name } 
        });
        
      } catch (error) {
        console.error('[P2PView] Error handling clone request:', error);
        p2pService.sendTo(peerId, { type: 'clone-error', payload: { message: 'Erro ao processar clonagem' } });
      }
    };
    
    const handleSongChunk = async (peerId: string, payload: any) => {
      const { songIndex, chunkIndex, totalChunks, data } = payload;
      const key = `${peerId}-${songIndex}`;
      
      if (!songChunksBuffer.has(key)) {
        songChunksBuffer.set(key, { chunks: new Array(totalChunks), totalChunks, metadata: null });
      }
      
      const buffer = songChunksBuffer.get(key)!;
      buffer.chunks[chunkIndex] = data;
      
      // Check if all chunks received
      const receivedChunks = buffer.chunks.filter(c => c !== undefined).length;
      if (receivedChunks === totalChunks && buffer.metadata) {
        // Verificar se já processamos esta música
        if (buffer.processed) {
          console.log('[P2PView] Song already processed, skipping...');
          return;
        }
        buffer.processed = true;
        
        // Reconstruct song
        const fullData = buffer.chunks.join('');
        const song = {
          title: buffer.metadata.title,
          artist: buffer.metadata.artist,
          album: buffer.metadata.album,
          duration: buffer.metadata.duration,
          playlistId: cloneProgress.value.newPlaylistId, // Use a nova playlist criada
          data: fullData
        };
        
        // Save song
        await playlistService.addSong(song);
        console.log('[P2PView] ✅ Song saved:', song.title);
        
        // Update progress
        cloneProgress.value.current++;
        const newPercent = Math.round((cloneProgress.value.current / cloneProgress.value.total) * 100);
        cloneProgress.value.percent = newPercent;
        cloneProgress.value.currentSong = song.title;
        
        console.log(`[P2PView] 📊 Progress: ${cloneProgress.value.current}/${cloneProgress.value.total} (${newPercent}%)`);
        
        // Calculate time remaining
        if (cloneProgress.value.current < cloneProgress.value.total) {
          const elapsed = Date.now() - cloneProgress.value.startTime;
          const avgTimePerSong = elapsed / cloneProgress.value.current;
          const remaining = avgTimePerSong * (cloneProgress.value.total - cloneProgress.value.current);
          cloneProgress.value.timeRemaining = formatTime(remaining);
          console.log('[P2PView] ⏱️ Time remaining:', cloneProgress.value.timeRemaining);
        } else {
          cloneProgress.value.timeRemaining = 'Finalizando...';
        }
        
        // Clean up
        songChunksBuffer.delete(key);
      }
    };
    
    const finalizeClone = async (peerId: string, payload: any) => {
      // Aguardar um pouco para garantir que todos os chunks foram processados
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Contar quantas músicas realmente foram salvas na playlist
      const songsInPlaylist = await playlistService.getSongsForPlaylist(cloneProgress.value.newPlaylistId);
      const songsCloned = songsInPlaylist.length;
      
      console.log('[P2PView] ✅ Clone finalized:', songsCloned, 'songs actually saved');
      cloneProgress.value.active = false;
      
      alert(`Playlist "${payload.playlistName}" clonada com sucesso! ${songsCloned} música${songsCloned !== 1 ? 's' : ''} adicionada${songsCloned !== 1 ? 's' : ''}.`);
      songChunksBuffer.clear();
    };
    
    const formatTime = (ms: number): string => {
      const seconds = Math.floor(ms / 1000);
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${minutes}m ${secs}s`;
    };

    const clonePlaylist = async (playlistData: any, fromPeerId: string) => {
        const newName = `[clonado de: ${fromPeerId.substring(0, 8)}] ${playlistData.name}`;
        // Ensure songs are present and correctly structured for creation
        await playlistService.createPlaylistWithSongs(newName, playlistData.songs || []);
        console.log(`Playlist "${newName}" clonada com sucesso!`);
        alert(`Playlist "${newName}" clonada com sucesso! Volte para a tela do player para vê-la.`);
    };

    return { connectedPeersCount, cloneProgress, debugLogs };
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
  background: rgba(0, 0, 0, 0.7);
  color: white;
  border: none;
  border-radius: 5px;
  padding: 10px 15px;
  font-size: 1em;
  cursor: pointer;
  text-decoration: none;
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
}

.status-overlay {
  position: absolute;
  top: 15px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
  background: rgba(0, 0, 0, 0.7);
  color: #fca5a5;
  padding: 8px 15px;
  border-radius: 20px;
  font-size: 0.9em;
  pointer-events: none;
  transition: color 0.3s;
}

.status-overlay .connected {
  color: #86efac;
}

.clone-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.85);
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.clone-progress-card {
  background: white;
  padding: 30px;
  border-radius: 15px;
  min-width: 300px;
  max-width: 400px;
  text-align: center;
  box-shadow: 0 10px 40px rgba(0,0,0,0.3);
}

.clone-progress-card h3 {
  margin: 0 0 15px 0;
  color: #333;
}

.clone-progress-card p {
  margin: 10px 0;
  color: #666;
}

.progress-bar {
  width: 100%;
  height: 20px;
  background: #e0e0e0;
  border-radius: 10px;
  overflow: hidden;
  margin: 15px 0;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #4CAF50, #45a049);
  transition: width 0.3s ease;
}

.current-song {
  font-weight: bold;
  color: #333 !important;
  font-size: 14px;
  margin: 15px 0 !important;
}

.time-estimate {
  font-size: 12px;
  color: #999 !important;
}

.debug-overlay {
  position: fixed;
  bottom: 60px;
  left: 10px;
  right: 10px;
  background: rgba(0, 0, 0, 0.85);
  color: #0f0;
  padding: 10px;
  border-radius: 8px;
  font-family: monospace;
  font-size: 11px;
  max-height: 200px;
  overflow-y: auto;
  z-index: 1500;
  pointer-events: none;
}

.debug-log {
  margin: 2px 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>