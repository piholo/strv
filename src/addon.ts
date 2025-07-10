import { addonBuilder, getRouter, Manifest, Stream } from "stremio-addon-sdk";
import * as fs from 'fs';
import { landingTemplate } from './landingPage';
import * as path from 'path';
import express, { Request, Response, NextFunction } from 'express'; // ✅ CORRETTO: Import tipizzato
import { AnimeUnityProvider } from './providers/animeunity-provider';
import { KitsuProvider } from './providers/kitsu'; 
import { formatMediaFlowUrl } from './utils/mediaflow';
import { AnimeUnityConfig } from "./types/animeunity";
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as util from 'util';
import process from 'process';
import { getStreamContent, VixCloudStreamInfo, ExtractorConfig } from './extractor';

// Promisify execFile
const execFilePromise = util.promisify(execFile);

// Interfaccia per la configurazione URL
interface AddonConfig {
  mediaFlowProxyUrl?: string;
  mediaFlowProxyPassword?: string;
  tmdbApiKey?: string;
  bothLinks?: string;
  animeunityEnabled?: string;
  animesaturnEnabled?: string;
  enableLiveTV?: string;
  mfpProxyUrl?: string;
  mfpProxyPassword?: string;
  tvProxyUrl?: string;
  [key: string]: any;
}

// Cache globale per la configurazione
const configCache: AddonConfig = {
  mediaFlowProxyUrl: process.env.MFP_URL,
  mediaFlowProxyPassword: process.env.MFP_PSW,
  mfpProxyUrl: process.env.MFP_URL,
  mfpProxyPassword: process.env.MFP_PSW,
  tvProxyUrl: process.env.TV_PROXY_URL,
  enableLiveTV: 'on'
};

// Funzione globale per log di debug
const debugLog = (message: string, ...params: any[]) => {
    console.log(`🔧 ${message}`, ...params);
    
    // Scrivi anche su file di log
    try {
        const logPath = path.join(__dirname, '../logs');
        if (!fs.existsSync(logPath)) {
            fs.mkdirSync(logPath, { recursive: true });
        }
        const logFile = path.join(logPath, 'config_debug.log');
        const timestamp = new Date().toISOString();
        const logMessage = `${timestamp} - ${message} ${params.length ? JSON.stringify(params) : ''}\n`;
        fs.appendFileSync(logFile, logMessage);
    } catch (e) {
        console.error('Error writing to log file:', e);
    }
};

// Base manifest configuration
const baseManifest: Manifest = {
    id: "org.stremio.vixcloud",
    version: "4.0.1",
    name: "StreamViX",
    description: "Addon for Vixsrc, AnimeUnity streams and Live TV.", 
    icon: "/public/icon.png",
    background: "/public/backround.png",
    types: ["movie", "series", "tv"],
    idPrefixes: ["tt", "kitsu", "tv"],
    catalogs: [
        {
            type: "tv",
            id: "tv-channels",
            name: "StreamViX TV",
            extra: [
                {
                    name: "genre",
                    isRequired: false,
                    options: [
                        "RAI",
                        "Mediaset", 
                        "Sky",
                        "Bambini",
                        "News",
                        "Sport",
                        "Cinema",
                        "Generali",
                        "Documentari"
                    ]
                }
            ]
        }
    ],
    resources: ["stream", "catalog", "meta"],
    behaviorHints: {
        configurable: true
    },
    config: [
        {
            key: "tmdbApiKey",
            title: "TMDB API Key",
            type: "text"
        },
        {
            key: "mediaFlowProxyUrl", 
            title: "MediaFlow Proxy URL",
            type: "text"
        },
        {
            key: "mediaFlowProxyPassword",
            title: "MediaFlow Proxy Password ", 
            type: "text"
        },
        {
            key: "bothLinks",
            title: "Mostra entrambi i link (Proxy e Direct)",
            type: "checkbox"
        },
        {
            key: "animeunityEnabled",
            title: "Enable AnimeUnity",
            type: "checkbox"
        },
        {
            key: "animesaturnEnabled",
            title: "Enable AnimeSaturn",
            type: "checkbox"
        },
        {
            key: "enableLiveTV",
            title: "Enable Live TV",
            type: "checkbox"
        },
        {
            key: "mfpProxyUrl",
            title: "MFP Proxy URL",
            type: "text"
        },
        {
            key: "mfpProxyPassword",
            title: "MFP Proxy Password",
            type: "text"
        },
        {
            key: "tvProxyUrl",
            title: "TV Proxy URL",
            type: "text"
        }
    ]
};

// Load custom configuration if available
function loadCustomConfig(): Manifest {
    try {
        const configPath = path.join(__dirname, '..', 'addon-config.json');
        
        if (fs.existsSync(configPath)) {
            const customConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            
            return {
                ...baseManifest,
                id: customConfig.addonId || baseManifest.id,
                name: customConfig.addonName || baseManifest.name,
                description: customConfig.addonDescription || baseManifest.description,
                version: customConfig.addonVersion || baseManifest.version,
                logo: customConfig.addonLogo || baseManifest.logo,
                icon: customConfig.addonLogo || baseManifest.icon,
                background: baseManifest.background
            };
        }
    } catch (error) {
        console.error('Error loading custom configuration:', error);
    }
    
    return baseManifest;
}

// Funzione per parsare la configurazione dall'URL
function parseConfigFromArgs(args: any): AddonConfig {
    const config: AddonConfig = {};
    
    // Se non ci sono args o sono vuoti, ritorna configurazione vuota
    if (!args || args === '' || args === 'undefined' || args === 'null') {
        debugLog('No configuration provided, using defaults');
        return config;
    }
    
    // Se la configurazione è già un oggetto, usala direttamente
    if (typeof args === 'object' && args !== null) {
        debugLog('Configuration provided as object');
        return args;
    }
    
    if (typeof args === 'string') {
        debugLog(`Configuration string: ${args.substring(0, 50)}... (length: ${args.length})`);
        
        // PASSO 1: Prova JSON diretto
        try {
            const parsed = JSON.parse(args);
            debugLog('Configuration parsed as direct JSON');
            return parsed;
        } catch (error) {
            debugLog('Not direct JSON, trying other methods');
        }
        
        // PASSO 2: Gestione URL encoded
        let decodedArgs = args;
        if (args.includes('%')) {
            try {
                decodedArgs = decodeURIComponent(args);
                debugLog('URL-decoded configuration');
                
                // Prova JSON dopo URL decode
                try {
                    const parsed = JSON.parse(decodedArgs);
                    debugLog('Configuration parsed from URL-decoded JSON');
                    return parsed;
                } catch (innerError) {
                    debugLog('URL-decoded content is not valid JSON');
                }
            } catch (error) {
                debugLog('URL decoding failed');
            }
        }
        
        // PASSO 3: Gestione Base64
        if (decodedArgs.startsWith('eyJ') || /^[A-Za-z0-9+\/=]+$/.test(decodedArgs)) {
            try {
                // Fix per caratteri = che potrebbero essere URL encoded
                const base64Fixed = decodedArgs
                    .replace(/%3D/g, '=')
                    .replace(/=+$/, ''); // Rimuove eventuali = alla fine
                
                // Assicura che la lunghezza sia multipla di 4 aggiungendo = se necessario
                let paddedBase64 = base64Fixed;
                while (paddedBase64.length % 4 !== 0) {
                    paddedBase64 += '=';
                }
                
                debugLog(`Trying base64 decode: ${paddedBase64.substring(0, 20)}...`);
                const decoded = Buffer.from(paddedBase64, 'base64').toString('utf-8');
                debugLog(`Base64 decoded result: ${decoded.substring(0, 50)}...`);
                
                if (decoded.includes('{') && decoded.includes('}')) {
                    try {
                        const parsed = JSON.parse(decoded);
                        debugLog('Configuration parsed from Base64');
                        return parsed;
                    } catch (jsonError) {
                        debugLog('Base64 content is not valid JSON');
                        
                        // Prova a estrarre JSON dalla stringa decodificata
                        const jsonMatch = decoded.match(/({.*})/);
                        if (jsonMatch && jsonMatch[1]) {
                            try {
                                const extractedJson = jsonMatch[1];
                                const parsed = JSON.parse(extractedJson);
                                debugLog('Extracted JSON from Base64 decoded string');
                                return parsed;
                            } catch (extractError) {
                                debugLog('Extracted JSON parsing failed');
                            }
                        }
                    }
                }
            } catch (error) {
                debugLog('Base64 decoding failed');
            }
        }
        
        debugLog('All parsing methods failed, using default configuration');
    }
    
    return config;
}

// Carica canali TV e domini da file esterni
let tvChannels: any[] = [];
let domains: any = {};

// ✅ DICHIARAZIONE delle variabili globali del builder
let globalBuilder: any;
let globalAddonInterface: any;
let globalRouter: any;

// Cache per i link Vavoo
interface VavooCache {
    timestamp: number;
    links: Map<string, string | string[]>;
    updating: boolean;
}

const vavooCache: VavooCache = {
    timestamp: 0,
    links: new Map<string, string | string[]>(),
    updating: false
};

// Path del file di cache per Vavoo
const vavaoCachePath = path.join(__dirname, '../cache/vavoo_cache.json');

// Se la cache non esiste, genera automaticamente
if (!fs.existsSync(vavaoCachePath)) {
    console.warn('⚠️ [VAVOO] Cache non trovata, provo a generarla automaticamente...');
    try {
        const { execSync } = require('child_process');
        execSync('python3 vavoo_resolver.py --build-cache', { cwd: path.join(__dirname, '..') });
        console.log('✅ [VAVOO] Cache generata automaticamente!');
    } catch (err) {
        console.error('❌ [VAVOO] Errore nella generazione automatica della cache:', err);
    }
}

// Funzione per caricare la cache Vavoo dal file
function loadVavooCache(): void {
    try {
        if (fs.existsSync(vavaoCachePath)) {
            const rawCache = fs.readFileSync(vavaoCachePath, 'utf-8');
            // RIMOSSO: console.log('🔧 [VAVOO] RAW vavoo_cache.json:', rawCache);
            const cacheData = JSON.parse(rawCache);
            vavooCache.timestamp = cacheData.timestamp || 0;
            vavooCache.links = new Map(Object.entries(cacheData.links || {}));
            console.log(`📺 Vavoo cache caricata con ${vavooCache.links.size} canali, aggiornata il: ${new Date(vavooCache.timestamp).toLocaleString()}`);
            console.log('🔧 [VAVOO] DEBUG - Cache caricata all\'avvio:', vavooCache.links.size, 'canali');
            console.log('🔧 [VAVOO] DEBUG - Path cache:', vavaoCachePath);
            // RIMOSSO: stampa dettagliata del contenuto della cache
        } else {
            console.log(`📺 File cache Vavoo non trovato, verrà creato al primo aggiornamento`);
        }
    } catch (error) {
        console.error('❌ Errore nel caricamento della cache Vavoo:', error);
    }
}

// Funzione per salvare la cache Vavoo su file
function saveVavooCache(): void {
    try {
        // Assicurati che la directory cache esista
        const cacheDir = path.dirname(vavaoCachePath);
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }

        const cacheData = {
            timestamp: vavooCache.timestamp,
            links: Object.fromEntries(vavooCache.links)
        };
        
        // Salva prima in un file temporaneo e poi rinomina per evitare file danneggiati
        const tempPath = `${vavaoCachePath}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(cacheData, null, 2), 'utf-8');
        
        // Rinomina il file temporaneo nel file finale
        fs.renameSync(tempPath, vavaoCachePath);
        
        console.log(`📺 Vavoo cache salvata con ${vavooCache.links.size} canali, timestamp: ${new Date(vavooCache.timestamp).toLocaleString()}`);
    } catch (error) {
        console.error('❌ Errore nel salvataggio della cache Vavoo:', error);
    }
}

// Funzione per aggiornare la cache Vavoo
async function updateVavooCache(): Promise<boolean> {
    if (vavooCache.updating) {
        console.log(`📺 Aggiornamento Vavoo già in corso, skip`);
        return false;
    }

    vavooCache.updating = true;
    console.log(`📺 Avvio aggiornamento cache Vavoo...`);
    try {
        // PATCH: Prendi TUTTI i canali da Vavoo, senza filtri su tv_channels.json
        const result = await execFilePromise('python3', [
            path.join(__dirname, '../vavoo_resolver.py'),
            '--dump-channels'
        ], { timeout: 30000 });

        if (result.stdout) {
            try {
                const channels = JSON.parse(result.stdout);
                console.log(`📺 Recuperati ${channels.length} canali da Vavoo (nessun filtro)`);
                const updatedLinks = new Map<string, string>();
                for (const ch of channels) {
                    if (ch.name && ch.url) {
                        updatedLinks.set(ch.name, ch.url);
                    }
                }
                vavooCache.links = updatedLinks;
                vavooCache.timestamp = Date.now();
                saveVavooCache();
                console.log(`✅ Cache Vavoo aggiornata: ${updatedLinks.size} canali in cache (tutti)`);
                return true;
            } catch (jsonError) {
                console.error('❌ Errore nel parsing del risultato JSON di Vavoo:', jsonError);
                throw jsonError;
            }
        }
    } catch (error) {
        console.error('❌ Errore durante l\'aggiornamento della cache Vavoo:', error);
        return false;
    } finally {
        vavooCache.updating = false;
    }
    return false;
}

// Rimuovo l'inizializzazione EPG all'avvio e i timer periodici
try {
    // Assicurati che le directory di cache esistano
    ensureCacheDirectories();
    
    tvChannels = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/tv_channels.json'), 'utf-8'));
    domains = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/domains.json'), 'utf-8'));
    
    console.log(`✅ Loaded ${tvChannels.length} TV channels`);
    
    // ✅ INIZIALIZZA IL ROUTER GLOBALE SUBITO DOPO IL CARICAMENTO
    console.log('🔧 Initializing global router after loading TV channels...');
    globalBuilder = createBuilder(configCache);
    globalAddonInterface = globalBuilder.getInterface();
    globalRouter = getRouter(globalAddonInterface);
    console.log('✅ Global router initialized successfully');
    
    // Carica la cache Vavoo
    loadVavooCache();

    // Dopo il caricamento della cache Vavoo
    if (vavooCache && vavooCache.links) {
        try {
            const cacheObj = Object.fromEntries(vavooCache.links);
            console.log('[VAVOO] DUMP CACHE COMPLETA:', JSON.stringify(cacheObj, null, 2));
        } catch (e) {
            console.log('[VAVOO] ERRORE DUMP CACHE:', e);
        }
    }
    
    // Aggiorna la cache Vavoo in background all'avvio
    setTimeout(() => {
        updateVavooCache().then(success => {
            if (success) {
                console.log(`✅ Cache Vavoo aggiornata con successo all'avvio`);
            } else {
                console.log(`⚠️ Aggiornamento cache Vavoo fallito all'avvio, verrà ritentato periodicamente`);
            }
        }).catch(error => {
            console.error(`❌ Errore durante l'aggiornamento cache Vavoo all'avvio:`, error);
        });
    }, 2000);
    
    // Programma aggiornamenti periodici della cache Vavoo (ogni 12 ore)
    const VAVOO_UPDATE_INTERVAL = 12 * 60 * 60 * 1000; // 12 ore in millisecondi
    setInterval(() => {
        console.log(`🔄 Aggiornamento periodico cache Vavoo avviato...`);
        updateVavooCache().then(success => {
            if (success) {
                console.log(`✅ Cache Vavoo aggiornata periodicamente con successo`);
            } else {
                console.log(`⚠️ Aggiornamento periodico cache Vavoo fallito`);
            }
        }).catch(error => {
            console.error(`❌ Errore durante l'aggiornamento periodico cache Vavoo:`, error);
        });
    }, VAVOO_UPDATE_INTERVAL);
    // --- RIMOSSO: nessuna inizializzazione/aggiornamento EPG all'avvio o periodico ---
} catch (error) {
    console.error('❌ Errore nel caricamento dei file di configurazione TV:', error);
}

// Funzione per determinare le categorie di un canale
function getChannelCategories(channel: any): string[] {
    const categories: string[] = [];
    
    if (Array.isArray(channel.categories)) {
        categories.push(...channel.categories);
    } else if (Array.isArray(channel.category)) {
        categories.push(...channel.category);
    } else if (channel.category) {
        categories.push(channel.category);
    }
    
    if (categories.length === 0) {
        const name = channel.name.toLowerCase();
        const description = channel.description.toLowerCase();
        
        if (name.includes('rai') || description.includes('rai')) {
            categories.push('rai');
        }
        if (name.includes('mediaset') || description.includes('mediaset') || 
            name.includes('canale 5') || name.includes('italia') || name.includes('rete 4')) {
            categories.push('mediaset');
        }
        if (name.includes('sky') || description.includes('sky')) {
            categories.push('sky');
        }
        if (name.includes('gulp') || name.includes('yoyo') || name.includes('boing') || name.includes('cartoonito')) {
            categories.push('kids');
        }
        if (name.includes('news') || name.includes('tg') || name.includes('focus')) {
            categories.push('news');
        }
        if (name.includes('sport') || name.includes('tennis') || name.includes('eurosport')) {
            categories.push('sport');
        }
        if (name.includes('cinema') || name.includes('movie') || name.includes('warner')) {
            categories.push('movies');
        }
        
        if (categories.length === 0) {
            categories.push('general');
        }
    }
    
    return categories;
}

// Funzione per risolvere un canale Vavoo usando la cache
function resolveVavooChannelByName(channelName: string): Promise<string | null> {
    return new Promise((resolve) => {
        // Check cache age
        const cacheAge = Date.now() - vavooCache.timestamp;
        const CACHE_MAX_AGE = 12 * 60 * 60 * 1000; // 12 ore in millisecondi
        
        // Se la cache è troppo vecchia o vuota, forzane l'aggiornamento (ma continua comunque a usarla)
        if (cacheAge > CACHE_MAX_AGE || vavooCache.links.size === 0) {
            console.log(`[Vavoo] Cache obsoleta o vuota (età: ${Math.round(cacheAge/3600000)}h), avvio aggiornamento in background...`);
            // Non blocchiamo la risposta, aggiorniamo in background
            updateVavooCache().catch(error => {
                console.error(`[Vavoo] Errore nell'aggiornamento cache:`, error);
            });
        }
        
        // Cerca il canale nella cache
        if (channelName && vavooCache.links.has(channelName)) {
            const cachedUrlRaw = vavooCache.links.get(channelName);
            let cachedUrl: string | null = null;
            if (Array.isArray(cachedUrlRaw)) {
                cachedUrl = cachedUrlRaw[0] || null;
            } else if (typeof cachedUrlRaw === 'string') {
                cachedUrl = cachedUrlRaw;
            }
            console.log(`[Vavoo] Trovato in cache: ${channelName} -> ${cachedUrl ? cachedUrl.substring(0, 50) : 'null'}...`);
            return resolve(cachedUrl);
        }
        
        // Se non è nella cache ma la cache è stata inizializzata
        if (vavooCache.timestamp > 0) {
            console.log(`[Vavoo] Canale ${channelName} non trovato in cache, aggiornamento necessario`);
            // Tenta di aggiornare la cache in background se non è già in corso
            if (!vavooCache.updating) {
                updateVavooCache().catch(error => {
                    console.error(`[Vavoo] Errore nell'aggiornamento cache:`, error);
                });
            }
            return resolve(null);
        }
        
        // Se la cache non è ancora stata inizializzata, chiama lo script Python come fallback
        console.log(`[Vavoo] Cache non inizializzata, chiamo script Python per ${channelName}`);
        const timeout = setTimeout(() => {
            console.log(`[Vavoo] Timeout per canale: ${channelName}`);
            resolve(null);
        }, 5000);

        const options = {
            timeout: 5000,
            env: {
                ...process.env,
                PYTHONPATH: '/usr/local/lib/python3.9/site-packages'
            }
        };
        
        execFile('python3', [path.join(__dirname, '../vavoo_resolver.py'), channelName, '--original-link'], options, (error: Error | null, stdout: string, stderr: string) => {
            clearTimeout(timeout);
            
            if (error) {
                console.error(`[Vavoo] Error for ${channelName}:`, error.message);
                if (stderr) console.error(`[Vavoo] Stderr:`, stderr);
                return resolve(null);
            }
            
            if (!stdout || stdout.trim() === '') {
                console.log(`[Vavoo] No output for ${channelName}`);
                return resolve(null);
            }
            
            const result = stdout.trim();
            console.log(`[Vavoo] Resolved ${channelName} to: ${result.substring(0, 50)}...`);
            
            // Aggiorna la cache con questo risultato
            vavooCache.links.set(channelName, result);
            
            resolve(result);
        });
    });
}

function normalizeProxyUrl(url: string): string {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

// Funzione per creare il builder con configurazione dinamica
function createBuilder(initialConfig: AddonConfig = {}) {
    const manifest = loadCustomConfig();
    
    if (initialConfig.mediaFlowProxyUrl || initialConfig.bothLinks || initialConfig.tmdbApiKey) {
        manifest.name;
    }
    
    const builder = new addonBuilder(manifest);

    // === HANDLER CATALOGO TV ===
    builder.defineCatalogHandler(async ({ type, id, extra }: { type: string; id: string; extra?: any }) => {
        if (type === "tv") {
            let filteredChannels = tvChannels;
            if (extra && extra.genre) {
                const genreMap: { [key: string]: string } = {
                    "RAI": "rai",
                    "Mediaset": "mediaset",
                    "Sky": "sky",
                    "Bambini": "kids",
                    "News": "news",
                    "Sport": "sport",
                    "Cinema": "movies",
                    "Generali": "general",
                    "Documentari": "documentari"
                };
                const targetCategory = genreMap[extra.genre];
                if (targetCategory) {
                    filteredChannels = tvChannels.filter((channel: any) => {
                        const categories = getChannelCategories(channel);
                        return categories.includes(targetCategory);
                    });
                }
            }
            const tvChannelsWithPrefix = filteredChannels.map((channel: any) => ({
                ...channel,
                id: `tv:${channel.id}`,
                posterShape: "landscape",
                poster: channel.poster || channel.logo || '',
                logo: channel.logo || channel.poster || '',
                background: channel.background || channel.poster || ''
            }));
            return { metas: tvChannelsWithPrefix };
        }
        return { metas: [] };
    });

    // === HANDLER META ===
    builder.defineMetaHandler(async ({ type, id }: { type: string; id: string }) => {
        if (type === "tv") {
            let cleanId = id;
            if (id.startsWith('tv:')) {
                cleanId = id.replace('tv:', '');
            } else if (id.startsWith('tv%3A')) {
                cleanId = id.replace('tv%3A', '');
            } else if (id.includes('%3A')) {
                cleanId = decodeURIComponent(id);
                if (cleanId.startsWith('tv:')) {
                    cleanId = cleanId.replace('tv:', '');
                }
            }
            const channel = tvChannels.find((c: any) => c.id === cleanId);
            if (channel) {
                const metaWithPrefix = {
                    ...channel,
                    id: `tv:${channel.id}`,
                    posterShape: "landscape",
                    poster: channel.poster || channel.logo || '',
                    logo: channel.logo || channel.poster || '',
                    background: channel.background || channel.poster || '',
                    genre: Array.isArray(channel.category) ? channel.category : [channel.category || 'general'],
                    genres: Array.isArray(channel.category) ? channel.category : [channel.category || 'general'],
                    year: new Date().getFullYear().toString(),
                    imdbRating: null,
                    releaseInfo: "Live TV",
                    country: "IT",
                    language: "it"
                };
                return { meta: metaWithPrefix };
            } else {
                return { meta: null };
            }
        }
        // Meta handler per film/serie/anime (VixSrc, AnimeUnity, AnimeSaturn)
        // Qui puoi aggiungere la logica di estrazione meta da VixSrc/Anime se vuoi arricchire i meta
        // Per ora restituisce null (Stremio userà fallback da TMDB/IMDB)
        return { meta: null };
    });

    // === HANDLER STREAM ===
    builder.defineStreamHandler(
        async ({ id, type }: { id: string; type: string }): Promise<{ streams: Stream[] }> => {
            // Logica TV
            if (type === "tv") {
                let cleanId = id;
                if (id.startsWith('tv:')) {
                    cleanId = id.replace('tv:', '');
                } else if (id.startsWith('tv%3A')) {
                    cleanId = id.replace('tv%3A', '');
                } else if (id.includes('%3A')) {
                    cleanId = decodeURIComponent(id);
                    if (cleanId.startsWith('tv:')) {
                        cleanId = cleanId.replace('tv:', '');
                    }
                }
                const channel = tvChannels.find((c: any) => c.id === cleanId);
                if (!channel) return { streams: [] };
                let streams: Stream[] = [];
                if (channel.staticUrl) {
                    streams.push({ url: channel.staticUrl, title: channel.name });
                }
                return { streams };
            }
            // Logica Anime/Film/Serie
            const config = { ...configCache };
            const bothLinkValue = config.bothLinks === 'on';
            const animeUnityEnabled = (config.animeunityEnabled === 'on') || (process.env.ANIMEUNITY_ENABLED?.toLowerCase() === 'true');
            const animeSaturnEnabled = (config.animesaturnEnabled === 'on') || (process.env.ANIMESATURN_ENABLED?.toLowerCase() === 'true');
            // Anime puro (kitsu: mal:)
            if ((id.startsWith('kitsu:') || id.startsWith('mal:')) && (animeUnityEnabled || animeSaturnEnabled)) {
                const animeUnityConfig: AnimeUnityConfig = {
                    enabled: animeUnityEnabled,
                    mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL || '',
                    mfpPassword: config.mediaFlowProxyPassword || process.env.MFP_PSW || '',
                    bothLink: bothLinkValue,
                    tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || ''
                };
                const animeSaturnConfig = {
                    enabled: animeSaturnEnabled,
                    mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL || '',
                    mfpPassword: config.mediaFlowProxyPassword || process.env.MFP_PSW || '',
                    mfpProxyUrl: config.mediaFlowProxyUrl || process.env.MFP_URL || '',
                    mfpProxyPassword: config.mediaFlowProxyPassword || process.env.MFP_PSW || '',
                    bothLink: bothLinkValue,
                    tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || ''
                };
                let allStreams: Stream[] = [];
                // AnimeUnity
                if (animeUnityEnabled) {
                    try {
                        const animeUnityProvider = new AnimeUnityProvider(animeUnityConfig);
                        let animeUnityResult = await animeUnityProvider.handleKitsuRequest(id);
                        if (animeUnityResult && animeUnityResult.streams) {
                            allStreams.push(...animeUnityResult.streams.map(s => ({ ...s, name: 'StreamViX AU' })));
                        }
                    } catch (error) {
                        console.error('AnimeUnity error:', error);
                    }
                }
                // AnimeSaturn
                if (animeSaturnEnabled) {
                    try {
                        const { AnimeSaturnProvider } = await import('./providers/animesaturn-provider');
                        const animeSaturnProvider = new AnimeSaturnProvider(animeSaturnConfig);
                        let animeSaturnResult = await animeSaturnProvider.handleKitsuRequest(id);
                        if (animeSaturnResult && animeSaturnResult.streams) {
                            allStreams.push(...animeSaturnResult.streams.map(s => ({ ...s, name: 'StreamViX AS' })));
                        }
                    } catch (error) {
                        console.error('AnimeSaturn error:', error);
                    }
                }
                if (allStreams.length > 0) {
                    return { streams: allStreams };
                }
                return { streams: [] };
            }
            // Film/Serie (tt..., tmdb:...)
            if ((id.startsWith('tt') || id.startsWith('tmdb:'))) {
                // 1. Prova VixSrc
                const finalConfig: ExtractorConfig = {
                    tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY,
                    mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL,
                    mfpPsw: config.mediaFlowProxyPassword || process.env.MFP_PSW,
                    bothLink: bothLinkValue
                };
                const res: VixCloudStreamInfo[] | null = await getStreamContent(id, type, finalConfig);
                let vixStreams: Stream[] = [];
                if (res) {
                    for (const st of res) {
                        if (st.streamUrl == null) continue;
                        vixStreams.push({
                            title: st.name,
                            name: 'StreamViX Vx',
                            url: st.streamUrl,
                            behaviorHints: {
                                notWebReady: true,
                                headers: { "Referer": st.referer },
                            },
                        });
                    }
                }
                if (vixStreams.length > 0) {
                    return { streams: vixStreams };
                }
                // 2. Se VixSrc non trova nulla, prova AnimeUnity/AnimeSaturn (se abilitati)
                if (animeUnityEnabled || animeSaturnEnabled) {
                    const animeUnityConfig: AnimeUnityConfig = {
                        enabled: animeUnityEnabled,
                        mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL || '',
                        mfpPassword: config.mediaFlowProxyPassword || process.env.MFP_PSW || '',
                        bothLink: bothLinkValue,
                        tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || ''
                    };
                    const animeSaturnConfig = {
                        enabled: animeSaturnEnabled,
                        mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL || '',
                        mfpPassword: config.mediaFlowProxyPassword || process.env.MFP_PSW || '',
                        mfpProxyUrl: config.mediaFlowProxyUrl || process.env.MFP_URL || '',
                        mfpProxyPassword: config.mediaFlowProxyPassword || process.env.MFP_PSW || '',
                        bothLink: bothLinkValue,
                        tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || ''
                    };
                    let allStreams: Stream[] = [];
                    let seasonNumber: number | null = null;
                    let episodeNumber: number | null = null;
                    let isMovie = false;
                    const parts = id.split(':');
                    if (parts.length === 1) {
                        isMovie = true;
                    } else if (parts.length === 2) {
                        episodeNumber = parseInt(parts[1]);
                    } else if (parts.length === 3) {
                        seasonNumber = parseInt(parts[1]);
                        episodeNumber = parseInt(parts[2]);
                    }
                    // AnimeUnity
                    if (animeUnityEnabled) {
                        try {
                            const animeUnityProvider = new AnimeUnityProvider(animeUnityConfig);
                            let animeUnityResult;
                            if (id.startsWith('tt')) {
                                animeUnityResult = await animeUnityProvider.handleImdbRequest(id, seasonNumber, episodeNumber, isMovie);
                            } else if (id.startsWith('tmdb:')) {
                                animeUnityResult = await animeUnityProvider.handleTmdbRequest(id.replace('tmdb:', ''), seasonNumber, episodeNumber, isMovie);
                            }
                            if (animeUnityResult && animeUnityResult.streams) {
                                allStreams.push(...animeUnityResult.streams.map(s => ({ ...s, name: 'StreamViX AU' })));
                            }
                        } catch (error) {
                            console.error('AnimeUnity error:', error);
                        }
                    }
                    // AnimeSaturn
                    if (animeSaturnEnabled) {
                        try {
                            const { AnimeSaturnProvider } = await import('./providers/animesaturn-provider');
                            const animeSaturnProvider = new AnimeSaturnProvider(animeSaturnConfig);
                            let animeSaturnResult;
                            if (id.startsWith('tt')) {
                                animeSaturnResult = await animeSaturnProvider.handleImdbRequest(id, seasonNumber, episodeNumber, isMovie);
                            } else if (id.startsWith('tmdb:')) {
                                animeSaturnResult = await animeSaturnProvider.handleTmdbRequest(id.replace('tmdb:', ''), seasonNumber, episodeNumber, isMovie);
                            }
                            if (animeSaturnResult && animeSaturnResult.streams) {
                                allStreams.push(...animeSaturnResult.streams.map(s => ({ ...s, name: 'StreamViX AS' })));
                            }
                        } catch (error) {
                            console.error('AnimeSaturn error:', error);
                        }
                    }
                    if (allStreams.length > 0) {
                        return { streams: allStreams };
                    }
                }
                return { streams: [] };
            }
            return { streams: [] };
        }
    );

    return builder;
}

// Server Express
const app = express();

app.use('/public', express.static(path.join(__dirname, '..', 'public')));

// ✅ CORRETTO: Annotazioni di tipo esplicite per Express
app.get('/', (_: Request, res: Response) => {
    const manifest = loadCustomConfig();
    const landingHTML = landingTemplate(manifest);
    res.setHeader('Content-Type', 'text/html');
    res.send(landingHTML);
});

// ✅ Middleware semplificato che usa sempre il router globale
app.use((req: Request, res: Response, next: NextFunction) => {
    debugLog(`Incoming request: ${req.method} ${req.path}`);
    debugLog(`Full URL: ${req.url}`);
    debugLog(`Path segments:`, req.path.split('/'));
    
    const configString = req.path.split('/')[1];
    debugLog(`Config string extracted: "${configString}" (length: ${configString ? configString.length : 0})`);
    
    // AGGIORNA SOLO LA CACHE GLOBALE senza ricreare il builder
    if (configString && configString.includes('eyJtZnBQcm94eVVybCI6Imh0dHA6Ly8xOTIuMTY4LjEuMTAwOjkwMDAi')) {
        debugLog('📌 Found known MFP config pattern, updating global cache');
        // Non forzare più nessun valore hardcoded, lascia solo la configurazione fornita
        // Object.assign(configCache, { ... }); // RIMOSSO
    }
    
    // Altri parsing di configurazione (PRIMA della logica TV)
    if (configString && configString.length > 10 && !configString.startsWith('stream') && !configString.startsWith('meta') && !configString.startsWith('manifest')) {
        const parsedConfig = parseConfigFromArgs(configString);
        if (Object.keys(parsedConfig).length > 0) {
            debugLog('� Found valid config in URL, updating global cache');
            Object.assign(configCache, parsedConfig);
            debugLog('� Updated global config cache:', configCache);
        }
    }
    
    // Per le richieste di stream TV, assicurati che la configurazione proxy sia sempre presente
    if (req.url.includes('/stream/tv/') || req.url.includes('/stream/tv%3A')) {
        debugLog('📺 TV Stream request detected, ensuring MFP configuration');
        // Non applicare più nessun fallback hardcoded
        // if (!configCache.mfpProxyUrl || !configCache.mfpProxyPassword) { ... } // RIMOSSO
        debugLog('📺 Current proxy config for TV streams:', configCache);
    }
    
    // Altri parsing di configurazione
    if (configString && configString.length > 10 && !configString.startsWith('stream') && !configString.startsWith('meta') && !configString.startsWith('manifest')) {
        const parsedConfig = parseConfigFromArgs(configString);
        if (Object.keys(parsedConfig).length > 0) {
            debugLog('� Found valid config in URL, updating global cache');
            Object.assign(configCache, parsedConfig);
            debugLog('� Updated global config cache:', configCache);
        }
    }
    
    // ✅ Inizializza il router globale se non è ancora stato fatto
    if (!globalRouter) {
        console.log('🔧 Initializing global router...');
        globalBuilder = createBuilder(configCache);
        globalAddonInterface = globalBuilder.getInterface();
        globalRouter = getRouter(globalAddonInterface);
        console.log('✅ Global router initialized');
    }
    
    // USA SEMPRE il router globale
    globalRouter(req, res, next);
});


// Catalog handler
// RIMOSSO: tutti i blocchi builder.defineCatalogHandler, builder.defineMetaHandler, builder.defineStreamHandler fuori da createBuilder

// Meta handler
// RIMOSSO: tutti i blocchi builder.defineCatalogHandler, builder.defineMetaHandler, builder.defineStreamHandler fuori da createBuilder

// Stream handler
// RIMOSSO: tutti i blocchi builder.defineCatalogHandler, builder.defineMetaHandler, builder.defineStreamHandler fuori da createBuilder

const PORT = process.env.PORT || 7860;
app.listen(PORT, () => {
    console.log(`Addon server running on http://127.0.0.1:${PORT}`);
});

// Funzione per assicurarsi che le directory di cache esistano
function ensureCacheDirectories(): void {
    try {
        // Directory per la cache Vavoo
        const cacheDir = path.join(__dirname, '../cache');
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
            console.log(`📁 Directory cache creata: ${cacheDir}`);
        }
    } catch (error) {
        console.error('❌ Errore nella creazione delle directory di cache:', error);
    }
}

// Assicurati che le directory di cache esistano all'avvio
ensureCacheDirectories();
