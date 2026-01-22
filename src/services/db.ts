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
  data: string // Base64 Data URL
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
    // This upgrade function will handle the migration from blob to base64.
    this.version(4)
      .stores({
        songs: '++id, playlistId, title', // No change to indexes, just data structure
      })
      .upgrade(async (tx) => {
        console.log('Upgrading database to version 4: Migrating Blobs to Base64...')
        // This runs only when upgrading from a version < 4
        return tx
          .table('songs')
          .toCollection()
          .modify(async (song) => {
            if (song.data instanceof Blob) {
              try {
                const base64Data = await blobToBase64(song.data)
                song.data = base64Data
              } catch (e) {
                console.error('Could not migrate song, data will be lost.', song.title, e)
                // If conversion fails, storing null will effectively delete the song data
                song.data = null
              }
            }
          })
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
      // Filter out songs that might have null data from a failed migration
      return songs.filter((song) => song && typeof song.data === 'string' && song.data.length > 0)
    } catch (error) {
      console.error('Error getting songs:', error)
      return []
    }
  }

  async addSong(song: Omit<Song, 'id'>): Promise<any> {
    await this.openPromise
    // The data is now expected to be a base64 string, as conversion happens in App.vue
    if (!song.data || typeof song.data !== 'string' || song.data.length === 0) {
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
}

export const dbService = new DbService()
