import { type Ref } from 'vue';
import type { Song } from './db';

export class PlaybackService {
  private audioPlayer: HTMLAudioElement | null = null;
  private currentObjectURL: string | null = null;
  private isPlaying: Ref<boolean>;
  private currentSongIndex: Ref<number>;
  private activeSongs: Ref<Song[]>;

  constructor(
    isPlaying: Ref<boolean>,
    currentSongIndex: Ref<number>,
    activeSongs: Ref<Song[]>
  ) {
    this.isPlaying = isPlaying;
    this.currentSongIndex = currentSongIndex;
    this.activeSongs = activeSongs;
  }

  initialize(): HTMLAudioElement {
    this.audioPlayer = new Audio();
    this.audioPlayer.addEventListener('ended', () => this.nextTrack());
    this.audioPlayer.addEventListener('play', () => {
      this.isPlaying.value = true;
    });
    this.audioPlayer.addEventListener('pause', () => {
      this.isPlaying.value = false;
    });
    return this.audioPlayer;
  }

  playSong(index: number) {
    if (index < 0 || index >= this.activeSongs.value.length) return;
    this.currentSongIndex.value = index;
    
    const song = this.activeSongs.value[index];
    if (!song) return;

    if (this.currentObjectURL) {
      URL.revokeObjectURL(this.currentObjectURL);
    }
    this.currentObjectURL = URL.createObjectURL(song.data);

    if (this.audioPlayer) {
      this.audioPlayer.src = this.currentObjectURL;
      this.audioPlayer.play();
    }
  }

  togglePlayPause() {
    if (!this.audioPlayer) return;
    if (this.isPlaying.value) {
      this.audioPlayer.pause();
    } else {
      if (this.currentSongIndex.value > -1) {
        this.audioPlayer.play();
      } else if (this.activeSongs.value.length > 0) {
        this.playSong(0);
      }
    }
  }

  nextTrack() {
    const nextIndex = this.currentSongIndex.value + 1;
    if (nextIndex < this.activeSongs.value.length) {
      this.playSong(nextIndex);
    } else {
      if (this.activeSongs.value.length > 0) {
        this.playSong(0);
      } else {
        this.stop();
      }
    }
  }

  prevTrack() {
    const prevIndex = this.currentSongIndex.value - 1;
    if (prevIndex >= 0) {
      this.playSong(prevIndex);
    }
  }

  stop() {
    this.isPlaying.value = false;
    this.currentSongIndex.value = -1;
    if (this.currentObjectURL) {
      URL.revokeObjectURL(this.currentObjectURL);
    }
    this.currentObjectURL = null;
    if (this.audioPlayer) {
      this.audioPlayer.src = '';
    }
  }

  cleanup() {
    if (this.currentObjectURL) {
      URL.revokeObjectURL(this.currentObjectURL);
    }
  }
}
