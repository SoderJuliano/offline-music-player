<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, defineAsyncComponent, h, watch } from 'vue'
import { type Song } from '../services/db'
import { PlaylistService, type PlaylistWithSongs } from '../services/playlist'
import { PlaybackService } from '../services/playback'
import '../styles/App.css'

const AudioVisualizer = defineAsyncComponent({
  loader: () => import('../components/AudioVisualizer.vue'),
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

// PWA Install
const showInstallButton = ref(false)
const showIOSInstallModal = ref(false)
let deferredPrompt: any = null
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent)
const isInStandaloneMode = typeof window !== 'undefined' &&
  ((window.navigator as any).standalone === true || window.matchMedia('(display-mode: standalone)').matches)

let songInfoHideTimer: number | null = null
let isLoadingPlaylists = false
let touchStartY = 0
let touchStartTime = 0
let isScrolling = false
let hideDelayTimer: ReturnType<typeof setTimeout> | null = null

const playlistService = new PlaylistService()
let playbackService: PlaybackService
let isPrefetchingMore = false
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

const installPWA = () => {
  console.log('installPWA called, deferredPrompt:', deferredPrompt)
  if (deferredPrompt) {
    console.log('Calling prompt()')
    deferredPrompt.prompt()
    deferredPrompt.userChoice.then((choiceResult: any) => {
      console.log('User choice result:', choiceResult)
      if (choiceResult.outcome === 'accepted') {
        console.log('User accepted the install prompt')
      } else {
        console.log('User dismissed the install prompt')
      }
      deferredPrompt = null
      showInstallButton.value = false
    })
  } else if (isIOS) {
    showIOSInstallModal.value = true
  } else {
    console.log('No deferredPrompt available')
    alert('Use o menu do navegador:\n\n• Chrome: ⋮ > "Adicionar à tela inicial"\n• Firefox: ⋮ > "Instalar este site como app"')
    showInstallButton.value = false
  }
}

onMounted(async () => {
  window.addEventListener('unhandledrejection', (event) => {
    console.warn('Unhandled rejection:', event.reason)
    event.preventDefault()
  })

  // iOS não dispara beforeinstallprompt — detectar manualmente
  if (isIOS && !isInStandaloneMode) {
    showInstallButton.value = true
  }

  // PWA Install prompt (Android/Desktop)
  window.addEventListener('beforeinstallprompt', (e) => {
    console.log('beforeinstallprompt event fired', e)
    console.log('Manifest loaded successfully')
    e.preventDefault()
    deferredPrompt = e
    showInstallButton.value = true
  })

  // Verificar se manifest foi carregado
  if ('manifest' in document) {
    console.log('Manifest link found in document')
  } else {
    console.log('Manifest link not found')
  }

  // Quando o app for instalado, esconder o botão
  window.addEventListener('appinstalled', () => {
    console.log('PWA was installed')
    showInstallButton.value = false
    deferredPrompt = null
  })

  try {
    await loadInitialData()

    playbackService = new PlaybackService(isPlaying, currentSongIndex, activeSongs, ensureMoreSongsForPlayback)
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
    const playlistSizes = await Promise.all(
      loadedPlaylists.map((p) => (p.id ? playlistService.getPlaylistSize(p.id) : Promise.resolve(0))),
    )
    playlists.value = loadedPlaylists.map((p, index) => ({
      ...p,
      songs: [],
      offset: 0,
      allSongsLoaded: false,
      isLoadingMore: false,
      totalSongsCount: playlistSizes[index] || 0,
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
    if (playlist.totalSongsCount === 0) {
      playlist.totalSongsCount = await playlistService.getPlaylistSize(playlistId)
    }
    const newSongs = await playlistService.getSongsForPlaylist(playlistId, 5, playlist.offset)
    playlist.songs.push(...newSongs)
    playlist.offset += newSongs.length
    if (playlist.offset >= playlist.totalSongsCount || newSongs.length < 5) {
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
    playlist.totalSongsCount = await playlistService.getPlaylistSize(playlistId)
    await loadMoreSongs(playlistId)
  }
}

async function ensureMoreSongsForPlayback() {
  const playlistId = activePlaylistId.value
  if (!playlistId) return

  const playlist = playlists.value.find((p) => p.id === playlistId)
  if (!playlist) return

  const nextIndex = currentSongIndex.value + 1
  if (nextIndex < playlist.songs.length) return

  if (playlist.totalSongsCount === 0) {
    playlist.totalSongsCount = await playlistService.getPlaylistSize(playlistId)
  }

  if (playlist.songs.length < playlist.totalSongsCount) {
    await loadMoreSongs(playlistId)
  }
}

async function prefetchMoreSongsIfNeeded() {
  const playlistId = activePlaylistId.value
  if (!playlistId) return

  const playlist = playlists.value.find((p) => p.id === playlistId)
  if (!playlist || playlist.isLoadingMore || playlist.allSongsLoaded || isPrefetchingMore) return

  if (playlist.totalSongsCount === 0) {
    playlist.totalSongsCount = await playlistService.getPlaylistSize(playlistId)
  }

  const remaining = playlist.songs.length - (currentSongIndex.value + 1)
  if (playlist.songs.length < playlist.totalSongsCount && remaining <= 1) {
    isPrefetchingMore = true
    try {
      await loadMoreSongs(playlistId)
    } finally {
      isPrefetchingMore = false
    }
  }
}

watch(
  () => currentSongIndex.value,
  () => {
    void prefetchMoreSongsIfNeeded()
  },
)

function playSong(index: number, playlistId: number) {
  if (activePlaylistId.value !== playlistId) {
    activePlaylistId.value = playlistId
  }
  showSongInfoImmediately()
  playbackService.playSong(index)
  void prefetchMoreSongsIfNeeded()
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
  void playbackService.nextTrack()
}

function prevTrack() {
  playbackService.prevTrack()
}

async function loadPlaylists() {
  try {
    const loadedPlaylists = await playlistService.loadPlaylists()
    const playlistSizes = await Promise.all(
      loadedPlaylists.map((p) => (p.id ? playlistService.getPlaylistSize(p.id) : Promise.resolve(0))),
    )
    const newPlaylists = loadedPlaylists.map((p, index) => {
      const existingPlaylist = playlists.value.find((ep) => ep.id === p.id)
      if (existingPlaylist) {
        existingPlaylist.totalSongsCount = playlistSizes[index] || existingPlaylist.totalSongsCount
        return existingPlaylist // Preserve state if playlist already exists
      }
      return {
        ...p,
        songs: [],
        offset: 0,
        allSongsLoaded: false,
        isLoadingMore: false,
        totalSongsCount: playlistSizes[index] || 0,
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

  const files = Array.from(input.files)
  const isAudioFile = (file: File) => {
    if (file.type && file.type.startsWith('audio/')) return true
    const name = file.name.toLowerCase()
    return name.endsWith('.mp3') || name.endsWith('.wav') || name.endsWith('.m4a') || name.endsWith('.aac') || name.endsWith('.ogg') || name.endsWith('.flac')
  }

  const invalidFiles = files.filter((f) => !isAudioFile(f))
  if (invalidFiles.length > 0) {
    songAddError.value = 'Por favor, selecione apenas arquivos de áudio válidos.'
    input.value = ''
    return
  }

  // Preserve current song
  const wasPlaying = isPlaying.value
  const currentSongId = currentSong.value?.id

  try {
    songAddError.value = null
    for (const file of files) {
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
    }
    await resetAndLoadSongs(activePlaylistId.value)

    // Restore playback state
    if (currentSongId) {
      const newIndex = activeSongs.value.findIndex((s) => s.id === currentSongId)
      if (newIndex > -1) {
        currentSongIndex.value = newIndex
        if (wasPlaying && audioPlayer.value) {
          // If it was playing, resume it. The src is already set.
          if (audioPlayer.value.paused) {
            audioPlayer.value.play()
          }
        }
      } else {
        // If the old song is gone for some reason, stop playback
        playbackService.stop()
      }
    }
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
let songInfoHideTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
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

// Custom confirm modal for deleting playlists (more reliable than window.confirm on mobile)
const confirmDeletePlaylistId = ref<number | null>(null)
const confirmDeletePlaylistName = ref<string>('')

function promptDeletePlaylist(playlistId: number) {
  const pl = playlists.value.find((p) => p.id === playlistId)
  confirmDeletePlaylistId.value = playlistId
  confirmDeletePlaylistName.value = pl?.name || ''
}

async function confirmDeletePlaylist() {
  const id = confirmDeletePlaylistId.value
  if (!id) return
  await playlistService.deletePlaylist(id)
  await loadPlaylists()
  confirmDeletePlaylistId.value = null
  confirmDeletePlaylistName.value = ''
}

function cancelDeletePlaylist() {
  confirmDeletePlaylistId.value = null
  confirmDeletePlaylistName.value = ''
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
        <!-- P2P Menu Button -->
        <router-link to="/mapa" class="p2p-menu-btn" title="Compartilhar P2P">
          🗺️
        </router-link>

        <!-- Install PWA Button -->
        <button
          v-if="showInstallButton"
          @click="installPWA"
          class="install-menu-btn"
          title="Instalar App"
        >
          📱
        </button>

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
          Player
        </h1>
        <p
          class="subtitle fade-element"
          v-show="(!hideSongInfo || !isSmallScreen) && !isHeaderCollapsed"
        >
          Adicione músicas do seu computador e elas ficarão salvas para a sua próxima visita.
        </p>

        <!-- 
          Show visualizer only on desktop. 
          It is always rendered (not using v-show or conditional currentSong) to prevent the component
          from being destroyed and re-created, which causes a fatal audio context error.
        -->
        <div v-if="isDesktop" class="visualizer-container">
          <AudioVisualizer :audio-element="audioPlayer" :is-playing="isPlaying" />
        </div>

        <div
          class="song-info fade-element"
          v-show="(!hideSongInfo || !isSmallScreen) && !isHeaderCollapsed"
        >
          <h2>{{ currentSong?.title || 'Nenhuma música tocando' }}</h2>
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
          accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac"
          multiple
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
              <button @click.stop="promptDeletePlaylist(playlist.id!)" class="delete-playlist-btn" title="Remover playlist">✕</button>
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
                <div style="display: flex;">
                  <img v-if="currentSong?.id === song.id && isPlaying" src="../assets/onda-de-audio.apng" alt="Playing" class="playing-gif" />
                  <div>
                    <span class="song-title">
                    {{ song.title }}
                    </span>
                    <p v-if="currentSong?.id !== song.id" class="song-artist">{{ song.artist }}</p>
                  </div>
                </div>
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
    <!-- iOS Install Modal -->
    <div v-if="showIOSInstallModal" class="confirm-delete-overlay" @click.self="showIOSInstallModal = false">
      <div class="confirm-delete-card" style="max-width:320px;text-align:center;">
        <div style="font-size:2em;margin-bottom:8px;">📲</div>
        <h3 style="margin:0 0 12px 0;">Instalar no iPhone</h3>
        <p style="margin:0 0 4px 0;font-size:13px;color:#888;font-weight:600;">Safari:</p>
        <p style="margin:0 0 8px 0;font-size:13px;">Toque em <strong>Compartilhar ↑</strong> → <strong>"Adicionar à Tela de Início"</strong></p>
        <p style="margin:0 0 4px 0;font-size:13px;color:#888;font-weight:600;">Brave:</p>
        <p style="margin:0 0 16px 0;font-size:13px;">Toque em <strong>≡</strong> (menu inferior direito) → <strong>"Add to Home Screen"</strong></p>
        <div class="confirm-delete-actions">
          <button @click="showIOSInstallModal = false" class="confirm-btn">Entendi!</button>
        </div>
      </div>
    </div>

    <!-- Confirm Delete Modal -->
    <div v-if="confirmDeletePlaylistId !== null" class="confirm-delete-overlay">
      <div class="confirm-delete-card">
        <h3 style="margin:0 0 8px 0;">Remover playlist</h3>
        <p style="margin:0;">Tem certeza que deseja remover a playlist
          <strong>{{ confirmDeletePlaylistName || 'esta playlist' }}</strong>?
        </p>
        <div class="confirm-delete-actions">
          <button @click="confirmDeletePlaylist" class="confirm-btn">Remover</button>
          <button @click="cancelDeletePlaylist" class="cancel-btn">Cancelar</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
.playlist-actions {
  display: inline-flex;
  gap: 8px;
}

/* Desktop: add spacing so delete ✕ and add-songs are not on top of each other */
@media (min-width: 768px) {
  .playlist-actions {
    margin-right: 42px; /* room for top-right ✕ */
  }
}

.playlist-header {
  position: relative;
}
.delete-playlist-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 12px;
  cursor: pointer;
  font-size: 14px;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.delete-playlist-btn:hover {
  background: rgba(255, 80, 80, 0.2);
  border-color: rgba(255, 80, 80, 0.5);
}
.confirm-delete-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.confirm-delete-card {
  background: #1e1e1e;
  color: #fff;
  padding: 18px 20px;
  border-radius: 10px;
  width: 90%;
  max-width: 360px;
  box-shadow: 0 6px 24px rgba(0,0,0,0.4);
}
.confirm-delete-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 16px;
}
.confirm-btn {
  background: #ef4444;
  border: none;
  color: #fff;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
}
.cancel-btn {
  background: rgba(255,255,255,0.1);
  border: 1px solid rgba(255,255,255,0.2);
  color: #fff;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
}
</style>