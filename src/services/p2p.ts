import Peer from 'simple-peer';
import * as Ably from 'ably';

const ABLY_API_KEY = import.meta.env.VITE_ABLY_API_KEY;
const ABLY_CHANNEL_NAME = 'online-player-p2p-channel-v2';

class P2PService {
  private ably: Ably.Realtime | null = null;
  private channel: Ably.Types.RealtimeChannelPromise | null = null;
  private peers: Map<string, Peer.Instance> = new Map();
  private localId: string = `user_${Math.random().toString(36).substr(2, 9)}`;

  public onConnect: ((peerId: string) => void) | null = null;
  public onData: ((peerId: string, data: any) => void) | null = null;
  public onError: ((err: Error) => void) | null = null;
  public onDisconnect: ((peerId: string) => void) | null = null;

  public async init(): Promise<void> {
    console.log('[P2P] Initializing P2P service...');
    if (this.ably) {
      console.log('[P2P] Already initialized');
      return;
    }
    if (!ABLY_API_KEY) {
      const error = new Error("❌ Chave da API do Ably não configurada. Configure VITE_ABLY_API_KEY no arquivo .env");
      console.error('[P2P]', error.message);
      if (this.onError) this.onError(error);
      return;
    }
    console.log('[P2P] API Key found, connecting...');

    try {
      console.log('[P2P] Creating Ably client with ID:', this.localId);
      this.ably = new Ably.Realtime({ key: ABLY_API_KEY, clientId: this.localId });
      
      // Log de estado da conexão Ably
      this.ably.connection.on('connected', () => {
        console.log('[P2P] ✅ Ably connection state: CONNECTED')
      })
      this.ably.connection.on('disconnected', () => {
        console.warn('[P2P] ⚠️ Ably connection state: DISCONNECTED')
      })
      this.ably.connection.on('failed', () => {
        console.error('[P2P] ❌ Ably connection state: FAILED')
      })
      this.ably.connection.on('suspended', () => {
        console.warn('[P2P] ⚠️ Ably connection state: SUSPENDED')
      })
      console.log('[P2P] Current Ably connection state:', this.ably.connection.state)
      
      console.log('[P2P] Getting channel:', ABLY_CHANNEL_NAME);
      this.channel = this.ably.channels.get(ABLY_CHANNEL_NAME);

      await this.channel.subscribe('signal', (message) => {
        if (message.data.to === this.localId) {
          this.handleSignal(message.data);
        }
      });

      this.channel.presence.subscribe('enter', (member) => {
        console.log('[P2P] Peer entered:', member.clientId);
        if (member.clientId !== this.localId) {
          // Only initiate if our ID is greater (to avoid both peers initiating)
          const shouldInitiate = this.localId > member.clientId;
          console.log('[P2P] Should initiate with', member.clientId, '?', shouldInitiate);
          if (shouldInitiate) {
            this.createPeer(member.clientId, true);
          }
        }
      });

      this.channel.presence.subscribe('leave', (member) => {
        const peer = this.peers.get(member.clientId);
        if (peer) {
          peer.destroy();
          this.peers.delete(member.clientId);
          if (this.onDisconnect) this.onDisconnect(member.clientId);
        }
      });

      console.log('[P2P] Entering presence...');
      await this.channel.presence.enter();
      console.log('[P2P] Successfully entered presence');
      
      const existingMembers = await this.channel.presence.get();
      console.log('[P2P] Existing members:', existingMembers.length, existingMembers.map(m => m.clientId));
      existingMembers.forEach(member => {
        if (member.clientId !== this.localId) {
          // Only initiate if our ID is greater
          const shouldInitiate = this.localId > member.clientId;
          console.log('[P2P] Should initiate with existing member', member.clientId, '?', shouldInitiate);
          if (shouldInitiate) {
            console.log('[P2P] Creating peer for existing member:', member.clientId);
            this.createPeer(member.clientId, true);
          }
        }
      });

      console.log('[P2P] ✅ P2P Service initialized successfully');
    } catch (error: any) {
      console.error('[P2P] ❌ Error initializing P2P service:', error);
      if (this.onError) this.onError(error);
    }
  }

  private handleSignal(message: any): void {
    const { from: peerId, signal } = message;
    console.log('[P2P] Received signal from', peerId, 'type:', signal.type);
    const peer = this.peers.get(peerId);

    if (signal.type === 'offer') {
      console.log('[P2P] Received offer, creating peer as answerer');
      this.createPeer(peerId, false, signal);
    } else if (peer) {
      console.log('[P2P] Forwarding signal to existing peer');
      peer.signal(signal);
    } else {
      console.warn('[P2P] Received signal but peer does not exist:', peerId);
    }
  }

  private createPeer(peerId: string, initiator: boolean, offerSignal?: any): void {
    console.log('[P2P] Creating peer connection:', peerId, 'initiator:', initiator);
    if (this.peers.has(peerId)) {
      console.log('[P2P] Peer already exists:', peerId);
      return;
    }

    const peer = new Peer({
      initiator,
      trickle: true,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' }
        ]
      }
    });

    this.peers.set(peerId, peer);

    peer.on('signal', (signal) => {
      console.log('[P2P] Sending signal to', peerId, 'type:', signal.type);
      this.channel?.publish('signal', { to: peerId, from: this.localId, signal });
    });

    peer.on('connect', () => {
      console.log('[P2P] ✅ Connected to peer:', peerId);
      if (this.onConnect) this.onConnect(peerId);
    });

    peer.on('data', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (this.onData) this.onData(peerId, parsed);
      } catch (e) { console.error('[P2P] Error parsing data:', e) }
    });

    peer.on('close', () => {
      this.peers.delete(peerId);
      if (this.onDisconnect) this.onDisconnect(peerId);
    });
    
    peer.on('error', (err) => {
      console.error(`[P2P] ❌ Error in peer ${peerId}:`, err.message);
      this.peers.delete(peerId);
      if (this.onDisconnect) this.onDisconnect(peerId);
    });

    if (offerSignal) {
      console.log('[P2P] Signaling with offer...');
      peer.signal(offerSignal);
    }
    
    // Add timeout for connection
    setTimeout(() => {
      if (!peer.connected) {
        console.warn('[P2P] ⚠️ Connection timeout for peer:', peerId);
      }
    }, 10000);
  }

  public sendTo(peerId: string, data: any): void {
    const peer = this.peers.get(peerId);
    if (peer?.connected) {
      peer.send(JSON.stringify(data));
    } else {
      console.warn('[P2P] Cannot send to', peerId, '- peer not connected');
    }
  }

  public getLocalId(): string {
    return this.localId;
  }
  
  public getAllPeerIds(): string[] {
    return Array.from(this.peers.keys());
  }
  
  public async destroy(): Promise<void> {
    await this.channel?.detach();
    await this.ably?.close();
    this.peers.forEach(p => p.destroy());
    this.peers.clear();
  }
}

export const p2pService = new P2PService();