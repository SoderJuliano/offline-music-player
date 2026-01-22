import { dbService, type Playlist, type Song } from './db'

export interface PlaylistWithSongs extends Playlist {
  songs: Song[]
  offset: number
  allSongsLoaded: boolean
  isLoadingMore: boolean
}

export class PlaylistService {
  get db() {
    return dbService;
  }

  async loadPlaylists(): Promise<Playlist[]> {
    try {
      let loadedPlaylists = await dbService.getPlaylists()

      if (loadedPlaylists.length === 0) {
        const newId = await dbService.addPlaylist('Sua Playlist')
        const newPlaylist = await dbService.getPlaylist(newId);
        if (newPlaylist) {
          loadedPlaylists = [newPlaylist];
        }
      }
      
      return loadedPlaylists.map(p => ({
        ...p,
        name: p.name.trim() || 'Playlist sem nome'
      }));

    } catch (error) {
      console.error('Critical error loading playlists:', error)
      throw error
    }
  }

  async getSongsForPlaylist(
  playlistId: number,
  limit?: number,
  offset?: number,
): Promise<Song[]> {
  try {
    let songs = await dbService.getSongsByPlaylist(playlistId, limit, offset)
    return songs.filter((s) => s && s.id && s.title && s.data)
  } catch (error) {
    console.error(`Error loading songs for playlist ${playlistId}:`, error)
    return []
  }
}

  async addPlaylist(name: string): Promise<number> {
    if (name.trim()) {
      return await dbService.addPlaylist(name.trim());
    }
    throw new Error('Nome da playlist não pode ser vazio');
  }

  async updatePlaylistName(playlistId: number, newName: string): Promise<boolean> {
    try {
      if (!newName || newName.length === 0) {
        return false
      }

      if (newName.length > 100) {
        throw new Error('Nome muito longo. Máximo 100 caracteres.')
      }

      await dbService.updatePlaylist({
        id: playlistId,
        name: newName,
      })

      return true
    } catch (error) {
      throw error
    }
  }

  async addSong(song: Omit<Song, 'id'>): Promise<void> {
    await dbService.addSong(song)
  }

  async deleteSong(songId: number): Promise<void> {
    await dbService.deleteSong(songId)
  }

  async deletePlaylist(playlistId: number): Promise<void> {
    await dbService.deletePlaylist(playlistId)
  }

  async loadAllPlaylistsWithSongs(): Promise<PlaylistWithSongs[]> {
    const playlists = await this.loadPlaylists();
    const result: PlaylistWithSongs[] = [];
    
    for (const playlist of playlists) {
      if (!playlist.id) continue;
      const songs = await this.getSongsForPlaylist(playlist.id);
      result.push({
        ...playlist,
        songs,
        offset: 0,
        allSongsLoaded: true,
        isLoadingMore: false
      });
    }
    
    return result;
  }

  async getPlaylistWithSongs(playlistId: number): Promise<PlaylistWithSongs | null> {
    const playlist = await dbService.getPlaylist(playlistId);
    if (!playlist) return null;
    
    const songs = await this.getSongsForPlaylist(playlistId);
    return {
      ...playlist,
      songs,
      offset: 0,
      allSongsLoaded: true,
      isLoadingMore: false
    };
  }

  async createPlaylistWithSongs(name: string, songs: Song[]): Promise<number> {
    const playlistId = await this.addPlaylist(name);
    for (const song of songs) {
      await this.addSong({
        ...song,
        playlistId
      });
    }
    return playlistId;
  }
}
