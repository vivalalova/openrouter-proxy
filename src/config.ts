/**
 * 配置模組
 * 從 YAML 檔案載入設定並初始化日誌功能
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import winston from 'winston';
import { CONFIG_FILE } from './constants';

// 配置介面定義
export interface Config {
  server: {
    host: string;
    port: number;
    log_level: string;
    http_log_level?: string;
  };
  openrouter: {
    base_url: string;
    public_endpoints: string[];
    keys: string[];
    rate_limit_cooldown: number;
    free_only: boolean;
    google_rate_delay: number;
  };
  request_proxy: {
    enabled: boolean;
    url: string;
  };
  access: {
    key: string;
  };
}

// 載入配置
export function loadConfig(): Config {
  try {
    const configPath = path.resolve(process.cwd(), CONFIG_FILE);
    const fileContents = fs.readFileSync(configPath, 'utf8');
    return yaml.load(fileContents) as Config;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      console.error(`配置檔案 ${CONFIG_FILE} 未找到。請基於 config.example.yml 創建該檔案。`);
      process.exit(1);
    }
    console.error(`解析配置檔案時出錯：${error}`);
    process.exit(1);
  }
}

// 創建 Winston 日誌記錄器
export function setupLogging(config: Config): winston.Logger {
  const logLevel = config.server.log_level || 'info';

  const logger = winston.createLogger({
    level: logLevel,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.printf(({ timestamp, level, message }) => {
        return `${timestamp} - ${level.toUpperCase()} - ${message}`;
      })
    ),
    transports: [
      new winston.transports.Console()
    ]
  });

  logger.info(`日誌級別設定為 ${logLevel}`);

  return logger;
}

// 標準化和驗證配置
export function normalizeAndValidateConfig(config: Config, logger: winston.Logger): void {
  // --- OpenRouter 部分 ---
  if (!config.openrouter) {
    logger.warn("配置檔案中缺少 'openrouter' 或無效。使用預設值。");
    config.openrouter = {} as any;
  }

  // 設定基礎 URL
  const defaultBaseUrl = "https://openrouter.ai/api/v1";
  if (typeof config.openrouter.base_url !== 'string') {
    logger.warn(
      `配置檔案中缺少 'openrouter.base_url' 或無效。使用預設值: ${defaultBaseUrl}`
    );
    config.openrouter.base_url = defaultBaseUrl;
  }
  // 移除尾部斜線
  config.openrouter.base_url = config.openrouter.base_url.replace(/\/+$/, '');

  // 設定公共端點
  const defaultPublicEndpoints = ["/api/v1/models"];
  if (!Array.isArray(config.openrouter.public_endpoints)) {
    logger.warn(
      `配置檔案中缺少 'openrouter.public_endpoints' 或無效。使用預設值: ${defaultPublicEndpoints}`
    );
    config.openrouter.public_endpoints = defaultPublicEndpoints;
  } else {
    const validatedEndpoints: string[] = [];
    for (let i = 0; i < config.openrouter.public_endpoints.length; i++) {
      const endpoint = config.openrouter.public_endpoints[i];
      if (typeof endpoint !== 'string') {
        logger.warn(`'openrouter.public_endpoints' 中的項目 ${i} 不是字串。跳過。`);
        continue;
      }
      if (!endpoint) {
        logger.warn(`'openrouter.public_endpoints' 中的項目 ${i} 為空。跳過。`);
        continue;
      }
      // 確保起始斜線
      if (!endpoint.startsWith('/')) {
        validatedEndpoints.push('/' + endpoint);
      } else {
        validatedEndpoints.push(endpoint);
      }
    }
    config.openrouter.public_endpoints = validatedEndpoints;
  }

  // 檢查 API 金鑰
  if (!Array.isArray(config.openrouter.keys)) {
    logger.warn("配置檔案中缺少 'openrouter.keys' 或無效。使用空列表。");
    config.openrouter.keys = [];
  }
  if (config.openrouter.keys.length === 0) {
    logger.warn(
      "配置檔案中 'openrouter.keys' 列表為空。代理在需要驗證的端點上無法運作。"
    );
  }

  // 其他配置
  if (typeof config.openrouter.free_only !== 'boolean') {
    const defaultFreeOnly = false;
    logger.warn(
      `配置檔案中缺少 'openrouter.free_only' 或無效。使用預設值: ${defaultFreeOnly}`
    );
    config.openrouter.free_only = defaultFreeOnly;
  }

  if (typeof config.openrouter.google_rate_delay !== 'number') {
    const defaultGoogleRateDelay = 0;
    logger.warn(
      `配置檔案中缺少 'openrouter.google_rate_delay' 或無效。使用預設值: ${defaultGoogleRateDelay}`
    );
    config.openrouter.google_rate_delay = defaultGoogleRateDelay;
  }

  if (typeof config.openrouter.rate_limit_cooldown !== 'number') {
    const defaultRateLimitCooldown = 60;
    logger.warn(
      `配置檔案中缺少 'openrouter.rate_limit_cooldown' 或無效。使用預設值: ${defaultRateLimitCooldown}`
    );
    config.openrouter.rate_limit_cooldown = defaultRateLimitCooldown;
  }

  // --- 請求代理部分 ---
  if (!config.request_proxy) {
    logger.warn("配置檔案中缺少 'request_proxy' 或無效。使用預設值。");
    config.request_proxy = {} as any;
  }

  const defaultProxyEnabled = false;
  if (typeof config.request_proxy.enabled !== 'boolean') {
    logger.warn(
      `配置檔案中缺少 'request_proxy.enabled' 或無效。使用預設值: ${defaultProxyEnabled}`
    );
    config.request_proxy.enabled = defaultProxyEnabled;
  }

  const defaultProxyUrl = "";
  if (typeof config.request_proxy.url !== 'string') {
    logger.warn(
      `配置檔案中缺少 'request_proxy.url' 或無效。使用預設值: '${defaultProxyUrl}'`
    );
    config.request_proxy.url = defaultProxyUrl;
  }

  // --- 伺服器部分 ---
  if (!config.server) {
    logger.warn("配置檔案中缺少 'server' 或無效。使用預設值。");
    config.server = {} as any;
  }

  const defaultHost = "0.0.0.0";
  if (typeof config.server.host !== 'string') {
    logger.warn(
      `配置檔案中缺少 'server.host' 或無效。使用預設值: ${defaultHost}`
    );
    config.server.host = defaultHost;
  }

  const defaultPort = 8080;
  if (typeof config.server.port !== 'number') {
    logger.warn(
      `配置檔案中缺少 'server.port' 或無效。使用預設值: ${defaultPort}`
    );
    config.server.port = defaultPort;
  }

  // --- 存取控制部分 ---
  if (!config.access) {
    logger.warn("配置檔案中缺少 'access' 或無效。使用預設值。");
    config.access = {} as any;
  }

  const defaultAccessKey = "";
  if (typeof config.access.key !== 'string') {
    logger.warn(
      `配置檔案中缺少 'access.key' 或無效。使用預設值: '${defaultAccessKey}'`
    );
    config.access.key = defaultAccessKey;
  }
}

// 載入配置
const config = loadConfig();

// 初始化日誌
const logger = setupLogging(config);

// 標準化和驗證配置
normalizeAndValidateConfig(config, logger);

export { config, logger };
