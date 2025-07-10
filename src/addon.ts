import { addonBuilder, getRouter, Manifest, Stream } from "stremio-addon-sdk";
import { getStreamContent, VixCloudStreamInfo, ExtractorConfig } from "./extractor";
import * as fs from 'fs';
import { landingTemplate } from './landingPage';
import * as path from 'path';
import express, { Request, Response, NextFunction } from 'express'; // ✅ CORRETTO: Import tipizzato
import { AnimeUnityProvider } from './providers/animeunity-provider';
import { KitsuProvider } from './providers/kitsu'; 
import { formatMediaFlowUrl } from './utils/mediaflow';
import { AnimeUnityConfig } from "./types/animeunity";
import { EPGManager } from './utils/epg';
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as util from 'util';

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

// === PATCH: EPG opzionale ===
// Leggi il flag epg dalla query string e passalo a createBuilder
let epgFlagFromQuery = true; // default: EPG abilitato

// Server Express
const app = express();

app.use('/public', express.static(path.join(__dirname, '..', 'public')));

app.get('/', (_: Request, res: Response) => {
    const manifest = loadCustomConfig();
    const landingHTML = landingTemplate(manifest);
    res.setHeader('Content-Type', 'text/html');
    res.send(landingHTML);
});

app.use((req: Request, res: Response, next: NextFunction) => {
    // Leggi il flag epg dalla query string (?epg=0 per disabilitare)
    const urlParams = new URLSearchParams(req.url.split('?')[1] || '');
    epgFlagFromQuery = urlParams.get('epg') !== '0';
    debugLog(`[EPG FLAG] epgFlagFromQuery: ${epgFlagFromQuery}`);

    // ... esattamente come la middleware originale ...
    debugLog(`Incoming request: ${req.method} ${req.path}`);
    debugLog(`Full URL: ${req.url}`);
    debugLog(`Path segments:`, req.path.split('/'));
    const configString = req.path.split('/')[1];
    debugLog(`Config string extracted: "${configString}" (length: ${configString ? configString.length : 0})`);
    if (configString && configString.includes('eyJtZnBQcm94eVVybCI6Imh0dHA6Ly8xOTIuMTY4LjEuMTAwOjkwMDAi')) {
        debugLog('📌 Found known MFP config pattern, updating global cache');
    }
    if (configString && configString.length > 10 && !configString.startsWith('stream') && !configString.startsWith('meta') && !configString.startsWith('manifest')) {
        const parsedConfig = parseConfigFromArgs(configString);
        if (Object.keys(parsedConfig).length > 0) {
            debugLog(' Found valid config in URL, updating global cache');
            Object.assign(configCache, parsedConfig);
            debugLog(' Updated global config cache:', configCache);
        }
    }
    if (req.url.includes('/stream/tv/') || req.url.includes('/stream/tv%3A')) {
        debugLog('📺 TV Stream request detected, ensuring MFP configuration');
        debugLog('📺 Current proxy config for TV streams:', configCache);
    }
    if (configString && configString.length > 10 && !configString.startsWith('stream') && !configString.startsWith('meta') && !configString.startsWith('manifest')) {
        const parsedConfig = parseConfigFromArgs(configString);
        if (Object.keys(parsedConfig).length > 0) {
            debugLog(' Found valid config in URL, updating global cache');
            Object.assign(configCache, parsedConfig);
            debugLog(' Updated global config cache:', configCache);
        }
    }
    // Inizializza il router globale se non è ancora stato fatto
    if (!globalRouter) {
        console.log('🔧 Initializing global router...');
        globalBuilder = createBuilder(configCache, epgFlagFromQuery); // PATCH: passa il flag
        globalAddonInterface = globalBuilder.getInterface();
        globalRouter = getRouter(globalAddonInterface);
        console.log('✅ Global router initialized');
    }
    globalRouter(req, res, next);
});

const PORT = process.env.PORT || 7860;
app.listen(PORT, () => {
    console.log(`Addon server running on http://127.0.0.1:${PORT}`);
});

// PATCH: Modifica createBuilder per accettare il flag epgEnabled
function createBuilder(initialConfig: AddonConfig = {}, epgEnabled: boolean = true) {
    const manifest = loadCustomConfig();
    if (initialConfig.mediaFlowProxyUrl || initialConfig.bothLinks || initialConfig.tmdbApiKey) {
        manifest.name;
    }
    const builder = new addonBuilder(manifest);
    // ...
    // === HANDLER CATALOGO TV ===
    builder.defineCatalogHandler(async ({ type, id, extra }: { type: string; id: string; extra?: any }) => {
        // ...
        // PATCH: EPG opzionale
        const tvChannelsWithPrefix = await Promise.all(filteredChannels.map(async (channel: any) => {
            const channelWithPrefix = {
                ...channel,
                id: `tv:${channel.id}`,
                posterShape: "landscape",
                poster: (channel as any).poster || (channel as any).logo || '',
                logo: (channel as any).logo || (channel as any).poster || '',
                background: (channel as any).background || (channel as any).poster || ''
            };
            // PATCH: Solo se epgEnabled
            if (epgEnabled && epgManager) {
                try {
                    const epgChannelIds = (channel as any).epgChannelIds;
                    const epgChannelId = epgManager.findEPGChannelId(channel.name, epgChannelIds);
                    if (epgChannelId) {
                        const currentProgram = await epgManager.getCurrentProgram(epgChannelId);
                        if (currentProgram) {
                            const startTime = epgManager.formatTime(currentProgram.start);
                            const endTime = currentProgram.stop ? epgManager.formatTime(currentProgram.stop) : '';
                            const epgInfo = `🔴 ORA: ${currentProgram.title} (${startTime}${endTime ? `-${endTime}` : ''})`;
                            channelWithPrefix.description = `${channel.description || ''}\n\n${epgInfo}`;
                        }
                    }
                } catch (epgError) {
                    console.error(`❌ Catalog: EPG error for ${channel.name}:`, epgError);
                }
            }
            return channelWithPrefix;
        }));
        // ...
        return { metas: tvChannelsWithPrefix };
    });
    // === HANDLER META ===
    builder.defineMetaHandler(async ({ type, id }: { type: string; id: string }) => {
        // ...
        if (type === "tv") {
            // ...
            const channel = tvChannels.find((c: any) => c.id === cleanId);
            if (channel) {
                // ...
                // PATCH: Solo se epgEnabled
                if (epgEnabled && epgManager) {
                    try {
                        const epgChannelIds = (channel as any).epgChannelIds;
                        const epgChannelId = epgManager.findEPGChannelId(channel.name, epgChannelIds);
                        if (epgChannelId) {
                            const currentProgram = await epgManager.getCurrentProgram(epgChannelId);
                            const nextProgram = await epgManager.getNextProgram(epgChannelId);
                            let epgDescription = channel.description || '';
                            if (currentProgram) {
                                const startTime = epgManager.formatTime(currentProgram.start);
                                const endTime = currentProgram.stop ? epgManager.formatTime(currentProgram.stop) : '';
                                epgDescription += `\n\n🔴 IN ONDA ORA (${startTime}${endTime ? `-${endTime}` : ''}): ${currentProgram.title}`;
                                if (currentProgram.description) {
                                    epgDescription += `\n${currentProgram.description}`;
                                }
                            }
                            if (nextProgram) {
                                const nextStartTime = epgManager.formatTime(nextProgram.start);
                                const nextEndTime = nextProgram.stop ? epgManager.formatTime(nextProgram.stop) : '';
                                epgDescription += `\n\n⏭️ A SEGUIRE (${nextStartTime}${nextEndTime ? `-${nextEndTime}` : ''}): ${nextProgram.title}`;
                                if (nextProgram.description) {
                                    epgDescription += `\n${nextProgram.description}`;
                                }
                            }
                            metaWithPrefix.description = epgDescription;
                        }
                    } catch (epgError) {
                        console.error(`❌ Meta: EPG error for ${channel.name}:`, epgError);
                    }
                }
                return { meta: metaWithPrefix };
            } else {
                return { meta: null };
            }
        }
        return { meta: null };
    });
    // ...
    return builder;
} 
