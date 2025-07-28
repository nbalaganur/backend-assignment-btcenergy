import fetch from 'node-fetch'
import {
  BitcoinBlock,
  BitcoinTransaction,
  LatestBlock,
  BlocksInDay,
  WalletInfo
} from '../types/bitcoin'

// Energy cost per byte in KwH
const ENERGY_COST_PER_BYTE = 4.56

// Global cache that persists across Lambda instances in the same process
const globalCache = new Map<string, { data: any; timestamp: number }>()

export class BitcoinApiService {
  private readonly baseUrl = 'https://blockchain.info'
  private cache = globalCache // Use global cache instead of instance cache
  private readonly cacheExpiry = 5 * 60 * 1000 // 5 minutes
  private readonly latestBlockCacheExpiry = 1 * 60 * 1000 // 1 minute for latest block
  private readonly fetchTimeout = 15000 // 15 seconds timeout for external API calls

  private async fetchWithCache<T>(url: string, cacheKey: string, customExpiry?: number): Promise<T> {
    // Check cache first
    const cached = this.cache.get(cacheKey)
    const expiry = customExpiry || this.cacheExpiry
    const now = Date.now()
    
    if (cached && now - cached.timestamp < expiry) {      
      return cached.data
    }
    
    try {
      // Create a timeout promise that rejects after the specified timeout
      const fetchPromise = fetch(url, {
        headers: {
          'User-Agent': 'BTC-Energy-Monitor/1.0'
        }
      })
      
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Request timeout after ${this.fetchTimeout}ms`)), this.fetchTimeout)
      })
      
      const response = await Promise.race([fetchPromise, timeoutPromise])

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data = await response.json() as T
      
      // Cache the result
      this.cache.set(cacheKey, { data, timestamp: now })      
      return data
    } catch (error) {
      console.error(`Error fetching ${url}:`, error)
      
      // If we have cached data and this is a timeout/network error, use cache as fallback
      if (cached && (error instanceof Error && 
          (error.message.includes('timeout') || error.message.includes('fetch')))) {
        console.log(`Using cached data as fallback for ${cacheKey}`)
        return cached.data
      }
      
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      throw new Error(`Failed to fetch data from blockchain API: ${errorMessage}`)
    }
  }

  async getLatestBlock(forceRefresh: boolean = false): Promise<LatestBlock> {
    if (forceRefresh) {
      // Clear cache for latest block to force fresh fetch
      this.cache.delete('latest-block')
    }
    
    return this.fetchWithCache<LatestBlock>(
      `${this.baseUrl}/latestblock`,
      'latest-block',
      this.latestBlockCacheExpiry // Use shorter cache for latest block
    )
  }

  async getBlock(blockHash: string): Promise<BitcoinBlock> {
    return this.fetchWithCache<BitcoinBlock>(
      `${this.baseUrl}/rawblock/${blockHash}`,
      `block-${blockHash}`
    )
  }

  async getTransaction(txHash: string): Promise<BitcoinTransaction> {
    return this.fetchWithCache<BitcoinTransaction>(
      `${this.baseUrl}/rawtx/${txHash}`,
      `tx-${txHash}`
    )
  }

  async getBlocksInDay(timeInMilliseconds: number): Promise<BlocksInDay> {
    return this.fetchWithCache<BlocksInDay>(
      `${this.baseUrl}/blocks/${timeInMilliseconds}?format=json`,
      `blocks-day-${timeInMilliseconds}`
    )
  }

  async getWalletInfo(address: string): Promise<WalletInfo> {
    return this.fetchWithCache<WalletInfo>(
      `${this.baseUrl}/rawaddr/${address}`,
      `wallet-${address}`
    )
  }

  calculateTransactionEnergy(sizeBytes: number): number {
    return sizeBytes * ENERGY_COST_PER_BYTE
  }

  calculateBlockEnergy(block: BitcoinBlock): number {
    return block.tx.reduce((total, tx) => total + this.calculateTransactionEnergy(tx.size), 0)
  }

  // Clear expired cache entries
  clearExpiredCache(): void {
    const now = Date.now()
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp >= this.cacheExpiry) {
        this.cache.delete(key)
      }
    }
  }
}

export const bitcoinApiService = new BitcoinApiService()

// Clear cache periodically
setInterval(() => {
  bitcoinApiService.clearExpiredCache()
}, 10 * 60 * 1000) // Every 10 minutes
