import Dexie, { type Table } from 'dexie';

export interface Playlist {
  id?: number;
  name: string;
  isCollapsed?: boolean;
}

export interface Song {
  id?: number;
  playlistId: number;
  title: string;
  artist: string;
  year: string;
  img: string;
  // Store the actual MP3 data as a Blob
  data: Blob; 
}

export class MySubClassedDexie extends Dexie {
  playlists!: Table<Playlist>;
  songs!: Table<Song>;

  constructor() {
    super('offlinePlayerDB_v2'); // Changed DB name to force a reset
    this.version(1).stores({
      playlists: '++id, name',
      songs: '++id, playlistId, title', 
    });
  }
}

class DbService {
  private db: MySubClassedDexie;

  constructor() {
    this.db = new MySubClassedDexie();
  }

  async getPlaylists(): Promise<Playlist[]> {
    return await this.db.playlists.toArray();
  }

  async addPlaylist(name: string): Promise<number> {
    return await this.db.playlists.add({ name, isCollapsed: false });
  }

  async updatePlaylist(playlist: Playlist): Promise<number> {
    if (playlist.id) {
      return await this.db.playlists.update(playlist.id, playlist);
    }
    return 0;
  }
  
  async getSongsByPlaylist(playlistId: number): Promise<Song[]> {
    return this.db.songs.where({ playlistId }).toArray();
  }

  async addSong(song: Omit<Song, 'id'>): Promise<number> {
    return await this.db.songs.add(song);
  }

  async deleteSong(songId: number): Promise<void> {
    await this.db.songs.delete(songId);
  }

  async deletePlaylist(playlistId: number): Promise<void> {
    await this.db.transaction('rw', this.db.playlists, this.db.songs, async () => {
      // Delete all songs in the playlist
      await this.db.songs.where('playlistId').equals(playlistId).delete();
      // Delete the playlist itself
      await this.db.playlists.delete(playlistId);
    });
  }
}

export const dbService = new DbService();