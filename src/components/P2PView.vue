<template>
  <div class="p2p-view">
    <div id="map"></div>
     <div class="status-overlay">
      <p :class="{ 'status-connected': connectedPeersCount > 0, 'status-disconnected': connectedPeersCount === 0 }">
        Status: {{ connectedPeersCount > 0 ? `${connectedPeersCount} usuário(s) conectado(s)` : 'Buscando...' }}
      </p>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, onMounted, ref, onUnmounted, computed, watch } from 'vue';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { p2pService } from '../services/p2p';
import { PlaylistService, type PlaylistWithSongs } from '../services/playlist';
import type { Song } from '../services/db';

// Message Types
interface P2PMessage {
  type: 'location' | 'request-playlists' | 'playlists-response' | 'request-playlist-clone' | 'clone-playlist-data';
  payload: any;
}

export default defineComponent({
  name: 'P2PView',
  props: {
    isActive: {
      type: Boolean,
      required: true
    }
  },
  setup(props) {
    const connectedPeersCount = ref(0);
    const userLocation = ref<{ latitude: number; longitude: number } | null>(null);
    const localUserId = ref('');
    
    let map: L.Map | null = null;
    const peerMarkers = new Map<string, L.Marker>();
    const playlistService = new PlaylistService();

    watch(() => props.isActive, (newVal) => {
      if (newVal && map) {
        // Use nextTick or a short timeout to ensure the map div is visible and has dimensions
        setTimeout(() => {
          map?.invalidateSize();
        }, 100);
      }
    });

    onMounted(async () => {
      
      map = L.map('map').setView([51.505, -0.09], 13);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(map);

      if ('geolocation' in navigator) {
        navigator.geolocation.getCurrentPosition(position => {
          const { latitude, longitude } = position.coords;
          userLocation.value = { latitude, longitude };
          const userLatLng = new L.LatLng(latitude, longitude);
          map!.setView(userLatLng, 15);
          L.marker(userLatLng).addTo(map!).bindPopup('Você está aqui!').openPopup();
        }, (error) => {
            console.error("Geolocation error:", error);
            alert("Não foi possível obter a geolocalização. Por favor, certifique-se que o acesso à localização está permitido e que a conexão é HTTPS.");
        }, {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0
        });
      }

      // --- P2P Service Setup ---
      p2pService.onConnect = (peerId) => {
        connectedPeersCount.value++;
        console.log(`P2P Connection established with ${peerId}. Total peers: ${connectedPeersCount.value}`);
        if (userLocation.value) {
          p2pService.sendTo(peerId, { 
            type: 'location',
            payload: { userId: localUserId.value, ...userLocation.value }
          });
        }
      };

      p2pService.onDisconnect = (peerId) => {
        connectedPeersCount.value = Math.max(0, connectedPeersCount.value - 1);
        console.log(`Peer ${peerId} disconnected. Total peers: ${connectedPeersCount.value}`);
        if (peerMarkers.has(peerId)) {
            peerMarkers.get(peerId)!.remove();
            peerMarkers.delete(peerId);
        }
      };

      p2pService.onData = async (peerId, data: P2PMessage) => {
        console.log(`Received message of type ${data.type} from ${peerId}`);
        switch (data.type) {
          case 'location':
            handleLocationData(data.payload);
            break;
          case 'request-playlists':
            await handlePlaylistRequest(peerId, data.payload);
            break;
          case 'playlists-response':
            handlePlaylistResponse(data.payload);
            break;
          case 'request-playlist-clone':
            await handlePlaylistCloneRequest(peerId, data.payload);
            break;
          case 'clone-playlist-data':
            await handlePlaylistCloneData(data.payload);
            break;
        }
      };
      
      p2pService.onError = (err) => {
        console.error(`P2P Service Error: ${err.message}`);
        // Optionally show a non-intrusive error to the user
      };
      
      await p2pService.init();
      localUserId.value = p2pService.getLocalId();
      
      // --- Global functions for map popups ---
      (window as any).requestPlaylists = (peerId: string) => {
        p2pService.sendTo(peerId, { type: 'request-playlists', payload: { from: localUserId.value } });
      };

      (window as any).clonePlaylist = (peerId: string, playlistId: number) => {
          p2pService.sendTo(peerId, { type: 'request-playlist-clone', payload: { from: localUserId.value, playlistId, peerId: peerId } });
          console.log(`Requesting clone of playlist ${playlistId} from ${peerId}`);
      };
    });

    const handleLocationData = (payload: any) => {
      if (map && payload.userId !== localUserId.value) {
        let { latitude, longitude, userId: peerId } = payload;
        const newLatLng = new L.LatLng(latitude, longitude);

        // --- Marker Overlap Logic ---
        const overlapOffset = 0.0001; // Small value to offset markers
        peerMarkers.forEach(existingMarker => {
            if (existingMarker.getLatLng().equals(newLatLng)) {
                console.log(`Marker overlap detected for ${peerId}. Applying offset.`);
                latitude += overlapOffset;
            }
        });
        
        const finalLatLng = new L.LatLng(latitude, longitude);

        if (peerMarkers.has(peerId)) {
          peerMarkers.get(peerId)!.setLatLng(finalLatLng);
        } else {
          const newMarker = L.marker(finalLatLng).addTo(map)
            .bindPopup(`<b>Usuário:</b> ${peerId.substring(0, 8)}...<br/><button onclick="requestPlaylists('${peerId}')">Ver Playlists</button>`);
          peerMarkers.set(peerId, newMarker);
        }
      }
    };

    const handlePlaylistRequest = async (requestingPeerId: string, payload: any) => {
      const playlists = await playlistService.loadPlaylists();
      p2pService.sendTo(requestingPeerId, {
        type: 'playlists-response',
        payload: { from: localUserId.value, playlists }
      });
    };
    
    const handlePlaylistResponse = (payload: any) => {
        const { from, playlists } = payload;
        const marker = peerMarkers.get(from);
        if (marker) {
            let popupContent = `<b>Playlists de ${from.substring(0, 8)}...:</b><ul>`;
            playlists.forEach((p: PlaylistWithSongs) => {
                popupContent += `<li>${p.name} <button onclick="clonePlaylist('${from}', ${p.id})">Clonar</button></li>`;
            });
            popupContent += '</ul>';
            marker.setPopupContent(popupContent).openPopup();
        }
    };

    const handlePlaylistCloneRequest = async (requestingPeerId: string, payload: any) => {
        const { playlistId, peerId } = payload;
        const playlistData = await playlistService.getPlaylistWithSongs(playlistId);
        if (!playlistData) return;

        p2pService.sendTo(requestingPeerId, {
            type: 'clone-playlist-data',
            payload: {
                from: localUserId.value,
                peerId: peerId,
                playlist: { id: playlistData.id, name: playlistData.name },
                songs: playlistData.songs
            }
        });
    };

    const handlePlaylistCloneData = async (payload: any) => {
        const { peerId, playlist, songs } = payload;
        const clonedPlaylistName = `[clonado de: ${peerId.substring(0,8)}] ${playlist.name}`;
        
        const newPlaylistId = await playlistService.addPlaylist(clonedPlaylistName);

        for (const song of songs) {
            const newSong: Omit<Song, 'id'> = { 
                ...song, 
                playlistId: newPlaylistId,
                year: song.year || '',
                img: song.img || ''
            };
            delete (newSong as any).id;
            await playlistService.addSong(newSong);
        }

        console.log(`Playlist "${clonedPlaylistName}" was cloned successfully.`);
    };

    onUnmounted(() => {
        p2pService.destroy();
        map?.remove();
        delete (window as any).requestPlaylists;
        delete (window as any).clonePlaylist;
    });

    return { connectedPeersCount };
  }
});
</script>

<style scoped>
.p2p-view {
  position: relative;
  width: 100%;
  height: 100%;
}

#map {
  width: 100%;
  height: 100vh;
}

.status-overlay {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.6);
  color: white;
  padding: 8px 15px;
  border-radius: 20px;
  z-index: 1000;
  font-size: 0.9em;
  pointer-events: none;
}

.status-connected {
  color: #86efac; /* green-300 */
}

.status-disconnected {
  color: #fca5a5; /* red-300 */
}
</style>

