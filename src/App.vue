<template>
  <router-view />
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { p2pService } from './services/p2p';

// Detectar tipo de dispositivo
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const deviceType = isMobile ? 'phone' : 'desktop';

// Inicializar P2P em background quando app carrega
onMounted(async () => {
  console.log('[App] Initializing P2P service in background...');
  
  // Inicializar serviço P2P
  await p2pService.init();
  
  // Enviar localização se disponível
  if ('geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition(pos => {
      const location = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      console.log('[App] Geolocation obtained, broadcasting to all peers');
      
      // Enviar para todos os peers conectados
      p2pService.getAllPeerIds().forEach(peerId => {
        p2pService.sendTo(peerId, { 
          type: 'location', 
          payload: { ...location, device: deviceType } 
        });
      });

      // Também publicar via Ably broadcast para alcançar todos imediatamente
      p2pService.broadcast({ type: 'location', payload: { ...location, device: deviceType } });
    }, (error) => {
      console.warn('[App] Geolocation error:', error.message);
    }, {
      enableHighAccuracy: false, // Menos preciso mas mais rápido
      timeout: 5000, // 5 segundos de timeout
      maximumAge: 60000 // Aceitar cache de até 1 minuto
    });
  }
  
  // Quando conectar com novo peer, enviar localização
  p2pService.onConnect = (peerId) => {
    console.log('[App] ✅ New peer connected:', peerId, '- sending location automatically');
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(pos => {
        const location = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        console.log('[App] 📤 Auto-sending location to new peer:', peerId, location);
        p2pService.sendTo(peerId, { 
          type: 'location', 
          payload: { ...location, device: deviceType } 
        });
        console.log('[App] ✅ Auto-location sent to:', peerId);
      }, (error) => {
        console.error('[App] ❌ Geolocation error on connect:', error.message);
      }, {
        enableHighAccuracy: false,
        timeout: 5000,
        maximumAge: 60000
      });
    }
  };
  
  // Sistema de broadcast de eventos para views
  const dataHandlers: Array<(peerId: string, data: any) => Promise<void> | void> = [];
  
  (p2pService as any).addDataHandler = (handler: (peerId: string, data: any) => Promise<void> | void) => {
    dataHandlers.push(handler);
    console.log('[App] ✅ Data handler added, total handlers:', dataHandlers.length);
  };
  
  (p2pService as any).removeDataHandler = (handler: (peerId: string, data: any) => Promise<void> | void) => {
    const index = dataHandlers.indexOf(handler);
    if (index > -1) dataHandlers.splice(index, 1);
  };
  
  // Responder a pedidos de localização e playlists
  p2pService.onData = async (peerId, data) => {
    console.log('[App] 📨 Received data:', data.type, 'from', peerId);
    console.log('[App] Broadcasting to', dataHandlers.length, 'handler(s)');
    
    // Broadcast para todos os handlers registrados (P2PView, etc)
    for (const handler of dataHandlers) {
      try {
        await handler(peerId, data);
      } catch (error) {
        console.error('[App] Error in data handler:', error);
      }
    }
    
    if (data.type === 'request-location') {
      console.log('[App] 📍 Peer', peerId, 'requested location, sending...');
      if ('geolocation' in navigator) {
        navigator.geolocation.getCurrentPosition(pos => {
          const location = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          console.log('[App] 📤 Sending location to', peerId, ':', location, 'device:', deviceType);
          p2pService.sendTo(peerId, { 
            type: 'location', 
            payload: { ...location, device: deviceType } 
          });
          console.log('[App] ✅ Location sent successfully');
        }, (error) => {
          console.error('[App] ❌ Geolocation error:', error.message);
        }, {
          enableHighAccuracy: false,
          timeout: 5000,
          maximumAge: 60000
        });
      }
    } else if (data.type === 'request-playlists') {
      // Importar PlaylistService dinamicamente para evitar problemas
      console.log('[App] 📋 Peer requested playlists, responding with counts only...');
      try {
        const { PlaylistService } = await import('./services/playlist');
        const playlistService = new PlaylistService();
        const playlists = await playlistService.loadPlaylists();
        const playlistsBasic = [] as Array<{ id?: number; name: string; songCount: number }>;
        for (const p of playlists) {
          const count = p.id ? await playlistService.getPlaylistSongCount(p.id) : 0;
          playlistsBasic.push({ id: p.id, name: p.name, songCount: count });
        }
        p2pService.sendTo(peerId, { type: 'playlists-response', payload: { playlists: playlistsBasic } });
      } catch (error) {
        console.error('[App] Error loading playlists:', error);
      }
    } else if (data.type === 'request-clone') {
      console.log('[App] 💾 Peer requested clone of playlist', data.payload.playlistId);
      try {
        const { PlaylistService } = await import('./services/playlist');
        const playlistService = new PlaylistService();
        const playlist = await playlistService.getPlaylistWithSongs(data.payload.playlistId);
        
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
        
        // Send each song in chunks
        // Use larger chunks over WebRTC (64KB) and safer size over Ably fallback (30KB)
        const CHUNK_SIZE = p2pService.isDirectConnected(peerId) ? (64 * 1024) : (30 * 1024);
        for (let i = 0; i < playlist.songs.length; i++) {
          const song = playlist.songs[i];
          const dataStr = song.data;
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
            
            // Small delay between chunks to avoid overwhelming client
            await new Promise(resolve => setTimeout(resolve, 15));
          }
        }
        
        // Send completion
        p2pService.sendTo(peerId, { 
          type: 'clone-complete', 
          payload: { playlistName: playlist.name } 
        });
      } catch (error) {
        console.error('[App] Error handling clone request:', error);
        p2pService.sendTo(peerId, { type: 'clone-error', payload: { message: 'Erro ao processar clonagem' } });
      }
    } else if (data.type === 'request-playlist-songs-meta') {
      // Send minimal songs metadata for the given playlist — paginated
      try {
        const { PlaylistService } = await import('./services/playlist');
        const playlistService = new PlaylistService();
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
        console.error('[App] Error sending songs meta:', error);
      }
    } else if (data.type === 'request-song') {
      // Send only one song from the playlist
      try {
        const { PlaylistService } = await import('./services/playlist');
        const playlistService = new PlaylistService();
        const idx = data.payload.songIndex;
        const playlistId = data.payload.playlistId;
        const song = await playlistService.getSongByIndex(playlistId, idx);
        if (!song) {
          p2pService.sendTo(peerId, { type: 'clone-error', payload: { message: 'Música não encontrada.' } });
          return;
        }

        // Start session for single-song transfer
        p2pService.sendTo(peerId, { 
          type: 'clone-start', 
          payload: { 
            playlistName: 'Playlist',
            totalSongs: 1
          } 
        });

        const CHUNK_SIZE = p2pService.isDirectConnected(peerId) ? (64 * 1024) : (30 * 1024);
        const dataStr = song.data;
        const totalChunks = Math.ceil(dataStr.length / CHUNK_SIZE);

        // Send song metadata
        p2pService.sendTo(peerId, {
          type: 'clone-song-meta',
          payload: {
            songIndex: 0,
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
              songIndex: 0,
              chunkIndex,
              totalChunks,
              data: chunk
            }
          });
          await new Promise(resolve => setTimeout(resolve, 15));
        }

        // Complete
        p2pService.sendTo(peerId, { type: 'clone-complete', payload: { playlistName: 'Playlist' } });
      } catch (error) {
        console.error('[App] Error handling single-song request:', error);
        p2pService.sendTo(peerId, { type: 'clone-error', payload: { message: 'Erro ao processar música' } });
      }
    }
  };
});

onUnmounted(() => {
  // Não destruir o serviço ao desmontar, deixar rodando
  console.log('[App] App unmounted, but P2P service remains active');
});
</script>

<style>
/* Resetting default margin and box-sizing */
html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  overflow: hidden; /* Prevents scrollbars from appearing due to router transitions */
}

#app {
  width: 100%;
  height: 100%;
}
</style>