import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { AnalysisService } from './analysis.ts';
import { AutoMixService, getSettings } from './automix.ts';
import { ensureDirs, loadConfig, type AppConfig } from './config.ts';
import { kvGet, kvSet, openDb, type Db } from './db.ts';
import { EventHub } from './events.ts';
import { FfmpegTools } from './ffmpeg.ts';
import { Library } from './library.ts';
import { PcmCache } from './pcmCache.ts';
import { ProviderRegistry } from './providers/index.ts';
import { registerLibraryRoutes } from './routes/library.ts';
import { registerPlaybackRoutes } from './routes/playback.ts';
import { registerPreviewRoutes } from './routes/preview.ts';
import { registerMiscRoutes } from './routes/misc.ts';
import { registerCatalogRoutes } from './routes/catalog.ts';
import { registerPublicCatalogRoutes } from './routes/public-catalog.ts';
import { registerSoundCloudCatalogRoutes } from './routes/soundcloud-catalog.ts';
import { registerBackupRoutes } from './routes/backup.ts';
import { WaveService } from './wave.ts';
import { StemService } from './stems.ts';
import { YandexReactionSync } from './yandex-reactions.ts';
import { PublicMusic } from './public/provider.ts';
import { YtDlp } from './public/ytdlp.ts';
import { registerSearchRoutes } from './routes/search.ts';
import { registerLyricsRoutes } from './routes/lyrics.ts';
import { registerDownloadRoutes } from './routes/downloads.ts';
import { Downloads } from './public/downloads.ts';
import { Imports } from './public/imports.ts';
import { registerImportRoutes } from './routes/imports.ts';
import { YandexLikesImport } from './yandex-likes-import.ts';
import { registerYandexLikesImportRoutes } from './routes/yandex-likes-import.ts';

export interface Services {
  cfg: AppConfig;
  db: Db;
  events: EventHub;
  ff: FfmpegTools;
  lib: Library;
  pcm: PcmCache;
  analysis: AnalysisService;
  automix: AutoMixService;
  wave: WaveService;
  providers: ProviderRegistry;
  stems: StemService;
  ffmpegVersion: string | null;
  yandexReactions: YandexReactionSync;
  publicMusic: PublicMusic;
  downloads: Downloads;
  imports: Imports;
  yandexLikesImport: YandexLikesImport;
}

/** Strips credentials from URLs before they reach logs. */
function redactUrl(url: string): string {
  return url.replace(/([?&](token|t|s|p|password|client_id|clientId)=)[^&]*/gi, '$1***');
}

export async function createApp(overrides: Partial<AppConfig> = {}, opts: { logger?: boolean; startWorkers?: boolean } = {}): Promise<{ app: FastifyInstance; services: Services; close: () => Promise<void> }> {
  const cfg = loadConfig(overrides);
  ensureDirs(cfg);
  const db = openDb(cfg.dataDir);
  const events = new EventHub();
  const ff = new FfmpegTools(cfg.ffmpeg, cfg.ffprobe);
  const ffmpegVersion = await ff.version();
  const lib = new Library(db, cfg, ff, events);
  const ytdlp = new YtDlp({ bin: cfg.ytdlp, jsRuntime: cfg.ytdlpJsRuntime, runtimeIsElectron: cfg.ytdlpRuntimeIsElectron,
    ffmpegDir: path.isAbsolute(cfg.ffmpeg) ? path.dirname(cfg.ffmpeg) : null, cacheDir: path.join(cfg.dataDir, 'cache', 'yt-dlp'), concurrency: 2, proxies: cfg.publicProxies });
  const publicMusic = new PublicMusic(db, lib, ff, cfg, ytdlp);
  const providers = new ProviderRegistry(db, cfg, lib, publicMusic);
  const downloads = new Downloads(db, lib, publicMusic, events, cfg);
  const imports = new Imports(db, lib, publicMusic, ytdlp, events);
  const pcm = new PcmCache(cfg, ff);
  const analysis = new AnalysisService(db, cfg, lib, events);
  const stems = new StemService(cfg,lib,events);
  const yandexReactions = new YandexReactionSync(db, lib, providers.yandex, events);
  const yandexLikesImport = new YandexLikesImport(db, lib, providers.yandex, events);
  providers.yandex.onReactionConnectionChanged = () => yandexReactions.connectionChanged();
  providers.yandex.localReactionFor = (externalId) => yandexReactions.valueForExternal(externalId);
  providers.yandex.catalog.reactionReader = () => providers.yandex.readReactions();
  providers.yandex.catalog.cachedReactionFor = (externalId) => providers.yandex.cachedReactionFor(externalId);
  providers.yandex.catalog.localReactionFor = providers.yandex.localReactionFor;
  lib.reactionSyncFor = (trackId) => yandexReactions.status(trackId);
  lib.displayReactionFor = (trackId, local) => yandexReactions.displayReaction(trackId, local);
  analysis.vocalActivityFor=(hash)=>stems.activity(hash);
  analysis.setPower({ onlyWhenIdle: getSettings(db).analysis.onlyWhenIdle });
  lib.onTrackAdded = (t) => {analysis.ensure(t, 5);yandexReactions.attachTrack(t.id);};
  const automix = new AutoMixService(db, lib, analysis);
  const wave = new WaveService(db, lib, analysis);
  // Without a vocal model the switch has nothing to prepare; "off" would only disable phrasing, loops
  // and master tempo, which work without stems, and the switch is hidden then.
  if (!cfg.stemsPython) {
    const now = kvGet<{ automix?: Record<string, unknown> }>(db, 'settings', {});
    if (now.automix?.stemMixing === false) kvSet(db, 'settings', { ...now, automix: { ...now.automix, stemMixing: true } });
  }
  const services: Services = { cfg, db, events, ff, lib, pcm, analysis, automix, wave, providers, stems, ffmpegVersion, yandexReactions, publicMusic, downloads, imports, yandexLikesImport };

  const app = Fastify({
    logger: opts.logger
      ? {
          level: 'info',
          serializers: {
            req: (req) => ({ method: req.method, url: redactUrl(req.url) }),
          },
        }
      : false,
    bodyLimit: 4 * 1024 * 1024,
    // Event streams never end on their own; without this close() waits for them forever.
    forceCloseConnections: true,
  });

  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });

  // Other web pages and DNS-rebound names must not drive the local API.
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(cfg.host);
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host ?? '';
    if (loopback && host && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return reply.code(421).send({ error: 'недопустимый адрес' });
    const origin = req.headers.origin;
    if (!origin || !req.url.startsWith('/api/')) return;
    let same = false;
    try { same = new URL(origin).host === host; } catch { /* malformed or "null" origin */ }
    if (!same) return reply.code(403).send({ error: 'запрос с чужой страницы отклонён' });
  });

  if (cfg.accessToken) {
    const token = cfg.accessToken;
    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/api/')) return;
      const cookie = /(?:^|;\s*)am_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      const header = req.headers['x-access-token'];
      const query = (req.query as Record<string, string> | undefined)?.token;
      if (cookie === token || header === token) return;
      if (query === token) {
        reply.header('Set-Cookie', `am_token=${token}; HttpOnly; SameSite=Strict; Path=/`);
        return;
      }
      reply.code(401).send({ error: 'Нужен токен доступа (ACCESS_TOKEN)' });
    });
  }

  registerLibraryRoutes(app, services);
  registerPlaybackRoutes(app, services);
  registerPreviewRoutes(app, services);
  registerMiscRoutes(app, services);
  registerCatalogRoutes(app, services);
  registerPublicCatalogRoutes(app, services);
  registerSoundCloudCatalogRoutes(app, services);
  registerBackupRoutes(app, services);
  registerSearchRoutes(app, services);
  registerLyricsRoutes(app, services);
  registerDownloadRoutes(app, services);
  registerImportRoutes(app, services);
  registerYandexLikesImportRoutes(app, services);

  if (fs.existsSync(path.join(cfg.webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: cfg.webDist, prefix: '/', index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'не найдено' });
      return reply.type('text/html').sendFile('index.html');
    });
  }

  await lib.verifySources();
  if (opts.startWorkers !== false) {analysis.start();stems.start();downloads.start();imports.start();}
  yandexReactions.start();

  const timers = [
    setInterval(() => events.heartbeat(), 20000),
    setInterval(() => { pcm.reapStale(); void pcm.evict().catch(() => {}); }, 30000),
  ];

  const close = async () => {
    for (const t of timers) clearInterval(t);
    await yandexLikesImport.stop();
    const stoppedDownloads = downloads.stop();
    await publicMusic.stop();
    await stoppedDownloads;
    await yandexReactions.stop();
    pcm.shutdown();
    stems.stop();
    await analysis.stop();
    await app.close();
    db.close();
  };
  return { app, services, close };
}
