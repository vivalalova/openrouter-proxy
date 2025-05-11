/**
 * OpenRouter API 代理
 * 代理請求到 OpenRouter API 並輪換 API 金鑰以繞過速率限制
 */

import express from 'express';
import cors from 'cors';
import { Application } from 'express';
import { config, logger } from './config';
import { router } from './routes';
import { getLocalIp } from './utils';

// 建立 Express 應用
const app: Application = express();

// 使用 JSON 中間件
app.use(express.json());

// 啟用 CORS
app.use(cors());

// 使用路由
app.use('/', router);

// 啟動伺服器
const host = config.server.host;
const port = config.server.port;
const server = app.listen(port, host, () => {
  // 如果主機是 0.0.0.0，則使用實際本地 IP 顯示
  const displayHost = host === '0.0.0.0' ? getLocalIp() : host;

  logger.info(`啟動 OpenRouter 代理在 ${host}:${port}`);
  logger.info(`API URL: http://${displayHost}:${port}/api/v1`);
  logger.info(`健康檢查: http://${displayHost}:${port}/health`);
});

// 優雅關閉
process.on('SIGTERM', () => {
  logger.info('收到 SIGTERM 信號，正在關閉...');
  server.close(() => {
    logger.info('伺服器已關閉');
    process.exit(0);
  });

  // 30 秒超時強制關閉
  setTimeout(() => {
    logger.error('強制關閉：30 秒超時已到');
    process.exit(1);
  }, 30000);
});

export default app;
