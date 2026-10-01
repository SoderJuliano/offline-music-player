import Peer from 'simple-peer';
import * as Ably from 'ably';

const ABLY_API_KEY = import.meta.env.VITE_ABLY_API_KEY;
const ABLY_CHANNEL_NAME = 'online-player-p2p-channel-v2';
// Optional: override ICE servers via env (JSON string)
const ICE_SERVERS_ENV = import.meta.env.VITE_ICE_SERVERS;

class P2PService {
  private ably: Ably.Realtime | null = null;
  private channel: Ably.RealtimeChannel | null = null;
  private peers: Map<string, Peer.Instance> = new Map();
  private localId: string = `user_${Math.random().toString(36).substr(2, 9)}`;
  private onlineIds: Set<string> = new Set();
  private initialized: boolean = false;
  private dataListeners: Set<(peerId: string, data: any) => Promise<void> | void> = new Set();

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
      this.ably = new Ably.Realtime({
        key: ABLY_API_KEY,
        clientId: this.localId,
        autoConnect: true,
      });
      
      // Log de estado da conexão Ably
      this.ably.connection.on('connected', () => {
        console.log('[P2P] ✅ Ably connection state: CONNECTED');
      });
      this.ably.connection.on('disconnected', () => {
        console.warn('[P2P] ⚠️ Ably connection state: DISCONNECTED');
      });
      this.ably.connection.on('failed', () => {
        console.error('[P2P] ❌ Ably connection state: FAILED');
      });
      this.ably.connection.on('suspended', () => {
        console.warn('[P2P] ⚠️ Ably connection state: SUSPENDED');
      });
      
      console.log('[P2P] Getting channel:', ABLY_CHANNEL_NAME);
      this.channel = this.ably.channels.get(ABLY_CHANNEL_NAME);
      // Ensure channel is attached before presence & subscriptions
      await this.channel.attach();

      this.channel.subscribe('signal', (message: Ably.Message) => {
        if (message.data.to === this.localId) {
          this.handleSignal(message.data);
        }
      });

      // Ably direct data (unicast) fallback
      this.channel.subscribe('data', (message: Ably.Message) => {
        const { to, from, payload } = message.data || {};
        if (!to || !from) return;
        if (to !== this.localId) return;
        if (from === this.localId) return;
        this.dispatchData(from, payload);
      });

      // Ably broadcast fallback
      this.channel.subscribe('broadcast', (message: Ably.Message) => {
        const { from, payload } = message.data || {};
        if (!from || from === this.localId) return;
        this.dispatchData(from, payload);
      });

      this.channel.presence.subscribe('enter', (member: Ably.PresenceMessage) => {
        console.log('[P2P] Peer entered:', member.clientId);
        if (member.clientId !== this.localId) {
          this.onlineIds.add(member.clientId);
          const initiator = this.localId > member.clientId;
          if (!this.peers.has(member.clientId)) {
            console.log('[P2P] 🤝 Creating peer on enter with', member.clientId, 'initiator:', initiator);
            this.createPeer(member.clientId, initiator);
          }
        }
      });

      this.channel.presence.subscribe('leave', (member: Ably.PresenceMessage) => {
        console.log('[P2P] Peer left:', member.clientId);
        this.onlineIds.delete(member.clientId);
        const peer = this.peers.get(member.clientId);
        if (peer) {
          peer.destroy();
          this.peers.delete(member.clientId);
          if (this.onDisconnect) this.onDisconnect(member.clientId);
        }
      });

      console.log('[P2P] Entering presence...');
      await this.channel.presence.enter({ joinedAt: Date.now() });
      console.log('[P2P] Successfully entered presence');
      
      const existingMembers = await this.channel.presence.get();
      console.log('[P2P] Existing members:', existingMembers.length, existingMembers.map((m: Ably.PresenceMessage) => m.clientId));
      existingMembers.forEach((member: Ably.PresenceMessage) => {
        if (member.clientId !== this.localId) {
          this.onlineIds.add(member.clientId);
          const initiator = this.localId > member.clientId;
          if (!this.peers.has(member.clientId)) {
            console.log('[P2P] 🔧 Creating peer for existing member:', member.clientId, 'initiator:', initiator);
            this.createPeer(member.clientId, initiator);
          }
        }
      });

      console.log('[P2P] ✅ P2P Service initialized successfully');
      this.initialized = true;

      // Periodic presence refresh
      try {
        const refresh = async () => {
          if (!this.channel) return;
          try {
            const members = await this.channel.presence.get();
            const ids = new Set<string>();
            members.forEach((m: Ably.PresenceMessage) => {
              if (m.clientId !== this.localId) ids.add(m.clientId);
            });
            this.onlineIds = ids;
            ids.forEach((id) => {
              if (!this.peers.has(id)) {
                const initiator = this.localId > id;
                this.createPeer(id, initiator);
              }
            });
          } catch (e) {
            console.warn('[P2P] Presence refresh notice:', e);
          }
        };
        (this as any)._presenceInterval = setInterval(refresh, 10000);
      } catch (e) {
        console.warn('[P2P] Failed to start presence refresh loop:', e);
      }
    } catch (error: any) {
      console.error('[P2P] ❌ Error initializing P2P service:', error);
      if (this.onError) this.onError(error);
    }
  }

  private dispatchData(peerId: string, data: any) {
    if (this.onData) {
      try {
        this.onData(peerId, data);
      } catch (e) {
        console.error('[P2P] Error in onData callback:', e);
      }
    }
    this.dataListeners.forEach((listener) => {
      try {
        listener(peerId, data);
      } catch (e) {
        console.error('[P2P] Error in data listener:', e);
      }
    });
  }

  private handleSignal(message: any): void {
    const { from: peerId, signal } = message;
    const peer = this.peers.get(peerId);

    if (peer) {
      try {
        peer.signal(signal);
      } catch (e) {
        console.error('[P2P] Signal error:', e);
      }
      return;
    }

    if (signal?.type === 'offer') {
      console.log('[P2P] Received offer from new peer, creating answerer:', peerId);
      this.createPeer(peerId, false, signal);
    }
  }

  private createPeer(peerId: string, initiator: boolean, offerSignal?: any): void {
    if (this.peers.has(peerId)) {
      return;
    }

    let iceServers: RTCIceServer[] = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
    ];
    if (ICE_SERVERS_ENV) {
      try {
        const parsed = JSON.parse(ICE_SERVERS_ENV);
        if (Array.isArray(parsed)) iceServers = parsed;
      } catch (e) {
        console.warn('[P2P] Failed to parse VITE_ICE_SERVERS, using defaults');
      }
    }

    const peer = new Peer({
      initiator,
      trickle: true,
      config: {
        iceServers
      }
    });

    this.peers.set(peerId, peer);

    peer.on('signal', (signal) => {
      this.channel?.publish('signal', { to: peerId, from: this.localId, signal });
    });

    peer.on('connect', () => {
      console.log('[P2P] ✅ Connected to peer via WebRTC:', peerId);
      if (this.onConnect) this.onConnect(peerId);
    });

    peer.on('data', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        this.dispatchData(peerId, parsed);
      } catch (e) {
        console.error('[P2P] Error parsing WebRTC data:', e);
      }
    });

    peer.on('close', () => {
      this.peers.delete(peerId);
      if (this.onDisconnect) this.onDisconnect(peerId);
    });
    
    peer.on('error', (err) => {
      console.warn(`[P2P] WebRTC Notice in peer ${peerId}:`, err.message);
      this.peers.delete(peerId);
      if (this.onDisconnect) this.onDisconnect(peerId);
    });

    if (offerSignal) {
      try {
        peer.signal(offerSignal);
      } catch (e) {
        console.error('[P2P] Offer signal error:', e);
      }
    }
  }

  public sendTo(peerId: string, data: any): void {
    const peer = this.peers.get(peerId);
    if (peer && peer.connected) {
      try {
        peer.send(JSON.stringify(data));
        return;
      } catch (err) {
        console.warn('[P2P] WebRTC send failed, falling back to Ably:', err);
      }
    }
    // Ably fallback
    if (this.channel) {
      try {
        this.channel.publish('data', { to: peerId, from: this.localId, payload: data });
      } catch (err) {
        console.error('[P2P] Error publishing via Ably:', err);
      }
    }
  }

  public broadcast(data: any): void {
    if (!this.channel) return;
    try {
      this.channel.publish('broadcast', { from: this.localId, payload: data });
    } catch (err) {
      console.error('[P2P] Broadcast error:', err);
    }
  }

  public addDataHandler(handler: (peerId: string, data: any) => Promise<void> | void): void {
    this.dataListeners.add(handler);
  }

  public removeDataHandler(handler: (peerId: string, data: any) => Promise<void> | void): void {
    this.dataListeners.delete(handler);
  }

  public getLocalId(): string {
    return this.localId;
  }

  public isInitialized(): boolean {
    return this.initialized;
  }
  
  public getOnlinePeerIds(): string[] {
    return Array.from(this.onlineIds).filter(id => id !== this.localId);
  }

  public getAllPeerIds(): string[] {
    const webrtc = Array.from(this.peers.keys());
    const presence = this.getOnlinePeerIds();
    const set = new Set<string>([...webrtc, ...presence]);
    return Array.from(set);
  }

  public isDirectConnected(peerId: string): boolean {
    const peer = this.peers.get(peerId);
    return !!(peer && peer.connected);
  }
  
  public async destroy(): Promise<void> {
    await this.channel?.detach();
    await this.ably?.close();
    this.peers.forEach(p => p.destroy());
    this.peers.clear();
    this.onlineIds.clear();
    this.dataListeners.clear();
    if ((this as any)._presenceInterval) {
      clearInterval((this as any)._presenceInterval);
      (this as any)._presenceInterval = null;
    }
  }
}

export const p2pService = new P2PService();