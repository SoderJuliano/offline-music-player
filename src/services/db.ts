import Dexie, { type Table } from 'dexie';

export interface Playlist {
  id?: number;
  name: string;
}

export interface Song {
  id?: number;
  playlistId: number;
  title: string;
  artist: string;
  year: string;
  img: string;
  data: Blob; 
}

export class MySubClassedDexie extends Dexie {
  playlists!: Table<Playlist>;
  songs!: Table<Song>;

  constructor() {
    super('offlinePlayerDB_v3');
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
    try {
      return await this.db.playlists.toArray();
    } catch (error) {
      return [];
    }
  }

  async addPlaylist(name: string): Promise<number> {
    const id = await this.db.playlists.add({ name });
    // Force a read to ensure it's really saved
    await this.db.playlists.get(id);
    return id;
  }

  async updatePlaylist(playlist: Playlist): Promise<number> {
    if (playlist.id) {
      await this.db.playlists.update(playlist.id, { name: playlist.name });
      // Force a read to verify it was saved
      const saved = await this.db.playlists.get(playlist.id);
      return saved && saved.name === playlist.name ? 1 : 0;
    }
    return 0;
  }
  
  async getSongsByPlaylist(playlistId: number): Promise<Song[]> {
    try {
      const songs = await this.db.songs.where({ playlistId }).toArray();
      
      // Validate that each song's Blob is still valid (iOS issue)
      const validSongs: Song[] = [];
      for (const song of songs) {
        if (song && song.data && song.data instanceof Blob && song.data.size > 0) {
          validSongs.push(song);
        }
      }
      
      return validSongs;
    } catch (error) {
      return [];
    }
  }

  async addSong(song: Omit<Song, 'id'>): Promise<number> {
    // Validate blob before saving
    if (!song.data || !(song.data instanceof Blob) || song.data.size === 0) {
      throw new Error('Invalid audio file');
    }
    
    const id = await this.db.songs.add(song);
    // Force a read to ensure it's really saved
    const saved = await this.db.songs.get(id);
    
    // Verify the blob was saved correctly
    if (!saved || !saved.data || saved.data.size === 0) {
      // Rollback - delete the corrupted entry
      await this.db.songs.delete(id);
      throw new Error('Failed to save audio file');
    }
    
    return id;
  }

  async deleteSong(songId: number): Promise<void> {
    await this.db.songs.delete(songId);
  }

  async deletePlaylist(playlistId: number): Promise<void> {
    await this.db.transaction('rw', this.db.playlists, this.db.songs, async () => {
      await this.db.songs.where('playlistId').equals(playlistId).delete();
      await this.db.playlists.delete(playlistId);
    });
  }
}

export const dbService = new DbService();