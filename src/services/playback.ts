import { type Ref } from 'vue'
import type { Song } from './db'

export class PlaybackService {
  private audioPlayer: HTMLAudioElement | null = null
  private isPlaying: Ref<boolean>
  private currentSongIndex: Ref<number>
  private activeSongs: Ref<Song[]>
  private onNeedMoreSongs?: () => Promise<void>

  constructor(
    isPlaying: Ref<boolean>,
    currentSongIndex: Ref<number>,
    activeSongs: Ref<Song[]>,
    onNeedMoreSongs?: () => Promise<void>,
  ) {
    this.isPlaying = isPlaying
    this.currentSongIndex = currentSongIndex
    this.activeSongs = activeSongs
    this.onNeedMoreSongs = onNeedMoreSongs
  }

  initialize(): HTMLAudioElement {
    this.audioPlayer = new Audio()
    this.audioPlayer.addEventListener('ended', () => void this.nextTrack())
    this.audioPlayer.addEventListener('play', () => {
      this.isPlaying.value = true
    })
    this.audioPlayer.addEventListener('pause', () => {
      this.isPlaying.value = false
    })

    // Media Session API integration
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => this.togglePlayPause())
      navigator.mediaSession.setActionHandler('pause', () => this.togglePlayPause())
      navigator.mediaSession.setActionHandler('nexttrack', () => void this.nextTrack())
      navigator.mediaSession.setActionHandler('previoustrack', () => this.prevTrack())
    }

    return this.audioPlayer
  }

  private currentObjectUrl: string | null = null

  playSong(index: number) {
    if (index < 0 || index >= this.activeSongs.value.length) return
    this.currentSongIndex.value = index

    const song = this.activeSongs.value[index]
    if (!song || !song.data) return

    // Revoke previous Object URL to free memory
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl)
      this.currentObjectUrl = null
    }

    if (this.audioPlayer) {
      if (song.data instanceof Blob) {
        this.currentObjectUrl = URL.createObjectURL(song.data)
        this.audioPlayer.src = this.currentObjectUrl
      } else {
        // Legacy Base64 support
        this.audioPlayer.src = song.data 
      }
      this.audioPlayer.play()
    }

    // Update Media Session API
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title,
        artist: song.artist,
        album: '',
        artwork: [{ src: song.img || 'musica.png', sizes: '512x512', type: 'image/png' }],
      })
    }
  }

  togglePlayPause() {
    if (!this.audioPlayer) return
    if (this.isPlaying.value) {
      this.audioPlayer.pause()
    } else {
      if (this.currentSongIndex.value > -1) {
        this.audioPlayer.play()
      } else if (this.activeSongs.value.length > 0) {
        this.playSong(0)
      }
    }
  }

  async nextTrack() {
    const nextIndex = this.currentSongIndex.value + 1
    if (nextIndex < this.activeSongs.value.length) {
      this.playSong(nextIndex)
    } else {
      if (this.onNeedMoreSongs) {
        await this.onNeedMoreSongs()
        if (nextIndex < this.activeSongs.value.length) {
          this.playSong(nextIndex)
          return
        }
      }
      if (this.activeSongs.value.length > 0) {
        this.playSong(0)
      } else {
        this.stop()
      }
    }
  }

  prevTrack() {
    const prevIndex = this.currentSongIndex.value - 1
    if (prevIndex >= 0) {
      this.playSong(prevIndex)
    } else if (this.activeSongs.value.length > 0) {
      this.playSong(this.activeSongs.value.length - 1)
    }
  }

  stop() {
    if (!this.audioPlayer) return
    this.audioPlayer.pause()
    this.audioPlayer.src = ''
    this.isPlaying.value = false
    this.currentSongIndex.value = -1

    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl)
      this.currentObjectUrl = null
    }
  }

  cleanup() {
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl)
      this.currentObjectUrl = null
    }
  }
}
