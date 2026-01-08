<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, defineAsyncComponent, h } from 'vue'
import { type Song } from './services/db'
import { PlaylistService, type PlaylistWithSongs } from './services/playlist'
import { PlaybackService } from './services/playback'
import './styles/App.css'

const AudioVisualizer = defineAsyncComponent({
  loader: () => import('./components/AudioVisualizer.vue'),
  errorComponent: { render: () => h('div') },
  delay: 200,
  timeout: 3000,
})

const playlists = ref<PlaylistWithSongs[]>([])
const activePlaylistId = ref<number | null>(null)
const currentSongIndex = ref(-1)
const audioPlayer = ref<HTMLAudioElement | null>(null)
const isPlaying = ref(false)
const newPlaylistName = ref('')
const fileInputRef = ref<HTMLInputElement | null>(null)
const isAddingNewPlaylist = ref(false)
const editingPlaylistId = ref<number | null>(null)
const editingPlaylistName = ref('')
const hideSongInfo = ref(false)
const isHeaderCollapsed = ref(false)
const windowWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1024)
const windowHeight = ref(typeof window !== 'undefined' ? window.innerHeight : 768)
const criticalError = ref<string | null>(null)
const songAddError = ref<string | null>(null)
const openPlaylistId = ref<number | null>(null)

let songInfoHideTimer: number | null = null
let isLoadingPlaylists = false
let touchStartY = 0
let touchStartTime = 0
let isScrolling = false
let hideDelayTimer: number | null = null

const playlistService = new PlaylistService()
let playbackService: PlaybackService
const activeSongs = computed(() => {
  if (!activePlaylistId.value) return []
  const activePlaylist = playlists.value.find((p) => p.id === activePlaylistId.value)
  return activePlaylist ? activePlaylist.songs : []
})

const currentSong = computed(() => {
  return currentSongIndex.value > -1 && activeSongs.value[currentSongIndex.value]
    ? activeSongs.value[currentSongIndex.value]
    : null
})

const isSmallScreen = computed(() => windowHeight.value <= 750 && windowWidth.value <= 450)
const isDesktop = computed(() => windowWidth.value > 768)

const observer = ref<IntersectionObserver | null>(null)
const loaderRefs = ref<Map<number, HTMLElement>>(new Map())

const setLoaderRef = (el: any, playlistId: number) => {
  if (el) {
    loaderRefs.value.set(playlistId, el)
    observer.value?.observe(el)
  } else {
    if (loaderRefs.value.has(playlistId)) {
      const oldEl = loaderRefs.value.get(playlistId)
      if (oldEl && observer.value) {
        observer.value.unobserve(oldEl)
      }
      loaderRefs.value.delete(playlistId)
    }
  }
}

onMounted(async () => {
  window.addEventListener('unhandledrejection', (event) => {
    console.warn('Unhandled rejection:', event.reason)
    event.preventDefault()
  })

  try {
    await loadInitialData()

    playbackService = new PlaybackService(isPlaying, currentSongIndex, activeSongs)
    audioPlayer.value = playbackService.initialize()

    const handleResize = () => {
      windowWidth.value = window.innerWidth
      windowHeight.value = window.innerHeight
    }
    window.addEventListener('resize', handleResize)
    ;(window as any).__resizeHandler = handleResize

    observer.value = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const playlistId = parseInt(entry.target.getAttribute('data-playlist-id') || '0', 10)
            if (playlistId) {
              loadMoreSongs(playlistId)
            }
          }
        })
      },
      {
        root: null, // Use the viewport as the root
        threshold: 0.1,
      },
    )
  } catch (error: any) {
    criticalError.value =
      error.message || 'Ocorreu um erro inesperado ao inicializar o player.'
    audioPlayer.value = new Audio()
  }
})

onUnmounted(() => {
  clearSongInfoTimer()
  if (playbackService) {
    playbackService.cleanup()
  }
  const handleResize = (window as any).__resizeHandler
  if (handleResize) {
    window.removeEventListener('resize', handleResize)
  }
  if (observer.value) {
    observer.value.disconnect()
  }
})

async function loadInitialData() {
  if (isLoadingPlaylists) return

  isLoadingPlaylists = true
  criticalError.value = null

  try {
    const loadedPlaylists = await playlistService.loadPlaylists()
    playlists.value = loadedPlaylists.map((p) => ({
      ...p,
      songs: [],
      offset: 0,
      allSongsLoaded: false,
      isLoadingMore: false,
    }))

    if (playlists.value.length > 0) {
      const firstPlaylistId = playlists.value[0].id!
      activePlaylistId.value = firstPlaylistId
      openPlaylistId.value = firstPlaylistId
      await loadMoreSongs(firstPlaylistId)
    }
  } catch (error: any) {
    criticalError.value = error.message || 'Falha ao carregar playlists.'
    throw error
  } finally {
    isLoadingPlaylists = false
  }
}

async function loadMoreSongs(playlistId: number) {
  const playlist = playlists.value.find((p) => p.id === playlistId)
  if (!playlist || playlist.isLoadingMore || playlist.allSongsLoaded) return

  playlist.isLoadingMore = true
  try {
    const newSongs = await playlistService.getSongsForPlaylist(playlistId, 5, playlist.offset)
    playlist.songs.push(...newSongs)
    playlist.offset += newSongs.length
    if (newSongs.length < 5) {
      playlist.allSongsLoaded = true
    }
  } catch (error) {
    console.error(`Falha ao carregar mais músicas para a playlist ${playlistId}.`, error)
  } finally {
    playlist.isLoadingMore = false
  }
}

async function resetAndLoadSongs(playlistId: number) {
  const playlist = playlists.value.find((p) => p.id === playlistId)
  if (playlist) {
    playlist.songs = []
    playlist.offset = 0
    playlist.allSongsLoaded = false
    await loadMoreSongs(playlistId)
  }
}

function playSong(index: number, playlistId: number) {
  if (activePlaylistId.value !== playlistId) {
    activePlaylistId.value = playlistId
  }
  showSongInfoImmediately()
  playbackService.playSong(index)
}

async function togglePlaylist(playlistId: number) {
  const isAlreadyOpen = openPlaylistId.value === playlistId

  if (isAlreadyOpen) {
    openPlaylistId.value = null
  } else {
    openPlaylistId.value = playlistId
    const playlist = playlists.value.find((p) => p.id === playlistId)
    if (playlist && playlist.offset === 0) {
      await loadMoreSongs(playlistId)
    }
  }
}

function togglePlayPause() {
  playbackService.togglePlayPause()
}

function nextTrack() {
  playbackService.nextTrack()
}

function prevTrack() {
  playbackService.prevTrack()
}

async function loadPlaylists() {
  try {
    const loadedPlaylists = await playlistService.loadPlaylists()
    const newPlaylists = loadedPlaylists.map((p) => {
      const existingPlaylist = playlists.value.find((ep) => ep.id === p.id)
      if (existingPlaylist) {
        return existingPlaylist // Preserve state if playlist already exists
      }
      return {
        ...p,
        songs: [],
        offset: 0,
        allSongsLoaded: false,
        isLoadingMore: false,
      }
    })
    playlists.value = newPlaylists
  } catch (error) {
    console.error('Falha ao recarregar as playlists.', error)
  }
}

async function addPlaylist() {
  if (newPlaylistName.value.trim()) {
    await playlistService.addPlaylist(newPlaylistName.value)
    newPlaylistName.value = ''
    isAddingNewPlaylist.value = false
    await loadPlaylists()
    // Open the new playlist
    const newPlaylist = playlists.value[playlists.value.length - 1]
    if (newPlaylist && newPlaylist.id !== undefined) {
      openPlaylistId.value = newPlaylist.id
    }
  }
}

function handleNewPlaylistBlur() {
  setTimeout(() => {
    if (newPlaylistName.value.trim() === '') {
      isAddingNewPlaylist.value = false
    }
  }, 200)
}

function triggerFileInput(playlistId: number) {
  activePlaylistId.value = playlistId
  fileInputRef.value?.click()
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

async function handleFileSelection(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files || input.files.length === 0 || !activePlaylistId.value) return

  const file = input.files[0]
  if (!file.type.startsWith('audio/')) {
    songAddError.value = 'Por favor, selecione um arquivo de áudio válido.'
    input.value = ''
    return
  }

  try {
    songAddError.value = null
    const base64Data = await blobToBase64(file)

    const newSong: Omit<Song, 'id'> = {
      playlistId: activePlaylistId.value,
      title: file.name.split('.').slice(0, -1).join('.') || 'Música desconhecida',
      artist: 'Artista Desconhecido',
      year: new Date().getFullYear().toString(),
      img: 'musica.png',
      data: base64Data,
    }

    await playlistService.addSong(newSong)
    await resetAndLoadSongs(activePlaylistId.value)
  } catch (error: any) {
    songAddError.value = error.message || 'Erro desconhecido ao adicionar música.'
  }
  input.value = ''
}

async function deleteSong(songId: number, playlistId: number) {
  if (currentSong.value?.id === songId) {
    nextTrack()
  }

  await playlistService.deleteSong(songId)
  await resetAndLoadSongs(playlistId)
}

async function deletePlaylist(playlistId: number) {
  if (window.confirm('Tem certeza que deseja apagar esta playlist e todas as suas músicas?')) {
    await playlistService.deletePlaylist(playlistId)
    await loadPlaylists()
  }
}

function startEditingPlaylist(playlist: PlaylistWithSongs) {
  editingPlaylistId.value = playlist.id!
  editingPlaylistName.value = playlist.name
}

function cancelEditingPlaylist() {
  editingPlaylistId.value = null
  editingPlaylistName.value = ''
}

async function savePlaylistName(playlistId: number) {
  try {
    const newName = editingPlaylistName.value.trim()

    if (!newName) {
      cancelEditingPlaylist()
      return
    }

    const playlist = playlists.value.find((p) => p.id === playlistId)
    if (!playlist) {
      cancelEditingPlaylist()
      return
    }

    const success = await playlistService.updatePlaylistName(playlistId, newName)
    if (success) {
      playlist.name = newName
    }
  } catch (error: any) {
    alert(error.message || 'Erro ao salvar nome da playlist.')
  }

  cancelEditingPlaylist()
}

function handlePlaylistTouchStart(event: TouchEvent | MouseEvent) {
  if (!isSmallScreen.value) return

  // Don't track for buttons, inputs, or interactive elements
  const target = event.target as HTMLElement
  if (
    target.closest('button') ||
    target.closest('input') ||
    target.closest('.add-playlist-trigger')
  ) {
    return
  }

  if (event instanceof TouchEvent && event.touches.length > 0) {
    touchStartY = event.touches[0].clientY
    touchStartTime = Date.now()
    isScrolling = false
  }

  clearHideDelayTimer()
  clearSongInfoTimer()
}

function handlePlaylistTouchMove(event: TouchEvent | MouseEvent) {
  if (!isSmallScreen.value) return

  if (event instanceof TouchEvent && event.touches.length > 0) {
    const touchCurrentY = event.touches[0].clientY
    const deltaY = Math.abs(touchCurrentY - touchStartY)

    // If moved more than 10px, consider it scrolling
    if (deltaY > 10 && !isScrolling) {
      isScrolling = true
      // Add delay before hiding for smoother UX
      hideDelayTimer = setTimeout(() => {
        hideSongInfo.value = true
      }, 150)
    }
  }
}

function handlePlaylistTouchEnd(event: TouchEvent | MouseEvent) {
  if (!isSmallScreen.value) return

  const target = event.target as HTMLElement
  if (
    target.closest('button') ||
    target.closest('input') ||
    target.closest('.add-playlist-trigger')
  ) {
    return
  }

  clearHideDelayTimer()

  // Always reset scrolling state and show info after delay
  if (isScrolling) {
    startSongInfoTimer()
    isScrolling = false
  }
}

function clearHideDelayTimer() {
  if (hideDelayTimer) {
    clearTimeout(hideDelayTimer)
    hideDelayTimer = null
  }
}

function startSongInfoTimer() {
  clearSongInfoTimer()
  songInfoHideTimer = setTimeout(() => {
    hideSongInfo.value = false
  }, 2000)
}

function clearSongInfoTimer() {
  if (songInfoHideTimer) {
    clearTimeout(songInfoHideTimer)
    songInfoHideTimer = null
  }
}

function showSongInfoImmediately() {
  clearSongInfoTimer()
  hideSongInfo.value = false
}

function toggleHeaderCollapse() {
  isHeaderCollapsed.value = !isHeaderCollapsed.value
}
</script>

<template>
  <div id="app-container">
    <div v-if="criticalError" class="critical-error-banner">
      <h2>Erro Crítico</h2>
      <p>{{ criticalError }}</p>
      <p>
        Isto pode acontecer se o navegador estiver em modo privado ou com restrições de
        armazenamento. Por favor, recarregue a página em uma janela normal.
      </p>
    </div>

    <template v-else>
      <div class="player-main">
        <!-- Collapse toggle button for mobile -->
        <button
          v-if="isSmallScreen"
          @click="toggleHeaderCollapse"
          class="collapse-toggle"
          :title="isHeaderCollapsed ? 'Mostrar informações' : 'Ocultar informações'"
        >
          {{ isHeaderCollapsed ? '∨' : '∧' }}
        </button>

        <h1 v-show="(!hideSongInfo || !isSmallScreen) && !isHeaderCollapsed" class="fade-element">
          Player de Música Offline
        </h1>
        <p
          class="subtitle fade-element"
          v-show="(!hideSongInfo || !isSmallScreen) && !isHeaderCollapsed"
        >
          Adicione músicas do seu computador e elas ficarão salvas para a sua próxima visita.
        </p>

        <!-- Show visualizer only on desktop when music is playing -->
        <div v-if="isDesktop && currentSong" class="visualizer-container">
          <AudioVisualizer :audio-element="audioPlayer" :is-playing="isPlaying" />
        </div>

        <div
          class="song-info fade-element"
          v-show="(!hideSongInfo || !isSmallScreen) && !isHeaderCollapsed"
        >
          <h2>{{ currentSong?.title || 'Nenhuma música tocando' }}</h2>
          <p>{{ currentSong?.artist }}</p>
        </div>

        <div class="controls">
          <button @click="prevTrack" title="Anterior">⏪</button>
          <button
            @click="togglePlayPause"
            class="play-pause-btn"
            :title="isPlaying ? 'Pausar' : 'Tocar'"
          >
            {{ isPlaying ? '⏸️' : '▶️' }}
          </button>
          <button @click="nextTrack" title="Próxima">⏩</button>
        </div>
      </div>

      <div
        class="playlist-view"
        @touchstart="handlePlaylistTouchStart"
        @touchmove="handlePlaylistTouchMove"
        @touchend="handlePlaylistTouchEnd"
        @mousedown="handlePlaylistTouchStart"
        @mouseup="handlePlaylistTouchEnd"
      >
        <!-- New Playlist Form -->
        <div class="new-playlist-controls">
          <span
            v-if="!isAddingNewPlaylist"
            @click="isAddingNewPlaylist = true"
            class="add-playlist-trigger"
          >
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
            />
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
          <div class="playlist-header" @click="togglePlaylist(playlist.id!)">
            <!-- Playlist name display/edit -->
            <div v-if="editingPlaylistId !== playlist.id" class="playlist-name-display">
              <h2 class="editable-playlist-name">
                <span class="playlist-toggle-icon">{{
                  openPlaylistId === playlist.id ? '▾' : '▸'
                }}</span>
                <span @click.stop="startEditingPlaylist(playlist)"
                title="Clique para editar o nome">{{ playlist.name }}</span>
              </h2>
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
              />
              <button
                @click.stop="savePlaylistName(playlist.id!)"
                class="save-playlist-btn"
                title="Salvar"
              >
                ✓
              </button>
              <button
                @click.stop="cancelEditingPlaylist()"
                class="cancel-playlist-btn"
                title="Cancelar"
              >
                ✕
              </button>
            </div>

            <div class="playlist-actions">
              <button @click.stop="triggerFileInput(playlist.id!)" class="add-songs-btn">
                + Adicionar Músicas
              </button>
              <button @click.stop="deletePlaylist(playlist.id!)" class="delete-playlist-btn">
                🗑️
              </button>
            </div>
          </div>

          <ul class="song-list" v-show="openPlaylistId === playlist.id">
            <li v-if="playlist.songs.length === 0 && playlist.allSongsLoaded" class="empty-playlist">
              Esta playlist está vazia. Adicione algumas músicas para começar.
            </li>
            <li
              v-for="(song, index) in playlist.songs"
              :key="song.id"
              @click.stop="playSong(index, playlist.id!)"
              :class="{ active: currentSong?.id === song.id }"
            >
              <div class="song-details">
                <span class="song-title">{{ song.title }}</span>
                <span class="song-artist">{{ song.artist }}</span>
              </div>
              <button @click.stop="deleteSong(song.id!, playlist.id!)" class="delete-song-btn">
                (x)
              </button>
            </li>
            <li
              v-if="!playlist.allSongsLoaded && openPlaylistId === playlist.id"
              :ref="(el) => setLoaderRef(el, playlist.id!)"
              :data-playlist-id="playlist.id"
              class="loader-container"
            >
              <span v-if="playlist.isLoadingMore">Carregando...</span>
            </li>
          </ul>
        </div>

        <!-- Song Add Error Span -->
        <div v-if="songAddError" class="song-add-error">
          <span>{{ songAddError }}</span>
          <button @click="songAddError = null" class="close-error-btn">✕</button>
        </div>
      </div>
    </template>
  </div>
</template>
