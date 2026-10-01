import { reactive, ref } from 'vue';
import { p2pService } from './p2p';
import { PlaylistService } from './playlist';
import { keepAliveService } from './keepAlive';
import type { Song } from './db';

export interface TransferProgress {
  active: boolean;
  transferId: string;
  playlistName: string;
  sourcePeerId: string;
  currentSongIndex: number;
  totalSongs: number;
  overallPercent: number;
  currentSongTitle: string;
  currentSongPercent: number;
  timeRemaining: string;
  startTime: number;
  newPlaylistId: number;
  status: 'idle' | 'transferring' | 'saving' | 'completed' | 'error';
  errorMessage?: string;
}

export interface OutgoingTransferProgress {
  active: boolean;
  transferId: string;
  targetPeerId: string;
  playlistName: string;
  currentSongIndex: number;
  totalSongs: number;
  overallPercent: number;
  currentSongTitle: string;
  status: 'idle' | 'transferring' | 'completed' | 'error';
}

interface SongBuffer {
  transferId: string;
  songIndex: number;
  totalChunks: number;
  chunks: (string | undefined)[];
  metadata: any;
  receivedCount: number;
  processed: boolean;
}

const CHUNK_SIZE = 16 * 1024; // 16KB per chunk for optimal WebRTC & Ably reliability

class TransferService {
  private playlistService = new PlaylistService();

  // Reactive state for Vue components (P2PView, PlayerView, etc.)
  public incoming = reactive<TransferProgress>({
    active: false,
    transferId: '',
    playlistName: '',
    sourcePeerId: '',
    currentSongIndex: 0,
    totalSongs: 0,
    overallPercent: 0,
    currentSongTitle: '',
    currentSongPercent: 0,
    timeRemaining: '',
    startTime: 0,
    newPlaylistId: 0,
    status: 'idle',
  });

  public outgoing = reactive<OutgoingTransferProgress>({
    active: false,
    transferId: '',
    targetPeerId: '',
    playlistName: '',
    currentSongIndex: 0,
    totalSongs: 0,
    overallPercent: 0,
    currentSongTitle: '',
    status: 'idle',
  });

  // Recent notifications / alerts
  public toastMessage = ref<{ text: string; type: 'success' | 'error' | 'info'; id: number } | null>(null);

  private songBuffers = new Map<string, SongBuffer>();
  private pendingAcks = new Map<string, (val: boolean) => void>();
  private pendingMissingRequests = new Map<string, (missing: number[]) => void>();
  private staleInterval: any = null;
  private heartbeatInterval: any = null;
  private lastActivityTimestamp = 0;
  private cancelOutgoingFlag = false;

  constructor() {
    // Listen for foreground returns to resume / ping connection
    keepAliveService.onForeground(() => {
      if (this.incoming.active && this.incoming.sourcePeerId) {
        console.log('[Transfer] App returned to foreground, pinging peer:', this.incoming.sourcePeerId);
        p2pService.sendTo(this.incoming.sourcePeerId, {
          type: 'transfer-ping',
          payload: { transferId: this.incoming.transferId }
        });
      }
    });
  }

  public showToast(text: string, type: 'success' | 'error' | 'info' = 'info', durationMs = 5000) {
    const id = Date.now();
    this.toastMessage.value = { text, type, id };
    setTimeout(() => {
      if (this.toastMessage.value?.id === id) {
        this.toastMessage.value = null;
      }
    }, durationMs);
  }

  /**
   * Solicita ao peer a clonagem de uma playlist inteira.
   */
  public async requestPlaylistClone(peerId: string, playlistId: number): Promise<void> {
    await keepAliveService.requestNotificationPermission();
    console.log('[Transfer] Requesting playlist clone from', peerId, 'playlist ID:', playlistId);
    this.showToast('Iniciando transferência...', 'info', 3000);
    p2pService.sendTo(peerId, {
      type: 'request-clone',
      payload: { playlistId }
    });
  }

  /**
   * Solicita ao peer uma única música.
   */
  public async requestSingleSong(peerId: string, playlistId: number, songIndex: number): Promise<void> {
    await keepAliveService.requestNotificationPermission();
    console.log('[Transfer] Requesting single song from', peerId, 'playlist ID:', playlistId, 'index:', songIndex);
    this.showToast('Solicitando música...', 'info', 3000);
    p2pService.sendTo(peerId, {
      type: 'request-song',
      payload: { playlistId, songIndex }
    });
  }

  /**
   * Processa mensagens recebidas relacionadas a transferências.
   */
  public async handleMessage(peerId: string, data: any): Promise<boolean> {
    const type = data?.type;
    const payload = data?.payload || {};

    switch (type) {
      // --- SENDER SIDE HANDLERS (when local device is asked to send music) ---
      case 'request-clone':
        await this.handleOutgoingCloneRequest(peerId, payload.playlistId);
        return true;

      case 'request-song':
        await this.handleOutgoingSongRequest(peerId, payload.playlistId, payload.songIndex);
        return true;

      case 'transfer-song-ack':
      case 'chunk-ack':
        this.handleAckReceived(peerId, payload);
        return true;

      case 'transfer-request-missing':
        this.handleMissingChunksRequest(peerId, payload);
        return true;

      case 'transfer-ping':
        p2pService.sendTo(peerId, { type: 'transfer-pong', payload: { transferId: payload.transferId } });
        return true;

      case 'transfer-pong':
        this.lastActivityTimestamp = Date.now();
        return true;

      // --- RECEIVER SIDE HANDLERS (when local device is downloading music) ---
      case 'clone-start':
      case 'transfer-start':
        await this.handleIncomingStart(peerId, payload);
        return true;

      case 'clone-song-meta':
      case 'transfer-song-meta':
        this.handleIncomingSongMeta(peerId, payload);
        return true;

      case 'clone-song-chunk':
      case 'transfer-song-chunk':
        await this.handleIncomingChunk(peerId, payload);
        return true;

      case 'clone-song-end':
      case 'transfer-song-end':
        await this.handleIncomingSongEnd(peerId, payload);
        return true;

      case 'clone-complete':
      case 'transfer-complete':
        await this.handleIncomingComplete(peerId, payload);
        return true;

      case 'clone-error':
      case 'transfer-error':
        this.handleIncomingError(peerId, payload);
        return true;

      case 'transfer-cancel':
        this.handlePeerCancelled(peerId, payload);
        return true;

      default:
        return false;
    }
  }

  // ==========================================
  // RECEIVER METHODS (Incoming Transfer)
  // ==========================================

  private async handleIncomingStart(peerId: string, payload: any) {
    const transferId = payload.transferId || `tx_${Date.now()}`;
    const rawName = payload.playlistName || 'Playlist';
    const newPlaylistName = `[${peerId.substring(0, 8)}] ${rawName}`;
    const totalSongs = payload.totalSongs || 1;

    console.log('[Transfer] 📥 Incoming transfer started:', newPlaylistName, 'Total songs:', totalSongs);

    // Create target playlist in IndexedDB
    const newPlaylistId = await this.playlistService.addPlaylist(newPlaylistName);

    // Start background keepalive
    await keepAliveService.startKeepAlive('incoming-transfer');
    this.startHeartbeat(peerId, transferId);
    this.startStaleMonitoring();

    this.incoming.active = true;
    this.incoming.transferId = transferId;
    this.incoming.playlistName = newPlaylistName;
    this.incoming.sourcePeerId = peerId;
    this.incoming.currentSongIndex = 0;
    this.incoming.totalSongs = totalSongs;
    this.incoming.overallPercent = 0;
    this.incoming.currentSongTitle = 'Preparando download...';
    this.incoming.currentSongPercent = 0;
    this.incoming.timeRemaining = 'Calculando...';
    this.incoming.startTime = Date.now();
    this.incoming.newPlaylistId = newPlaylistId;
    this.incoming.status = 'transferring';
    this.incoming.errorMessage = undefined;

    this.showToast(`Iniciando download de "${rawName}" (${totalSongs} músicas)`, 'info', 4000);
  }

  private handleIncomingSongMeta(peerId: string, payload: any) {
    this.lastActivityTimestamp = Date.now();
    const { songIndex, totalChunks, title } = payload;
    const key = `${peerId}-${payload.transferId || ''}-${songIndex}`;

    console.log(`[Transfer] 🎵 Meta received for song #${songIndex + 1}: ${title} (${totalChunks} chunks)`);

    this.incoming.currentSongIndex = songIndex;
    this.incoming.currentSongTitle = title || `Música ${songIndex + 1}`;
    this.incoming.currentSongPercent = 0;

    let buffer = this.songBuffers.get(key);
    if (!buffer) {
      buffer = {
        transferId: payload.transferId || '',
        songIndex,
        totalChunks,
        chunks: new Array(totalChunks),
        metadata: payload,
        receivedCount: 0,
        processed: false
      };
      this.songBuffers.set(key, buffer);
    } else {
      buffer.metadata = payload;
      buffer.totalChunks = totalChunks;
    }
  }

  private async handleIncomingChunk(peerId: string, payload: any) {
    this.lastActivityTimestamp = Date.now();
    const { songIndex, chunkIndex, totalChunks, data, transferId } = payload;
    const key = `${peerId}-${transferId || ''}-${songIndex}`;

    let buffer = this.songBuffers.get(key);
    if (!buffer) {
      buffer = {
        transferId: transferId || '',
        songIndex,
        totalChunks,
        chunks: new Array(totalChunks),
        metadata: null,
        receivedCount: 0,
        processed: false
      };
      this.songBuffers.set(key, buffer);
    }

    if (buffer.chunks[chunkIndex] === undefined) {
      buffer.chunks[chunkIndex] = data;
      buffer.receivedCount++;
    }

    // Update progress
    if (this.incoming.active && buffer.totalChunks > 0) {
      this.incoming.currentSongPercent = Math.round((buffer.receivedCount / buffer.totalChunks) * 100);
    }

    // For legacy single songs without explicit end packet: if all chunks arrived and meta exists, process
    if (buffer.receivedCount === buffer.totalChunks && buffer.metadata && !buffer.processed) {
      await this.processAndSaveSong(peerId, buffer);
    }
  }

  private async handleIncomingSongEnd(peerId: string, payload: any) {
    this.lastActivityTimestamp = Date.now();
    const { songIndex, totalChunks, transferId } = payload;
    const key = `${peerId}-${transferId || ''}-${songIndex}`;
    const buffer = this.songBuffers.get(key);

    if (!buffer) {
      console.warn('[Transfer] Song end received but no buffer found for key:', key);
      return;
    }

    // Verify if any chunks are missing
    const missing: number[] = [];
    for (let i = 0; i < totalChunks; i++) {
      if (buffer.chunks[i] === undefined) {
        missing.push(i);
      }
    }

    if (missing.length > 0) {
      console.warn(`[Transfer] ⚠️ Song #${songIndex} has ${missing.length} missing chunks, requesting retransmit...`);
      p2pService.sendTo(peerId, {
        type: 'transfer-request-missing',
        payload: {
          transferId: buffer.transferId,
          songIndex,
          missingIndices: missing
        }
      });
      return;
    }

    // All chunks present, save to IndexedDB
    if (!buffer.processed) {
      await this.processAndSaveSong(peerId, buffer);
    }
  }

  private async processAndSaveSong(peerId: string, buffer: SongBuffer) {
    if (buffer.processed) return;
    buffer.processed = true;

    try {
      this.incoming.status = 'saving';
      const fullDataUrl = buffer.chunks.join('');
      console.log(`[Transfer] 💾 Rebuilding song: ${buffer.metadata?.title || 'Unknown'} (${fullDataUrl.length} chars)`);

      // Convert Base64 data URL to Blob
      let audioBlob: Blob;
      if (fullDataUrl.startsWith('data:')) {
        const parts = fullDataUrl.split(',');
        const mime = parts[0].match(/:(.*?);/)?.[1] || buffer.metadata?.mimeType || 'audio/mpeg';
        const b64Data = parts[1] || '';
        const sliceSize = 1024;
        const byteCharacters = atob(b64Data);
        const byteArrays: Uint8Array[] = [];

        for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
          const slice = byteCharacters.slice(offset, offset + sliceSize);
          const byteNumbers = new Uint8Array(slice.length);
          for (let i = 0; i < slice.length; i++) {
            byteNumbers[i] = slice.charCodeAt(i);
          }
          byteArrays.push(byteNumbers);
        }
        audioBlob = new Blob(byteArrays, { type: mime });
      } else {
        audioBlob = new Blob([fullDataUrl], { type: 'audio/mpeg' });
      }

      const song: Omit<Song, 'id'> = {
        title: buffer.metadata?.title || `Música ${buffer.songIndex + 1}`,
        artist: buffer.metadata?.artist || 'Artista Desconhecido',
        year: buffer.metadata?.year || '',
        img: buffer.metadata?.img || 'musica.png',
        album: buffer.metadata?.album || '',
        duration: buffer.metadata?.duration || 0,
        playlistId: this.incoming.newPlaylistId,
        data: audioBlob
      };

      await this.playlistService.addSong(song);
      console.log(`[Transfer] ✅ Song saved to DB: ${song.title}`);

      // Send ACK back to sender so sender can advance
      p2pService.sendTo(peerId, {
        type: 'transfer-song-ack',
        payload: {
          transferId: buffer.transferId,
          songIndex: buffer.songIndex
        }
      });

      // Update progress
      this.incoming.currentSongIndex = buffer.songIndex + 1;
      const completedSongs = this.incoming.currentSongIndex;
      this.incoming.overallPercent = Math.round((completedSongs / this.incoming.totalSongs) * 100);

      // Estimate remaining time
      if (completedSongs < this.incoming.totalSongs) {
        const elapsed = Date.now() - this.incoming.startTime;
        const avgPerSong = elapsed / completedSongs;
        const remainingMs = avgPerSong * (this.incoming.totalSongs - completedSongs);
        this.incoming.timeRemaining = this.formatTimeRemaining(remainingMs);
        this.incoming.status = 'transferring';
      } else {
        this.incoming.timeRemaining = 'Finalizando...';
      }

    } catch (err: any) {
      console.error('[Transfer] ❌ Error saving song:', err);
      this.showToast(`Falha ao salvar "${buffer.metadata?.title}": ${err.message}`, 'error', 5000);
    } finally {
      const key = `${peerId}-${buffer.transferId}-${buffer.songIndex}`;
      this.songBuffers.delete(key);
    }
  }

  private async handleIncomingComplete(peerId: string, payload: any) {
    // Wait slightly to guarantee all writes finished
    await new Promise(res => setTimeout(res, 600));

    const songsInPlaylist = await this.playlistService.getSongsForPlaylist(this.incoming.newPlaylistId);
    const count = songsInPlaylist.length;
    const name = payload.playlistName || this.incoming.playlistName;

    console.log(`[Transfer] 🎉 Transfer complete! Saved ${count} songs in playlist "${name}"`);

    this.incoming.status = 'completed';
    this.incoming.active = false;
    this.incoming.overallPercent = 100;
    this.cleanupTransfer();

    const successMsg = `Playlist "${name}" transferida com sucesso! (${count} músicas adicionadas)`;
    this.showToast(successMsg, 'success', 7000);
    
    // Background notification
    keepAliveService.showNotification('Transferência Concluída! 🎵', {
      body: successMsg
    });
  }

  private handleIncomingError(peerId: string, payload: any) {
    const errorMsg = payload.message || 'Erro durante a transferência';
    console.error('[Transfer] ❌ Received error from peer:', errorMsg);
    this.incoming.status = 'error';
    this.incoming.errorMessage = errorMsg;
    this.incoming.active = false;
    this.cleanupTransfer();
    this.showToast(`Erro na transferência: ${errorMsg}`, 'error', 7000);
  }

  private handlePeerCancelled(peerId: string, payload: any) {
    console.log('[Transfer] Peer cancelled transfer');
    this.incoming.status = 'error';
    this.incoming.errorMessage = 'Transferência cancelada pelo outro dispositivo.';
    this.incoming.active = false;
    this.cleanupTransfer();
    this.showToast('Transferência cancelada pelo outro dispositivo.', 'info', 5000);
  }

  public cancelIncomingTransfer() {
    if (this.incoming.active && this.incoming.sourcePeerId) {
      p2pService.sendTo(this.incoming.sourcePeerId, {
        type: 'transfer-cancel',
        payload: { transferId: this.incoming.transferId }
      });
    }
    this.incoming.active = false;
    this.incoming.status = 'idle';
    this.cleanupTransfer();
    this.showToast('Download cancelado.', 'info', 3000);
  }

  // ==========================================
  // SENDER METHODS (Outgoing Transfer)
  // ==========================================

  private async handleOutgoingCloneRequest(peerId: string, playlistId: number) {
    try {
      this.cancelOutgoingFlag = false;
      const playlist = await this.playlistService.getPlaylistWithSongs(playlistId);
      if (!playlist || !playlist.songs.length) {
        p2pService.sendTo(peerId, {
          type: 'clone-error',
          payload: { message: 'Playlist vazia ou não encontrada' }
        });
        return;
      }

      await keepAliveService.startKeepAlive('outgoing-transfer');
      const transferId = `tx_${Date.now()}`;
      const totalSongs = playlist.songs.length;

      this.outgoing.active = true;
      this.outgoing.transferId = transferId;
      this.outgoing.targetPeerId = peerId;
      this.outgoing.playlistName = playlist.name;
      this.outgoing.currentSongIndex = 0;
      this.outgoing.totalSongs = totalSongs;
      this.outgoing.overallPercent = 0;
      this.outgoing.currentSongTitle = playlist.songs[0]?.title || '';
      this.outgoing.status = 'transferring';

      console.log(`[Transfer] 📤 Starting outgoing transfer of "${playlist.name}" (${totalSongs} songs) to ${peerId}`);
      this.showToast(`Enviando "${playlist.name}" para outro dispositivo...`, 'info', 4000);

      // Send transfer start header
      p2pService.sendTo(peerId, {
        type: 'transfer-start',
        payload: {
          transferId,
          playlistName: playlist.name,
          totalSongs
        }
      });

      // Transfer each song sequentially with flow control
      for (let i = 0; i < totalSongs; i++) {
        if (this.cancelOutgoingFlag) {
          console.log('[Transfer] Outgoing transfer cancelled by local user');
          break;
        }

        const song = playlist.songs[i];
        this.outgoing.currentSongIndex = i;
        this.outgoing.currentSongTitle = song.title;
        this.outgoing.overallPercent = Math.round((i / totalSongs) * 100);

        await this.sendSongData(peerId, transferId, i, song, totalSongs);
      }

      if (!this.cancelOutgoingFlag) {
        console.log('[Transfer] 📤 All songs sent, sending transfer-complete');
        p2pService.sendTo(peerId, {
          type: 'transfer-complete',
          payload: {
            transferId,
            playlistName: playlist.name,
            totalSongs
          }
        });
        this.outgoing.status = 'completed';
        this.outgoing.overallPercent = 100;
        this.showToast(`Envio de "${playlist.name}" concluído!`, 'success', 5000);
      }

    } catch (err: any) {
      console.error('[Transfer] ❌ Error during outgoing transfer:', err);
      p2pService.sendTo(peerId, {
        type: 'transfer-error',
        payload: { message: err?.message || 'Erro ao processar envio' }
      });
      this.outgoing.status = 'error';
    } finally {
      this.outgoing.active = false;
      keepAliveService.stopKeepAlive('outgoing-transfer');
    }
  }

  private async handleOutgoingSongRequest(peerId: string, playlistId: number, songIndex: number) {
    try {
      this.cancelOutgoingFlag = false;
      const song = await this.playlistService.getSongByIndex(playlistId, songIndex);
      if (!song) {
        p2pService.sendTo(peerId, {
          type: 'clone-error',
          payload: { message: 'Música não encontrada' }
        });
        return;
      }

      await keepAliveService.startKeepAlive('outgoing-transfer');
      const transferId = `tx_${Date.now()}`;

      this.outgoing.active = true;
      this.outgoing.transferId = transferId;
      this.outgoing.targetPeerId = peerId;
      this.outgoing.playlistName = 'Música Única';
      this.outgoing.currentSongIndex = 0;
      this.outgoing.totalSongs = 1;
      this.outgoing.overallPercent = 0;
      this.outgoing.currentSongTitle = song.title;
      this.outgoing.status = 'transferring';

      // Send header
      p2pService.sendTo(peerId, {
        type: 'transfer-start',
        payload: {
          transferId,
          playlistName: 'Playlist',
          totalSongs: 1
        }
      });

      await this.sendSongData(peerId, transferId, 0, song, 1);

      if (!this.cancelOutgoingFlag) {
        p2pService.sendTo(peerId, {
          type: 'transfer-complete',
          payload: { transferId, playlistName: 'Playlist', totalSongs: 1 }
        });
        this.outgoing.status = 'completed';
        this.outgoing.overallPercent = 100;
      }

    } catch (err: any) {
      console.error('[Transfer] ❌ Error in outgoing single song:', err);
      p2pService.sendTo(peerId, {
        type: 'transfer-error',
        payload: { message: err?.message || 'Erro ao enviar música' }
      });
      this.outgoing.status = 'error';
    } finally {
      this.outgoing.active = false;
      keepAliveService.stopKeepAlive('outgoing-transfer');
    }
  }

  private async sendSongData(peerId: string, transferId: string, songIndex: number, song: Song, totalSongs: number) {
    // 1. Convert audio data to Base64 string
    let dataStr = '';
    if (song.data instanceof Blob) {
      dataStr = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(song.data as Blob);
      });
    } else {
      dataStr = song.data as string;
    }

    const totalChunks = Math.ceil(dataStr.length / CHUNK_SIZE);
    let mimeType = 'audio/mpeg';
    if (dataStr.startsWith('data:')) {
      const match = dataStr.match(/^data:([^;]+);/);
      if (match) mimeType = match[1];
    }

    console.log(`[Transfer] 📤 Sending song #${songIndex + 1}/${totalSongs}: "${song.title}" (${totalChunks} chunks)`);

    // 2. Send song metadata
    p2pService.sendTo(peerId, {
      type: 'transfer-song-meta',
      payload: {
        transferId,
        songIndex,
        totalSongs,
        title: song.title,
        artist: song.artist,
        album: song.album,
        duration: song.duration,
        year: song.year,
        img: song.img,
        totalChunks,
        mimeType
      }
    });

    // 3. Helper to send a slice of chunks
    const sendChunkSlice = async (indices: number[]) => {
      for (const idx of indices) {
        if (this.cancelOutgoingFlag) return;
        const start = idx * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, dataStr.length);
        const chunk = dataStr.substring(start, end);

        p2pService.sendTo(peerId, {
          type: 'transfer-song-chunk',
          payload: {
            transferId,
            songIndex,
            chunkIndex: idx,
            totalChunks,
            data: chunk
          }
        });

        // Micro-pause to prevent network buffer congestion
        if (idx % 10 === 0) {
          await new Promise(r => setTimeout(r, 6));
        }
      }
    };

    // 4. Send all chunks initially
    const allIndices = Array.from({ length: totalChunks }, (_, k) => k);
    await sendChunkSlice(allIndices);

    // 5. Send song end signal
    p2pService.sendTo(peerId, {
      type: 'transfer-song-end',
      payload: {
        transferId,
        songIndex,
        totalChunks
      }
    });

    // 6. Wait for ACK or retransmit requests (up to 5 retries)
    let retries = 0;
    while (retries < 5 && !this.cancelOutgoingFlag) {
      const ackKey = `ack-${peerId}-${transferId}-${songIndex}`;
      const missingKey = `missing-${peerId}-${transferId}-${songIndex}`;

      const result = await Promise.race([
        new Promise<'ack'>((resolve) => {
          this.pendingAcks.set(ackKey, () => resolve('ack'));
        }),
        new Promise<{ missing: number[] }>((resolve) => {
          this.pendingMissingRequests.set(missingKey, (missing) => resolve({ missing }));
        }),
        new Promise<'timeout'>((resolve) => {
          setTimeout(() => resolve('timeout'), 15000);
        })
      ]);

      this.pendingAcks.delete(ackKey);
      this.pendingMissingRequests.delete(missingKey);

      if (result === 'ack') {
        console.log(`[Transfer] ✅ Song #${songIndex + 1} acknowledged by receiver`);
        return;
      } else if (typeof result === 'object' && result.missing) {
        console.warn(`[Transfer] Retransmitting ${result.missing.length} missing chunks for song #${songIndex + 1}`);
        await sendChunkSlice(result.missing);
        p2pService.sendTo(peerId, {
          type: 'transfer-song-end',
          payload: { transferId, songIndex, totalChunks }
        });
        retries++;
      } else {
        // Timeout
        retries++;
        console.warn(`[Transfer] ⚠️ Song #${songIndex + 1} ACK timeout (attempt ${retries}/5), probing receiver...`);
        p2pService.sendTo(peerId, {
          type: 'transfer-song-end',
          payload: { transferId, songIndex, totalChunks }
        });
      }
    }
  }

  private handleAckReceived(peerId: string, payload: any) {
    const { transferId, songIndex } = payload;
    const ackKey = `ack-${peerId}-${transferId || ''}-${songIndex}`;
    const resolver = this.pendingAcks.get(ackKey);
    if (resolver) {
      resolver(true);
      this.pendingAcks.delete(ackKey);
    }
  }

  private handleMissingChunksRequest(peerId: string, payload: any) {
    const { transferId, songIndex, missingIndices } = payload;
    const missingKey = `missing-${peerId}-${transferId || ''}-${songIndex}`;
    const resolver = this.pendingMissingRequests.get(missingKey);
    if (resolver) {
      resolver(missingIndices || []);
      this.pendingMissingRequests.delete(missingKey);
    }
  }

  public cancelOutgoingTransfer() {
    this.cancelOutgoingFlag = true;
    if (this.outgoing.active && this.outgoing.targetPeerId) {
      p2pService.sendTo(this.outgoing.targetPeerId, {
        type: 'transfer-cancel',
        payload: { transferId: this.outgoing.transferId }
      });
    }
    this.outgoing.active = false;
    this.outgoing.status = 'idle';
    keepAliveService.stopKeepAlive('outgoing-transfer');
    this.showToast('Envio cancelado.', 'info', 3000);
  }

  // ==========================================
  // HELPERS & LIFECYCLE
  // ==========================================

  private startHeartbeat(peerId: string, transferId: string) {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(() => {
      if (this.incoming.active && this.incoming.sourcePeerId) {
        p2pService.sendTo(peerId, {
          type: 'transfer-ping',
          payload: { transferId }
        });
      } else {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
    }, 10000);
  }

  private startStaleMonitoring() {
    this.lastActivityTimestamp = Date.now();
    if (this.staleInterval) clearInterval(this.staleInterval);
    this.staleInterval = setInterval(() => {
      // If 90s have passed with zero chunks or pings, alert
      if (this.incoming.active && Date.now() - this.lastActivityTimestamp > 90000) {
        console.error('[Transfer] ❌ Transfer timed out after 90s of silence');
        this.incoming.status = 'error';
        this.incoming.errorMessage = 'Conexão interrompida (tempo limite de 90s excedido).';
        this.incoming.active = false;
        this.cleanupTransfer();
        this.showToast('Transferência interrompida por inatividade da conexão.', 'error', 7000);
      }
    }, 15000);
  }

  private cleanupTransfer() {
    if (this.staleInterval) {
      clearInterval(this.staleInterval);
      this.staleInterval = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.songBuffers.clear();
    keepAliveService.stopKeepAlive('incoming-transfer');
  }

  private formatTimeRemaining(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${Math.max(1, seconds)}s restante(s)`;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m ${secs}s restantes`;
  }
}

export const transferService = new TransferService();
