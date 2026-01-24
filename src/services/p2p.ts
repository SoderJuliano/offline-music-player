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
      // Let Ably choose the best transport (WebSocket / fallback) for Safari reliability
      this.ably = new Ably.Realtime({
        key: ABLY_API_KEY,
        clientId: this.localId,
      });
      
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
        console.log('[P2P] 📦 Ably data (direct) from', from);
        if (this.onData) this.onData(from, payload);
      });

      // Ably broadcast fallback
      this.channel.subscribe('broadcast', (message: Ably.Message) => {
        const { from, payload } = message.data || {};
        if (!from || from === this.localId) return;
        console.log('[P2P] 📡 Ably broadcast from', from);
        if (this.onData) this.onData(from, payload);
      });

      this.channel.presence.subscribe('enter', (member: Ably.PresenceMessage) => {
        console.log('[P2P] Peer entered:', member.clientId);
        if (member.clientId !== this.localId) {
          this.onlineIds.add(member.clientId);
          // Deterministic initiator to avoid glare: higher ID initiates
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

      // Periodic presence refresh to keep onlineIds synced (helps Safari if events are missed)
      try {
        const refresh = async () => {
          if (!this.channel) return;
          try {
            const members = await this.channel.presence.get();
            const ids = new Set<string>();
            members.forEach((m: Ably.PresenceMessage) => {
              if (m.clientId !== this.localId) ids.add(m.clientId);
            });
            // Update onlineIds set
            this.onlineIds = ids;
            // Ensure peers exist for current members
            ids.forEach((id) => {
              if (!this.peers.has(id)) {
                const initiator = this.localId > id;
                console.log('[P2P] 🔄 Presence refresh: creating peer for', id, 'initiator:', initiator);
                this.createPeer(id, initiator);
              }
            });
          } catch (e) {
            console.warn('[P2P] Presence refresh failed:', e);
          }
        };
        // Initial refresh and then periodic
        await refresh();
        (this as any)._presenceInterval = setInterval(refresh, 10000);
      } catch (e) {
        console.warn('[P2P] Failed to start presence refresh loop:', e);
      }
    } catch (error: any) {
      console.error('[P2P] ❌ Error initializing P2P service:', error);
      if (this.onError) this.onError(error);
    }
  }

  private handleSignal(message: any): void {
    const { from: peerId, signal } = message;
    console.log('[P2P] Received signal from', peerId, 'type:', signal.type);
    const peer = this.peers.get(peerId);

    if (peer) {
      // Always feed any incoming signal to existing peer (offer/answer/candidate)
      console.log('[P2P] Forwarding signal to existing peer');
      try { peer.signal(signal); } catch (e) { console.error('[P2P] signal error:', e); }
      return;
    }

    if (signal?.type === 'offer') {
      console.log('[P2P] No peer yet, creating as answerer');
      this.createPeer(peerId, false, signal);
    } else {
      console.warn('[P2P] No peer exists to handle signal of type', signal?.type, 'from', peerId);
    }
  }

  private createPeer(peerId: string, initiator: boolean, offerSignal?: any): void {
    console.log('[P2P] Creating peer connection:', peerId, 'initiator:', initiator);
    if (this.peers.has(peerId)) {
      console.log('[P2P] Peer already exists:', peerId);
      return;
    }

    // Resolve ICE servers: env override or sensible defaults
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
      console.warn('[P2P] ↘️ Using Ably fallback to', peerId, 'type:', data?.type || 'data');
      this.channel?.publish('data', { to: peerId, from: this.localId, payload: data });
    }
  }

  // Broadcast message to all peers via Ably (fallback-friendly)
  public broadcast(data: any): void {
    if (!this.channel) {
      console.warn('[P2P] Cannot broadcast, channel not ready');
      return;
    }
    console.log('[P2P] 📣 Broadcasting', data?.type || 'data');
    this.channel.publish('broadcast', { from: this.localId, payload: data });
  }

  // Register data handler without relying on external injection
  public addDataHandler(handler: (peerId: string, data: any) => void): void {
    this.onData = handler;
    console.log('[P2P] ✅ Data handler registered');
  }

  // Optional: remove handler if it matches current one
  public removeDataHandler(handler: (peerId: string, data: any) => void): void {
    if (this.onData === handler) {
      this.onData = null;
      console.log('[P2P] 🗑️ Data handler removed');
    }
  }

  public getLocalId(): string {
    return this.localId;
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

  // Check if a direct WebRTC data channel is established with a peer
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
    if ((this as any)._presenceInterval) {
      clearInterval((this as any)._presenceInterval);
      (this as any)._presenceInterval = null;
    }
  }
}

export const p2pService = new P2PService();