import Dexie, { type Table } from 'dexie'

export interface Playlist {
  id?: number
  name: string
}

export interface Song {
  id?: number
  playlistId: number
  title: string
  artist: string
  year: string
  img: string
  album?: string
  duration?: number
  data: string | Blob // Supports legacy Base64 and new Blob storage
}

// This helper is used for the migration and for adding new songs
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

export class MySubClassedDexie extends Dexie {
  playlists!: Table<Playlist>
  songs!: Table<Song>

  constructor() {
    // Use a simple name, versioning is handled by .version() calls
    super('offlinePlayerDB')

    // Schema for original version of the DB that stored Blobs
    this.version(1).stores({
      playlists: '++id, name',
      songs: '++id, playlistId, title',
    })
    this.version(2).stores({
      playlists: '++id, name',
      songs: '++id, playlistId, title',
    })
    this.version(3).stores({
      playlists: '++id, name',
      songs: '++id, playlistId, title',
    })

    // Version 4: The new schema. Data is now a base64 string.
    this.version(4)
      .stores({
        songs: '++id, playlistId, title',
      })
      .upgrade(async (tx) => {
        console.log('Upgrading database to version 4: Migrating Blobs to Base64...')
        return tx
          .table('songs')
          .toCollection()
          .modify(async (song) => {
            if (song.data instanceof Blob) {
              try {
                const base64Data = await blobToBase64(song.data)
                song.data = base64Data
              } catch (e) {
                console.error('Could not migrate song.', song.title, e)
                song.data = null
              }
            }
          })
      })

    // Version 5: Support for both Base64 and Blob. 
    // New songs will be stored as Blobs for efficiency.
    this.version(5).stores({
      songs: '++id, playlistId, title',
    })
  }
}

class DbService {
  private db: MySubClassedDexie
  private openPromise: Promise<any> | null = null

  constructor() {
    this.db = new MySubClassedDexie()
    this.openPromise = this._ensureOpen()
  }

  private async _ensureOpen() {
    try {
      if (!this.db.isOpen()) {
        await this.db.open()
      }
    } catch (error) {
      console.error('Failed to open IndexedDB:', error)
      throw new Error(
        'O acesso ao banco de dados falhou. Verifique se o navegador não está no modo privado ou com configurações de privacidade muito restritas.',
      )
    }
  }

  async getPlaylists(): Promise<Playlist[]> {
    await this.openPromise
    try {
      return await this.db.playlists.toArray()
    } catch (error) {
      console.error('Error getting playlists:', error)
      return []
    }
  }

  async addPlaylist(name: string): Promise<any> {
    await this.openPromise
    const id = await this.db.playlists.add({ name })
    await this.db.playlists.get(id)
    return id
  }

  async updatePlaylist(playlist: Playlist): Promise<number> {
    await this.openPromise
    if (playlist.id) {
      await this.db.playlists.update(playlist.id, { name: playlist.name })
      const saved = await this.db.playlists.get(playlist.id)
      return saved && saved.name === playlist.name ? 1 : 0
    }
    return 0
  }

  async getPlaylist(id: number): Promise<Playlist | undefined> {
    await this.openPromise
    try {
      return await this.db.playlists.get(id)
    } catch (error) {
      console.error('Error getting playlist:', error)
      return undefined
    }
  }

  async getSongsByPlaylist(
    playlistId: number,
    limit?: number,
    offset?: number,
  ): Promise<Song[]> {
    await this.openPromise
    try {
      let query = this.db.songs.where({ playlistId })

      if (offset) {
        query = query.offset(offset)
      }
      if (limit) {
        query = query.limit(limit)
      }

      const songs = await query.toArray()
      // Filter out songs that might have null data
      return songs.filter((song) => song && song.data)
    } catch (error) {
      console.error('Error getting songs:', error)
      return []
    }
  }

  async addSong(song: Omit<Song, 'id'>): Promise<any> {
    await this.openPromise
    if (!song.data) {
      throw new Error('Dados de áudio inválidos ou vazios.')
    }

    const id = await this.db.songs.add(song)
    const saved = await this.db.songs.get(id)

    if (!saved || !saved.data) {
      await this.db.songs.delete(id)
      throw new Error('Falha ao salvar o arquivo de áudio. O armazenamento pode estar cheio.')
    }

    return id
  }

  async deleteSong(songId: number): Promise<void> {
    await this.openPromise
    await this.db.songs.delete(songId)
  }

  async deletePlaylist(playlistId: number): Promise<void> {
    await this.openPromise
    await this.db.transaction('rw', this.db.playlists, this.db.songs, async () => {
      await this.db.songs.where('playlistId').equals(playlistId).delete()
      await this.db.playlists.delete(playlistId)
    })
  }

  async moveSong(songId: number, targetPlaylistId: number): Promise<void> {
    await this.openPromise
    await this.db.songs.update(songId, { playlistId: targetPlaylistId })
  }

  async getSongCountForPlaylist(playlistId: number): Promise<number> {
    await this.openPromise
    try {
      // Efficient count without loading full song data
      return await this.db.songs.where('playlistId').equals(playlistId).count()
    } catch (error) {
      console.error('Error counting songs for playlist:', playlistId, error)
      return 0
    }
  }
}

export const dbService = new DbService()
