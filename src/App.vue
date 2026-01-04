<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, nextTick, defineAsyncComponent, h } from 'vue';
import { dbService, type Playlist, type Song } from './services/db';

// Lazy load AudioVisualizer only when needed
const AudioVisualizer = defineAsyncComponent({
  loader: () => import('./components/AudioVisualizer.vue'),
  errorComponent: { render: () => h('div') },
  delay: 200,
  timeout: 3000,
});

// --- Interfaces ---
interface PlaylistWithSongs {
  id: number;
  name: string;
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

// State for editing playlist names
const editingPlaylistId = ref<number | null>(null);
const editingPlaylistName = ref('');

// State for hiding song info on small screens
const hideSongInfo = ref(false);
const isHeaderCollapsed = ref(false); // Manual toggle state
let songInfoHideTimer: number | null = null;
let touchStartY = 0;
let touchStartTime = 0;
let isScrolling = false;

// Reactive window dimensions
const windowWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1024);
const windowHeight = ref(typeof window !== 'undefined' ? window.innerHeight : 768);

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

// Check if screen is small (like iPhone 13, iPhone SE)
const isSmallScreen = computed(() => {
  return windowHeight.value <= 750 && windowWidth.value <= 450;
});

// Check if is desktop (large screen)
const isDesktop = computed(() => {
  return windowWidth.value > 768;
});

// --- Lifecycle & Data Loading ---
onMounted(async () => {
  try {
    console.log('App mounted, starting initialization...');
    
    console.log('Loading playlists and songs...');
    await loadPlaylistsAndSongs();
    
    console.log('Creating audio player...');
    audioPlayer.value = new Audio();
    audioPlayer.value.addEventListener('ended', nextTrack);
    audioPlayer.value.addEventListener('play', () => {
      console.log('Audio play event fired');
      isPlaying.value = true;
    });
    audioPlayer.value.addEventListener('pause', () => {
      console.log('Audio pause event fired');
      isPlaying.value = false;
    });
    
    console.log('Setting up resize listener...');
    // Update window dimensions on resize
    const handleResize = () => {
      windowWidth.value = window.innerWidth;
      windowHeight.value = window.innerHeight;
    };
    window.addEventListener('resize', handleResize);
    
    // Store resize handler for cleanup
    (window as any).__resizeHandler = handleResize;
    
    console.log('App initialization complete!');
  } catch (error) {
    console.error('CRITICAL ERROR during mount:', error);
    // Even on error, try to set up basic functionality
    try {
      playlists.value = [{ id: 1, name: 'Minha Playlist', songs: [] }];
      audioPlayer.value = new Audio();
    } catch (fallbackError) {
      console.error('Fallback initialization also failed:', fallbackError);
    }
  }
});

// Cleanup on unmount
onUnmounted(() => {
  clearSongInfoTimer();
  
  // Remove resize listener
  const handleResize = (window as any).__resizeHandler;
  if (handleResize) {
    window.removeEventListener('resize', handleResize);
  }
});

async function loadPlaylistsAndSongs() {
  try {
    const loadedPlaylists = await dbService.getPlaylists();
    const playlistsWithSongs: PlaylistWithSongs[] = [];

    if (loadedPlaylists.length === 0) {
      const newId = await dbService.addPlaylist('Sua Playlist');
      playlistsWithSongs.push({ id: newId, name: 'Sua Playlist', songs: [] });
    } else {
      for (const p of loadedPlaylists) {
        const songs = await dbService.getSongsByPlaylist(p.id!);
        playlistsWithSongs.push({ 
          id: p.id!,
          name: p.name,
          songs
        });
      }
    }

    playlists.value = playlistsWithSongs;
    if (playlists.value.length > 0) {
      activePlaylistId.value = playlists.value[0].id!;
    }
  } catch (error) {
    console.error('Error loading playlists:', error);
    playlists.value = [{ id: 1, name: 'Minha Playlist', songs: [] }];
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

  // Show song info immediately when playing a song
  showSongInfoImmediately();

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

// --- Playlist Editing Functions ---
function startEditingPlaylist(playlist: PlaylistWithSongs) {
  editingPlaylistId.value = playlist.id!;
  editingPlaylistName.value = playlist.name;
}

function cancelEditingPlaylist() {
  editingPlaylistId.value = null;
  editingPlaylistName.value = '';
}

async function savePlaylistName(playlistId: number) {
  if (editingPlaylistName.value.trim()) {
    const playlist = playlists.value.find(p => p.id === playlistId);
    if (playlist) {
      // Update in database
      await dbService.updatePlaylist({
        id: playlistId,
        name: editingPlaylistName.value.trim()
      });
      
      // Update local state immediately
      playlist.name = editingPlaylistName.value.trim();
    }
  }
  cancelEditingPlaylist();
}

// --- Song Info Visibility Functions ---
let hideDelayTimer: number | null = null;

function handlePlaylistTouchStart(event: TouchEvent | MouseEvent) {
  if (!isSmallScreen.value) return;
  
  // Don't track for buttons, inputs, or interactive elements
  const target = event.target as HTMLElement;
  if (target.closest('button') || 
      target.closest('input') || 
      target.closest('.add-playlist-trigger')) {
    return;
  }
  
  if (event instanceof TouchEvent && event.touches.length > 0) {
    touchStartY = event.touches[0].clientY;
    touchStartTime = Date.now();
    isScrolling = false;
  }
  
  clearHideDelayTimer();
  clearSongInfoTimer();
}

function handlePlaylistTouchMove(event: TouchEvent | MouseEvent) {
  if (!isSmallScreen.value) return;
  
  if (event instanceof TouchEvent && event.touches.length > 0) {
    const touchCurrentY = event.touches[0].clientY;
    const deltaY = Math.abs(touchCurrentY - touchStartY);
    
    // If moved more than 10px, consider it scrolling
    if (deltaY > 10 && !isScrolling) {
      isScrolling = true;
      // Add delay before hiding for smoother UX
      hideDelayTimer = setTimeout(() => {
        hideSongInfo.value = true;
      }, 150);
    }
  }
}

function handlePlaylistTouchEnd(event: TouchEvent | MouseEvent) {
  if (!isSmallScreen.value) return;
  
  const target = event.target as HTMLElement;
  if (target.closest('button') || 
      target.closest('input') || 
      target.closest('.add-playlist-trigger')) {
    return;
  }
  
  clearHideDelayTimer();
  
  // Always reset scrolling state and show info after delay
  if (isScrolling) {
    startSongInfoTimer();
    isScrolling = false;
  }
}

function clearHideDelayTimer() {
  if (hideDelayTimer) {
    clearTimeout(hideDelayTimer);
    hideDelayTimer = null;
  }
}

function startSongInfoTimer() {
  clearSongInfoTimer();
  songInfoHideTimer = setTimeout(() => {
    hideSongInfo.value = false;
    console.log('Song info shown again after scroll');
  }, 2000); // Show again after 2 seconds
}

function clearSongInfoTimer() {
  if (songInfoHideTimer) {
    clearTimeout(songInfoHideTimer);
    songInfoHideTimer = null;
  }
}

function showSongInfoImmediately() {
  clearSongInfoTimer();
  hideSongInfo.value = false;
}

function toggleHeaderCollapse() {
  isHeaderCollapsed.value = !isHeaderCollapsed.value;
}
</script>

<template>
  <div id="app-container">
    <div class="player-main">
      <!-- Collapse toggle button for mobile -->
      <button v-if="isSmallScreen" @click="toggleHeaderCollapse" class="collapse-toggle" :title="isHeaderCollapsed ? 'Mostrar informações' : 'Ocultar informações'">
        {{ isHeaderCollapsed ? '∨' : '∧' }}
      </button>
      
      <h1 v-show="(!hideSongInfo || !isSmallScreen) && !isHeaderCollapsed" class="fade-element">Player de Música Offline</h1>
      <p class="subtitle fade-element" v-show="(!hideSongInfo || !isSmallScreen) && !isHeaderCollapsed">Adicione músicas do seu computador e elas ficarão salvas para a sua próxima visita.</p>
      
      <!-- Show visualizer only on desktop when music is playing -->
      <div v-if="isDesktop && currentSong" class="visualizer-container">
        <AudioVisualizer 
          :audio-element="audioPlayer" 
          :is-playing="isPlaying" 
        />
      </div>
      
      <div class="song-info fade-element" v-show="(!hideSongInfo || !isSmallScreen) && !isHeaderCollapsed">
        <h2>{{ currentSong?.title || 'Nenhuma música tocando' }}</h2>
        <p>{{ currentSong?.artist }}</p>
      </div>
      
      <!-- Small indicator for small screens when info is hidden -->
      <div v-if="(hideSongInfo || isHeaderCollapsed) && isSmallScreen" class="song-info-indicator fade-element">
        ♪
      </div>

      <div class="controls">
        <button @click="prevTrack" title="Anterior">⏪</button>
        <button @click="togglePlayPause" class="play-pause-btn" :title="isPlaying ? 'Pausar' : 'Tocar'">
          {{ isPlaying ? '⏸️' : '▶️' }}
        </button>
        <button @click="nextTrack" title="Próxima">⏩</button>
      </div>
    </div>

    <div class="playlist-view" 
         @touchstart="handlePlaylistTouchStart"
         @touchmove="handlePlaylistTouchMove"
         @touchend="handlePlaylistTouchEnd"
         @mousedown="handlePlaylistTouchStart"
         @mouseup="handlePlaylistTouchEnd">
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
          <!-- Playlist name display/edit -->
          <div v-if="editingPlaylistId !== playlist.id" class="playlist-name-display">
            <h2 @click="startEditingPlaylist(playlist)" class="editable-playlist-name" title="Clique para editar o nome">{{ playlist.name }}</h2>
          </div>
          <div v-else class="playlist-name-edit">
            <input 
              type="text" 
              v-model="editingPlaylistName" 
              @keyup.enter="savePlaylistName(playlist.id!)"
              @keyup.escape="cancelEditingPlaylist()"
              @blur="savePlaylistName(playlist.id!)"
              class="edit-playlist-input"
              autofocus
            >
            <button @click="savePlaylistName(playlist.id!)" class="save-playlist-btn" title="Salvar">✓</button>
            <button @click="cancelEditingPlaylist()" class="cancel-playlist-btn" title="Cancelar">✕</button>
          </div>
          
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

/* Smooth fade transition for elements */
.fade-element {
  transition: opacity 0.4s ease-in-out, transform 0.4s ease-in-out;
}

.fade-element[style*="display: none"] {
  opacity: 0;
  transform: translateY(-10px);
}

.visualizer-container {
  width: 100%;
  height: 200px;
  margin-bottom: 30px;
  position: relative;
  box-sizing: border-box;
  display: flex;
  justify-content: center;
  align-items: center;
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
  transition: opacity 0.3s ease;
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

.song-info-indicator {
  font-size: 2em;
  opacity: 0.6;
  margin: 15px 0;
  animation: pulse 2s infinite;
}

.collapse-toggle {
  position: fixed;
  top: 10px;
  right: 15px;
  background: rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: white;
  font-size: 1.5em;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  cursor: pointer;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s ease;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
}

.collapse-toggle:active {
  transform: scale(0.95);
  background: rgba(255, 255, 255, 0.25);
}

@keyframes pulse {
  0% { opacity: 0.6; }
  50% { opacity: 1; }
  100% { opacity: 0.6; }
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
  padding: 8px;
  min-width: 44px;
  min-height: 44px;
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

.playlist-name-display {
  flex: 1;
}

.editable-playlist-name {
  cursor: pointer;
  margin: 0;
  padding: 5px;
  border-radius: 4px;
  transition: background-color 0.2s;
}

.editable-playlist-name:hover {
  background: rgba(255, 255, 255, 0.1);
}

.playlist-name-edit {
  display: flex;
  align-items: center;
  flex: 1;
  gap: 8px;
}

.edit-playlist-input {
  flex: 1;
  padding: 8px;
  border: none;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.9);
  color: #333;
  font-size: 16px;
  font-weight: bold;
}

.save-playlist-btn, .cancel-playlist-btn {
  padding: 6px 10px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-weight: bold;
  transition: background-color 0.2s;
}

.save-playlist-btn {
  background: #4CAF50;
  color: white;
}

.save-playlist-btn:hover {
  background: #45a049;
}

.cancel-playlist-btn {
  background: #f44336;
  color: white;
}

.cancel-playlist-btn:hover {
  background: #da190b;
}

.add-songs-btn {
  background: var(--primary-color);
  border: none;
  border-radius: 20px;
  color: white;
  font-size: 1em;
  font-weight: bold;
  padding: 12px 24px;
  cursor: pointer;
  transition: background-color 0.2s;
  min-height: 48px;
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

/* ===== MOBILE RESPONSIVE STYLES ===== */

/* Prevent zoom on input focus for iOS */
@media (max-width: 768px) {
  input, textarea, select {
    font-size: 16px !important;
  }
}

/* Mobile devices - Galaxy S24, iPhone 13 mini, iPhone SE */
@media (max-width: 768px) {
  #app-container {
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
    position: fixed;
    width: 100%;
    top: 0;
    left: 0;
  }

  .player-main {
    width: 100%;
    max-width: none;
    padding: 20px 15px;
    background-color: rgba(0, 0, 0, 0.8);
    min-height: auto;
    border-bottom: 1px solid rgba(255, 255, 255, 0.2);
    box-sizing: border-box;
  }

  .static-content {
    margin-bottom: 20px;
    max-width: calc(100dvw - 30px);
    box-sizing: border-box;
  }

  .visualizer-container {
    height: 150px;
    margin-bottom: 20px;
    width: 100%;
    max-width: calc(100dvw - 30px);
    box-sizing: border-box;
    display: flex;
    justify-content: center;
    align-items: center;
    margin-left: auto;
    margin-right: auto;
  }

  .player-main h1 {
    font-size: 1.8em;
    margin-bottom: 8px;
    max-width: calc(100dvw - 30px);
    word-wrap: break-word;
    box-sizing: border-box;
  }

  .subtitle {
    font-size: 0.9em;
    margin-bottom: 20px;
    max-width: calc(100dvw - 30px);
    word-wrap: break-word;
    box-sizing: border-box;
  }

  .song-info {
    margin: 15px 0;
    min-height: 60px;
  }

  .song-info h2 {
    font-size: 1.4em;
  }

  .song-info p {
    font-size: 0.9em;
  }

  .controls {
    gap: 15px;
    margin-bottom: 10px;
  }

  .controls button {
    font-size: 1.8em;
    padding: 10px;
    min-width: 50px;
    min-height: 50px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.1);
    backdrop-filter: blur(5px);
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }

  .controls button:active {
    transform: scale(0.95);
    background: rgba(255, 255, 255, 0.2);
  }

  .controls .play-pause-btn {
    font-size: 2.5em;
    min-width: 60px;
    min-height: 60px;
  }

  .playlist-view {
    padding: 15px;
    flex: 1;
    overflow-y: auto;
  }

  .new-playlist-controls {
    margin-bottom: 20px;
    padding-bottom: 15px;
  }

  .add-playlist-trigger {
    font-size: 1.1em;
    padding: 12px 0;
  }

  .new-playlist-input {
    padding: 16px 60px 16px 20px;
    font-size: 1.1em;
    min-height: 52px;
  }

  .add-playlist-btn {
    right: 8px;
    font-size: 2em;
    padding: 10px 12px;
    min-width: 44px;
    min-height: 44px;
  }

  .playlist-container {
    margin-bottom: 20px;
  }

  .playlist-header {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    padding: 15px;
  }

  .playlist-name-display,
  .playlist-name-edit {
    order: 1;
  }

  .playlist-actions {
    order: 2;
    justify-content: space-between;
    gap: 10px;
  }

  .playlist-header h2,
  .editable-playlist-name {
    font-size: 1.5em;
    text-align: center;
  }

  .edit-playlist-input {
    font-size: 1.3em;
    padding: 14px;
    min-height: 50px;
  }

  .save-playlist-btn, 
  .cancel-playlist-btn {
    padding: 12px 16px;
    font-size: 1.2em;
    min-width: 50px;
    min-height: 48px;
    min-width: 40px;
  }

  .add-songs-btn {
    flex: 1;
    padding: 16px 20px;
    font-size: 1.1em;
    border-radius: 25px;
    min-height: 52px;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }

  .add-songs-btn:active {
    transform: scale(0.98);
  }

  .delete-playlist-btn {
    font-size: 2em;
    padding: 10px 14px;
    min-width: 48px;
    min-height: 48px;
    border-radius: 50%;
    background: rgba(255, 0, 0, 0.1);
    min-width: 45px;
    min-height: 45px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .song-list li {
    padding: 18px 15px;
    margin-bottom: 5px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.05);
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }

  .song-list li:active {
    transform: scale(0.98);
    background-color: rgba(255, 255, 255, 0.2);
  }

  .song-list li:hover {
    background-color: rgba(255, 255, 255, 0.15);
  }

  .song-list li.active {
    background-color: var(--primary-color);
  }

  .song-title {
    font-size: 1.1em;
  }

  .song-artist {
    font-size: 0.95em;
  }

  .delete-song-btn {
    font-size: 1.4em;
    padding: 8px;
    min-width: 35px;
    min-height: 35px;
    border-radius: 50%;
    background: rgba(255, 0, 0, 0.1);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .empty-playlist {
    padding: 25px 15px;
    font-size: 1em;
  }
}

/* Extra small devices - iPhone SE and similar */
@media (max-width: 420px) {
  .player-main {
    padding: 15px 10px;
    box-sizing: border-box;
  }

  .player-main h1 {
    font-size: 1.6em;
    max-width: calc(100dvw - 20px);
    word-wrap: break-word;
  }

  .subtitle {
    font-size: 0.85em;
    max-width: calc(100dvw - 20px);
    word-wrap: break-word;
  }

  .song-info h2 {
    font-size: 1.2em;
  }

  .controls {
    gap: 12px;
  }

  .controls button {
    font-size: 1.6em;
    min-width: 45px;
    min-height: 45px;
  }

  .controls .play-pause-btn {
    font-size: 2.2em;
    min-width: 55px;
    min-height: 55px;
  }

  .playlist-view {
    padding: 10px;
  }

  .playlist-header {
    padding: 12px;
  }

  .playlist-header h2,
  .editable-playlist-name {
    font-size: 1.3em;
  }

  .add-songs-btn {
    font-size: 0.9em;
    padding: 10px 12px;
  }

  .song-list li {
    padding: 15px 12px;
  }

  .song-title {
    font-size: 1em;
  }

  .song-artist {
    font-size: 0.9em;
  }
}
</style>
