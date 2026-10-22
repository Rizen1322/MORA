import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

const cfg = loadConfig();
const loopback = cfg.host === '127.0.0.1' || cfg.host === 'localhost' || cfg.host === '::1';
if (!loopback && !cfg.accessToken) {
  console.error('Отказ запуска: HOST открыт в сеть, но ACCESS_TOKEN не задан. Задайте ACCESS_TOKEN в .env или используйте HOST=127.0.0.1.');
  process.exit(1);
}

const { app, services, close } = await createApp({}, { logger: process.env.LOG_REQUESTS === '1' });
if (!services.ffmpegVersion) {
  console.warn('ВНИМАНИЕ: ffmpeg не найден. Установите ffmpeg или задайте FFMPEG_PATH и FFPROBE_PATH в .env — без него импорт и воспроизведение не работают.');
}
await app.listen({ host: cfg.host, port: cfg.port });
const url = `http://${loopback ? 'localhost' : cfg.host}:${cfg.port}`;
console.log(`AutoMix запущен: ${url}`);
console.log(`Данные: ${cfg.dataDir}`);
if (!loopback) console.log('Доступ из сети открыт. Первый вход: добавьте ?token=<ACCESS_TOKEN> к адресу.');

const shutdown = async () => {
  await close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
