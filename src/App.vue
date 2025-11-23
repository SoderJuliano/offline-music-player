<script setup lang="ts">
import { ref, onMounted, computed, nextTick } from 'vue';
import { dbService, type Playlist, type Song } from './services/db';

// --- Interfaces ---
interface PlaylistWithSongs extends Playlist {
  songs: Song[];
}

// --- Component State ---
const playlists = ref<PlaylistWithSongs[]>([]);
const activePlaylistId = ref<number | null>(null);
const currentSongIndex = ref(-1);

const audioPlayer = ref<HTMLAudioElement | null>(null);
let currentObjectURL: string | null = null;
const isPlaying = ref(false);

const newPlaylistName = ref('');
const fileInputRef = ref<HTMLInputElement | null>(null);
const isAddingNewPlaylist = ref(false); // New state for toggling new playlist input

// --- Computed Properties ---
const activeSongs = computed(() => {
  if (!activePlaylistId.value) return [];
  const activePlaylist = playlists.value.find(p => p.id === activePlaylistId.value);
  return activePlaylist ? activePlaylist.songs : [];
});

const currentSong = computed(() => {
  return currentSongIndex.value > -1 && activeSongs.value[currentSongIndex.value]
    ? activeSongs.value[currentSongIndex.value]
    : null;
});

// --- Lifecycle & Data Loading ---
onMounted(async () => {
  await loadPlaylistsAndSongs();
  audioPlayer.value = new Audio();
  audioPlayer.value.addEventListener('ended', nextTrack);
  audioPlayer.value.addEventListener('play', () => isPlaying.value = true);
  audioPlayer.value.addEventListener('pause', () => isPlaying.value = false);
});

async function loadPlaylistsAndSongs() {
  const loadedPlaylists = await dbService.getPlaylists();
  const playlistsWithSongs: PlaylistWithSongs[] = [];

  if (loadedPlaylists.length === 0) {
    const newId = await dbService.addPlaylist('Sua Playlist');
    playlistsWithSongs.push({ id: newId, name: 'Sua Playlist', songs: [] });
  } else {
    for (const p of loadedPlaylists) {
      const songs = await dbService.getSongsByPlaylist(p.id!);
      playlistsWithSongs.push({ ...p, songs });
    }
  }
  
  playlists.value = playlistsWithSongs;
  if (playlists.value.length > 0) {
    activePlaylistId.value = playlists.value[0].id!;
  }
}

// --- Playback Controls ---
function playSong(index: number, playlistId: number) {
  if (activePlaylistId.value !== playlistId) {
    activePlaylistId.value = playlistId;
  }

  if (index < 0 || index >= activeSongs.value.length) return;
  currentSongIndex.value = index;
  
  const song = activeSongs.value[index];
  if (!song) return;

  if (currentObjectURL) {
    URL.revokeObjectURL(currentObjectURL);
  }
  currentObjectURL = URL.createObjectURL(song.data);

  if (audioPlayer.value) {
    audioPlayer.value.src = currentObjectURL;
    audioPlayer.value.play();
  }
}

function togglePlayPause() {
  if (!audioPlayer.value) return;
  if (isPlaying.value) {
    audioPlayer.value.pause();
  } else {
    if (currentSong.value) {
      audioPlayer.value.play();
    } else if (activeSongs.value.length > 0) {
      playSong(0, activePlaylistId.value!);
    }
  }
}

function nextTrack() {
  const nextIndex = currentSongIndex.value + 1;
  if (nextIndex < activeSongs.value.length) {
    playSong(nextIndex, activePlaylistId.value!);
  } else {
    // End of playlist, loop back to the first song if available
    if (activeSongs.value.length > 0) {
      playSong(0, activePlaylistId.value!);
    } else {
      isPlaying.value = false;
      currentSongIndex.value = -1;
      if (currentObjectURL) URL.revokeObjectURL(currentObjectURL);
      currentObjectURL = null;
      if(audioPlayer.value) audioPlayer.value.src = '';
    }
  }
}

function prevTrack() {
  const prevIndex = currentSongIndex.value - 1;
  if (prevIndex >= 0) {
    playSong(prevIndex, activePlaylistId.value!);
  }
}

// --- Playlist & Song Management ---
async function addPlaylist() {
  if (newPlaylistName.value.trim()) {
    await dbService.addPlaylist(newPlaylistName.value.trim());
    newPlaylistName.value = '';
    isAddingNewPlaylist.value = false; // Hide input after adding
    await loadPlaylistsAndSongs();
  }
}

function handleNewPlaylistBlur() {
    // Use a small delay to allow the add button click to register first
    setTimeout(() => {
        if (newPlaylistName.value.trim() === '') {
            isAddingNewPlaylist.value = false;
        }
    }, 200);
}

function triggerFileInput(playlistId: number) {
  activePlaylistId.value = playlistId; // Set active playlist for upload
  fileInputRef.value?.click();
}

async function handleFileSelection(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!input.files || input.files.length === 0 || !activePlaylistId.value) return;

  const file = input.files[0];
  if (!file.type.startsWith('audio/')) {
    alert('Por favor, selecione um arquivo de áudio válido.');
    input.value = '';
    return;
  }

  const newSong: Omit<Song, 'id'> = {
    playlistId: activePlaylistId.value,
    title: file.name.split('.').slice(0, -1).join('.') || 'Música desconhecida',
    artist: 'Artista Desconhecido',
    year: new Date().getFullYear().toString(),
    img: 'musica.png',
    data: file,
  };

  await dbService.addSong(newSong);
  await loadPlaylistsAndSongs();
  input.value = '';
}

async function deleteSong(songId: number, playlistId: number) {
  if (currentSong.value?.id === songId) {
    nextTrack();
  }
  
  await dbService.deleteSong(songId);
  
  // Find the playlist and remove the song locally for instant UI update
  const playlist = playlists.value.find(p => p.id === playlistId);
  if (playlist) {
    const songIndex = playlist.songs.findIndex(s => s.id === songId);
    if (songIndex > -1) {
      playlist.songs.splice(songIndex, 1);
       if (currentSongIndex.value >= songIndex && activePlaylistId.value === playlistId) {
          currentSongIndex.value--;
       }
    }
  }
}

async function deletePlaylist(playlistId: number) {
  if (window.confirm('Tem certeza que deseja apagar esta playlist e todas as suas músicas?')) {
    await dbService.deletePlaylist(playlistId);
    await loadPlaylistsAndSongs();
  }
}
</script>

<template>
  <div id="app-container">
    <div class="player-main">
      <h1>Player de Música Offline</h1>
      <p class="subtitle">Adicione músicas do seu computador e elas ficarão salvas para a sua próxima visita.</p>
      
      <div class="song-info">
        <h2>{{ currentSong?.title || 'Nenhuma música tocando' }}</h2>
        <p>{{ currentSong?.artist }}</p>
      </div>

      <div class="controls">
        <button @click="prevTrack" title="Anterior">⏪</button>
        <button @click="togglePlayPause" class="play-pause-btn" :title="isPlaying ? 'Pausar' : 'Tocar'">
          {{ isPlaying ? '⏸️' : '▶️' }}
        </button>
        <button @click="nextTrack" title="Próxima">⏩</button>
      </div>
    </div>

    <div class="playlist-view">
      <!-- New Playlist Form -->
      <div class="new-playlist-controls">
        <span v-if="!isAddingNewPlaylist" @click="isAddingNewPlaylist = true" class="add-playlist-trigger">
            + Criar nova playlist
        </span>
        <div v-if="isAddingNewPlaylist" class="add-playlist-input-group">
            <input 
                type="text" 
                v-model="newPlaylistName" 
                @keyup.enter="addPlaylist" 
                @blur="handleNewPlaylistBlur"
                placeholder="Nome da nova playlist..."
                class="new-playlist-input"
                autofocus
            >
            <button @click="addPlaylist" class="add-playlist-btn" title="Criar playlist">+</button>
        </div>
      </div>

      <!-- Hidden file input for all playlists -->
      <input 
          ref="fileInputRef"
          type="file" 
          accept="audio/mp3,audio/mpeg,audio/wav,audio/aac" 
          @change="handleFileSelection" 
          hidden 
      />

      <!-- Loop through playlists -->
      <div v-for="playlist in playlists" :key="playlist.id" class="playlist-container">
        <div class="playlist-header">
          <h2>{{ playlist.name }}</h2>
          <div class="playlist-actions">
            <button @click="triggerFileInput(playlist.id!)" class="add-songs-btn">+ Adicionar Músicas</button>
            <button @click="deletePlaylist(playlist.id!)" class="delete-playlist-btn">🗑️</button>
          </div>
        </div>

        <ul class="song-list">
          <li v-if="playlist.songs.length === 0" class="empty-playlist">
            Esta playlist está vazia. Adicione algumas músicas para começar.
          </li>
          <li v-for="(song, index) in playlist.songs" :key="song.id" @click="playSong(index, playlist.id!)" :class="{ 'active': currentSong?.id === song.id }">
            <div class="song-details">
              <span class="song-title">{{ song.title }}</span>
              <span class="song-artist">{{ song.artist }}</span>
            </div>
            <button @click.stop="deleteSong(song.id!, playlist.id!)" class="delete-song-btn">(x)</button>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
@keyframes pulse-border {
  0% {
    border-left-color: rgba(255, 255, 255, 0.7);
  }
  50% {
    border-left-color: white;
  }
  100% {
    border-left-color: rgba(255, 255, 255, 0.7);
  }
}

#app-container {
  display: flex;
  height: 100vh;
  background-image: url('./img.jpg');
  background-size: cover;
  background-position: center;
  color: white;
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  backdrop-filter: blur(10px) brightness(0.7);
}

.player-main {
  width: 35%;
  max-width: 450px;
  background-color: rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding: 50px 40px;
  text-align: center;
}

.player-main h1 {
  font-size: 2.2em;
  margin-bottom: 10px;
}

.subtitle {
  font-size: 1em;
  opacity: 0.8;
  max-width: 300px;
  margin-bottom: 40px;
}

.song-info {
  margin: 30px 0;
  min-height: 80px;
}

.song-info h2 {
  font-size: 1.8em;
  margin: 0;
}

.song-info p {
  font-size: 1em;
  opacity: 0.8;
  margin-top: 8px;
}

.controls {
  display: flex;
  align-items: center;
  gap: 20px;
}

.controls button {
  background: none;
  border: none;
  color: white;
  font-size: 2em;
  cursor: pointer;
  transition: all 0.2s ease;
  opacity: 0.8;
}

.controls button:hover {
  opacity: 1;
  transform: scale(1.1);
}

.controls .play-pause-btn {
  font-size: 3em;
}

.playlist-view {
  flex-grow: 1;
  background-color: rgba(0, 0, 0, 0.6);
  padding: 30px 40px;
  overflow-y: auto;
}

.new-playlist-controls {
  margin-bottom: 30px;
  padding-bottom: 20px;
  border-bottom: 1px solid rgba(255,255,255,0.2);
  display: flex; /* Ensure flex for trigger and input group */
  align-items: center; /* Vertically align items */
  min-height: 45px; /* Reserve space */
}

.add-playlist-trigger {
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    font-size: 1.2em;
    padding: 10px 0;
    width: 100%;
    text-align: left;
    transition: color 0.2s;
}

.add-playlist-trigger:hover {
    color: white;
}

.add-playlist-input-group {
    display: flex;
    position: relative;
    width: 100%;
    align-items: center;
}

.new-playlist-input {
  flex-grow: 1;
  background: transparent;
  border: none; /* Remove all borders first */
  border-left: 2px solid white; /* Left border */
  border-bottom: 2px solid white; /* Bottom border */
  border-radius: 0; /* Remove border-radius */
  padding: 10px 40px 10px 12px; /* Add padding to the right for the button */
  color: white;
  font-size: 1.1em;
  caret-color: white; /* Blinking cursor color */
  outline: none; /* Remove outline on focus */
}

.new-playlist-input:focus {
    animation: pulse-border 1.5s infinite;
}

.add-playlist-btn {
  position: absolute;
  right: 5px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: white;
  font-size: 1.8em;
  padding: 0 10px;
  cursor: pointer;
  transition: color 0.2s;
  opacity: 0.7;
}

.add-playlist-btn:hover {
  opacity: 1;
  color: var(--primary-color);
}

.playlist-container {
  margin-bottom: 25px;
}


.playlist-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 15px;
}

.playlist-actions {
  display: flex;
  align-items: center;
  gap: 15px;
}

.delete-playlist-btn {
  background: none;
  border: none;
  color: #ff7b7b;
  font-size: 1.5em;
  cursor: pointer;
  opacity: 0.7;
  transition: all 0.2s ease;
}

.delete-playlist-btn:hover {
  opacity: 1;
  color: #ff5555;
  transform: scale(1.1);
}

.playlist-header h2 {
  margin: 0;
  font-size: 1.8em;
}

.add-songs-btn {
  background: var(--primary-color);
  border: none;
  border-radius: 20px;
  color: white;
  font-size: 1em;
  font-weight: bold;
  padding: 10px 20px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.add-songs-btn:hover {
  background: var(--primary-hover-color);
}

.song-list {
  list-style-type: none;
  padding: 0;
}

.empty-playlist, .song-list li {
  padding: 15px 10px;
  border-radius: 5px;
  transition: background-color 0.2s;
}

.empty-playlist {
  text-align: center;
  opacity: 0.6;
  font-style: italic;
}

.song-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
}

.song-list li:hover {
  background-color: rgba(255, 255, 255, 0.1);
}

.song-list li.active {
  background-color: var(--primary-color);
  color: white;
}

.song-details {
  display: flex;
  flex-direction: column;
}

.song-title {
  font-weight: 500;
  font-size: 1.1em;
}

.song-artist {
  opacity: 0.7;
  font-size: 0.9em;
}

.delete-song-btn {
  background: none;
  border: none;
  color: #ff5555;
  font-size: 1.2em;
  font-weight: bold;
  cursor: pointer;
  opacity: 0.6;
  transition: all 0.2s;
}

.delete-song-btn:hover {
  opacity: 1;
  transform: scale(1.2);
}
</style>
