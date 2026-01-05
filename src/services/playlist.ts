import { dbService, type Playlist, type Song } from './db';

export interface PlaylistWithSongs {
  id: number;
  name: string;
  songs: Song[];
}

export class PlaylistService {
  async loadPlaylistsAndSongs(): Promise<PlaylistWithSongs[]> {
    try {
      const loadedPlaylists = await dbService.getPlaylists();
      const playlistsWithSongs: PlaylistWithSongs[] = [];

      if (loadedPlaylists.length === 0) {
        const newId = await dbService.addPlaylist('Sua Playlist');
        playlistsWithSongs.push({ id: newId, name: 'Sua Playlist', songs: [] });
      } else {
        for (const p of loadedPlaylists) {
          if (!p || !p.id || typeof p.name !== 'string') {
            continue;
          }
          
          let songs: Song[] = [];
          try {
            songs = await dbService.getSongsByPlaylist(p.id);
            songs = songs.filter(s => s && s.id && s.title && s.data);
          } catch (error) {
            songs = [];
          }
          
          playlistsWithSongs.push({ 
            id: p.id,
            name: p.name.trim() || 'Playlist sem nome',
            songs: songs
          });
        }
      }

      return playlistsWithSongs;
    } catch (error) {
      return [{ id: 1, name: 'Minha Playlist', songs: [] }];
    }
  }

  async addPlaylist(name: string): Promise<void> {
    if (name.trim()) {
      await dbService.addPlaylist(name.trim());
    }
  }

  async updatePlaylistName(playlistId: number, newName: string): Promise<boolean> {
    try {
      if (!newName || newName.length === 0) {
        return false;
      }
      
      if (newName.length > 100) {
        throw new Error('Nome muito longo. Máximo 100 caracteres.');
      }
      
      await dbService.updatePlaylist({
        id: playlistId,
        name: newName
      });
      
      return true;
    } catch (error) {
      throw error;
    }
  }

  async addSong(song: Omit<Song, 'id'>): Promise<void> {
    await dbService.addSong(song);
  }

  async deleteSong(songId: number): Promise<void> {
    await dbService.deleteSong(songId);
  }

  async deletePlaylist(playlistId: number): Promise<void> {
    await dbService.deletePlaylist(playlistId);
  }
}
