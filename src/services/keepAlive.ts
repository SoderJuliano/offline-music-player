/**
 * KeepAliveService
 * 
 * Mantém a aplicação ativa em segundo plano durante transferências P2P no mobile (iOS / Android) e Desktop.
 * Utiliza:
 * 1. Reprodução em loop de áudio silencioso via HTML5 <audio> (impede que o iOS/Android congelem timers e sockets em background).
 * 2. Screen Wake Lock API para evitar bloqueio da tela enquanto em primeiro plano.
 * 3. Recuperação automática de Wake Lock no evento visibilitychange.
 * 4. Web Notifications para alertar o usuário quando uma transferência terminar em segundo plano.
 */

class KeepAliveService {
  private wakeLock: any = null;
  private silentAudio: HTMLAudioElement | null = null;
  private silentAudioUrl: string | null = null;
  private activeCount: number = 0;
  private visibilityListenerAttached: boolean = false;
  private foregroundCallbacks: Set<() => void> = new Set();

  constructor() {
    this.initVisibilityListener();
  }

  /**
   * Gera um Blob WAV de 1 segundo de silêncio (PCM 8kHz 8-bit mono).
   * 100% nativo, sem requisição de rede ou dependências externas.
   */
  private createSilentWavBlob(): Blob {
    const sampleRate = 8000;
    const numSamples = 8000;
    const buffer = new ArrayBuffer(44 + numSamples);
    const view = new DataView(buffer);

    // RIFF identifier
    view.setUint32(0, 0x52494646, false); // "RIFF"
    view.setUint32(4, 36 + numSamples, true);
    view.setUint32(8, 0x57415645, false); // "WAVE"

    // fmt subchunk
    view.setUint32(12, 0x666d7420, false); // "fmt "
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
    view.setUint16(22, 1, true); // NumChannels (1 for mono)
    view.setUint32(24, sampleRate, true); // SampleRate
    view.setUint32(28, sampleRate, true); // ByteRate (sampleRate * numChannels * bitsPerSample/8)
    view.setUint16(32, 1, true); // BlockAlign (numChannels * bitsPerSample/8)
    view.setUint16(34, 8, true); // BitsPerSample (8 bits)

    // data subchunk
    view.setUint32(36, 0x64617461, false); // "data"
    view.setUint32(40, numSamples, true);

    // Fill with silence (128 is center for 8-bit unsigned PCM)
    const u8 = new Uint8Array(buffer, 44);
    u8.fill(128);

    return new Blob([buffer], { type: 'audio/wav' });
  }

  private ensureSilentAudio(): HTMLAudioElement {
    if (!this.silentAudio) {
      const blob = this.createSilentWavBlob();
      this.silentAudioUrl = URL.createObjectURL(blob);
      this.silentAudio = new Audio(this.silentAudioUrl);
      this.silentAudio.loop = true;
      this.silentAudio.volume = 0.001; // Inaudível, mas detectável pelo OS para background
      (this.silentAudio as any).playsInline = true;
      this.silentAudio.setAttribute('playsinline', 'true');
      this.silentAudio.setAttribute('webkit-playsinline', 'true');
      this.silentAudio.preload = 'auto';
    }
    return this.silentAudio;
  }

  private initVisibilityListener() {
    if (typeof document === 'undefined' || this.visibilityListenerAttached) return;
    this.visibilityListenerAttached = true;

    document.addEventListener('visibilitychange', async () => {
      const isVisible = document.visibilityState === 'visible';
      console.log(`[KeepAlive] 📱 Document visibility changed: ${document.visibilityState}`);

      if (isVisible) {
        // Quando a aba volta para primeiro plano, re-adquire o Wake Lock se ainda houver tarefas ativas
        if (this.activeCount > 0) {
          await this.acquireWakeLock();
        }
        // Dispara callbacks de retorno para o primeiro plano (ex: verificar conexão / ping)
        this.foregroundCallbacks.forEach(cb => {
          try { cb(); } catch (e) { console.warn('[KeepAlive] Error in foreground callback:', e); }
        });
      }
    });
  }

  public onForeground(callback: () => void): () => void {
    this.foregroundCallbacks.add(callback);
    return () => this.foregroundCallbacks.delete(callback);
  }

  private async acquireWakeLock(): Promise<void> {
    if (typeof navigator !== 'undefined' && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      try {
        if (!this.wakeLock) {
          this.wakeLock = await (navigator as any).wakeLock.request('screen');
          console.log('[KeepAlive] 💡 Screen Wake Lock acquired');
          this.wakeLock.addEventListener('release', () => {
            console.log('[KeepAlive] 😴 Screen Wake Lock released by system');
            this.wakeLock = null;
          });
        }
      } catch (err: any) {
        console.warn(`[KeepAlive] Wake Lock request error: ${err?.name || err}`);
      }
    }
  }

  private releaseWakeLock(): void {
    if (this.wakeLock) {
      try {
        this.wakeLock.release();
      } catch (e) {
        console.warn('[KeepAlive] Error releasing Wake Lock:', e);
      }
      this.wakeLock = null;
      console.log('[KeepAlive] 😴 Screen Wake Lock explicitly released');
    }
  }

  /**
   * Inicia o modo KeepAlive para transferência em background.
   */
  public async startKeepAlive(reason = 'transfer'): Promise<void> {
    this.activeCount++;
    console.log(`[KeepAlive] 🚀 Starting keepalive (active count: ${this.activeCount}, reason: ${reason})`);

    // 1. Screen Wake Lock
    await this.acquireWakeLock();

    // 2. Silent background audio loop
    try {
      const audio = this.ensureSilentAudio();
      if (audio.paused) {
        const playPromise = audio.play();
        if (playPromise !== undefined) {
          playPromise.catch((err) => {
            console.warn('[KeepAlive] Silent audio playback auto-play notice:', err?.message || err);
          });
        }
        console.log('[KeepAlive] 🎵 Silent background audio loop started');
      }
    } catch (e) {
      console.warn('[KeepAlive] Could not start silent audio:', e);
    }
  }

  /**
   * Finaliza ou decrementa o modo KeepAlive.
   */
  public stopKeepAlive(reason = 'transfer'): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    console.log(`[KeepAlive] 🛑 Stopping keepalive (remaining count: ${this.activeCount}, reason: ${reason})`);

    if (this.activeCount === 0) {
      this.releaseWakeLock();

      if (this.silentAudio && !this.silentAudio.paused) {
        try {
          this.silentAudio.pause();
          this.silentAudio.currentTime = 0;
          console.log('[KeepAlive] 🔇 Silent background audio paused');
        } catch (e) {
          console.warn('[KeepAlive] Error pausing silent audio:', e);
        }
      }
    }
  }

  /**
   * Solicita permissão para notificações do navegador.
   */
  public async requestNotificationPermission(): Promise<boolean> {
    if (typeof window === 'undefined' || !('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission !== 'denied') {
      try {
        const permission = await Notification.requestPermission();
        return permission === 'granted';
      } catch (e) {
        console.warn('[KeepAlive] Notification permission request error:', e);
      }
    }
    return false;
  }

  /**
   * Dispara uma notificação nativa ao usuário caso o app esteja em segundo plano.
   */
  public showNotification(title: string, options?: NotificationOptions): void {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      try {
        new Notification(title, {
          icon: '/favicon.ico',
          badge: '/favicon.ico',
          ...options,
        });
      } catch (e) {
        console.warn('[KeepAlive] Could not display notification:', e);
      }
    }
  }

  public isKeepAliveActive(): boolean {
    return this.activeCount > 0;
  }
}

export const keepAliveService = new KeepAliveService();
