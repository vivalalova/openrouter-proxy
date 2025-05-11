/**
 * 實用工具函數
 */

import os from 'os';
import { Request } from 'express';
import { config, logger } from './config';

/**
 * 獲取本地 IP 地址
 */
export function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    const iface = interfaces[devName];
    if (!iface) continue;

    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * 驗證訪問金鑰
 */
export function verifyAccessKey(authorization?: string): boolean {
  const accessKey = config.access.key;

  // 如果未配置訪問金鑰，則允許無限制訪問
  if (!accessKey) {
    return true;
  }

  // 檢查 Authorization 標頭
  if (!authorization) {
    throw new Error('缺少授權標頭');
  }

  // 提取 Bearer token
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  if (!match) {
    throw new Error('無效的授權標頭格式');
  }

  const token = match[1];
  if (token !== accessKey) {
    throw new Error('無效的訪問金鑰');
  }

  return true;
}

/**
 * 檢查速率限制（從響應字符串中）
 * @returns [是否有速率限制錯誤, 重置時間（如果有）]
 */
export function checkRateLimit(body: string | Buffer): [boolean, number | undefined] {
  try {
    let bodyObj;
    if (Buffer.isBuffer(body)) {
      bodyObj = JSON.parse(body.toString());
    } else {
      bodyObj = JSON.parse(body);
    }

    // 檢查是否有速率限制錯誤
    if (
      bodyObj.error &&
      (
        // 檢查明確的速率限制錯誤類型
        (typeof bodyObj.error === 'object' &&
         (bodyObj.error.type === 'rate_limit_exceeded' ||
          bodyObj.error.code === 'rate_limit_exceeded')) ||
        // 檢查錯誤消息中是否包含速率限制相關的關鍵詞
        (typeof bodyObj.error === 'string' &&
         (bodyObj.error.includes('rate limit') ||
          bodyObj.error.includes('rate_limit') ||
          bodyObj.error.includes('too many requests')))
      )
    ) {
      logger.warn('發現速率限制錯誤');

      // 嘗試從錯誤中提取重置時間
      let resetTimeMs;

      // 檢查 headers 屬性
      if (bodyObj.error && bodyObj.error.headers) {
        resetTimeMs = bodyObj.error.headers['x-ratelimit-reset-requests'] ||
                      bodyObj.error.headers['x-ratelimit-reset-tokens'] ||
                      bodyObj.error.headers['x-ratelimit-reset'] ||
                      undefined;
      }

      // 檢查頂層 headers
      if (!resetTimeMs && bodyObj.headers) {
        resetTimeMs = bodyObj.headers['x-ratelimit-reset-requests'] ||
                      bodyObj.headers['x-ratelimit-reset-tokens'] ||
                      bodyObj.headers['x-ratelimit-reset'] ||
                      undefined;
      }

      if (resetTimeMs) {
        return [true, parseInt(resetTimeMs, 10)];
      }

      return [true, undefined];
    }
  } catch (e) {
    logger.debug(`無法解析響應主體：${e}`);
  }

  return [false, undefined];
}

/**
 * 移除付費模型（如果配置了只顯示免費模型）
 */
export function removePaidModels(body: Buffer): Buffer {
  if (!config.openrouter.free_only) {
    return body;
  }

  const prices = ['prompt', 'completion', 'request', 'image', 'web_search', 'internal_reasoning'];

  try {
    const data = JSON.parse(body.toString());

    if (Array.isArray(data.data)) {
      const clearData = [];

      for (const model of data.data) {
        if (model.pricing &&
            prices.every(k => model.pricing[k] === '0')) {
          clearData.push(model);
        }
      }

      if (clearData.length > 0) {
        data.data = clearData;
        return Buffer.from(JSON.stringify(data), 'utf-8');
      }
    }
  } catch (e) {
    logger.warn(`解析模型數據時出錯：${e}`);
  }

  return body;
}

/**
 * 準備轉發標頭
 */
export function prepareForwardHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(request.headers)) {
    const lowerKey = key.toLowerCase();

    // 排除一些不需要轉發的標頭
    if (
      lowerKey !== 'host' &&
      lowerKey !== 'content-length' &&
      lowerKey !== 'connection' &&
      lowerKey !== 'authorization'
    ) {
      if (typeof value === 'string') {
        headers[key] = value;
      } else if (Array.isArray(value) && value.length > 0) {
        headers[key] = value[0];
      }
    }
  }

  return headers;
}
