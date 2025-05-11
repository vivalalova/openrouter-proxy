/**
 * OpenRouter API 代理的路由處理
 */

import { Request, Response, Router, NextFunction } from 'express';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { Readable } from 'stream';
import OpenAI from 'openai';

import { config, logger } from './config';
import { KeyManager } from './keyManager';
import {
  verifyAccessKey,
  checkRateLimit,
  removePaidModels,
  prepareForwardHeaders
} from './utils';
import { COMPLETION_ENDPOINTS, MODELS_ENDPOINTS, OPENAI_ENDPOINTS } from './constants';

// 初始化金鑰管理器
const keyManager = new KeyManager(
  config.openrouter.keys,
  config.openrouter.rate_limit_cooldown
);

// 建立 Express 路由器
export const router: Router = Router();

// 建立 HTTP 客戶端
const createAxiosClient = () => {
  const clientOptions: AxiosRequestConfig = {
    timeout: 60000, // 60秒超時
  };

  // 如果啟用了代理，添加代理配置
  if (config.request_proxy.enabled && config.request_proxy.url) {
    clientOptions.proxy = {
      protocol: config.request_proxy.url.startsWith('https') ? 'https' : 'http',
      host: new URL(config.request_proxy.url).hostname,
      port: parseInt(new URL(config.request_proxy.url).port, 10) ||
           (config.request_proxy.url.startsWith('https') ? 443 : 80),
    };
    logger.info(`使用代理進行 HTTP 請求: ${config.request_proxy.url}`);
  }

  return axios.create(clientOptions);
};

// 建立 HTTP 客戶端
const httpClient = createAxiosClient();

/**
 * 取得 OpenAI 客戶端
 */
function getOpenAIClient(apiKey: string): OpenAI {
  return new OpenAI({
    apiKey: apiKey,
    baseURL: config.openrouter.base_url,
  });
}

/**
 * 主要代理端點，處理所有到 OpenRouter API 的請求
 */
router.all('/api/v1/*', async (req: Request, res: Response) => {
  const path = req.params[0] || '';
  const authorization = req.headers.authorization as string | undefined;

  // 檢查是否為公共端點
  const isPublic = config.openrouter.public_endpoints.some(ep =>
    `/api/v1/${path}`.startsWith(ep)
  );

  // 檢查是否為完成端點
  const isCompletion = COMPLETION_ENDPOINTS.some(ep =>
    `/api/v1/${path}`.startsWith(ep)
  );

  // 檢查是否為 OpenAI 端點
  const isOpenAI = OPENAI_ENDPOINTS.some(ep =>
    `/api/v1/${path}`.startsWith(ep)
  );

  // 檢查是否為模型列表端點
  const isModels = MODELS_ENDPOINTS.some(ep =>
    `/api/v1/${path}`.startsWith(ep)
  );

  // 非公共端點需要驗證
  if (!isPublic) {
    try {
      verifyAccessKey(authorization);
    } catch (error) {
      const message = error instanceof Error ? error.message : '未授權';
      return res.status(401).json({ error: message });
    }
  }

  // 記錄請求詳情
  logger.info(
    `代理請求到 ${req.url} (公共: ${isPublic}, 完成: ${isCompletion}, OpenAI: ${isOpenAI})`
  );

  // 取得 API 金鑰
  let apiKey: string;
  try {
    if (isPublic) {
      apiKey = '';
    } else {
      logger.info(`準備取得 API 金鑰處理請求 ${req.url}`);
      const requestStartTime = Date.now();
      apiKey = await keyManager.getNextKey();
      const requestEndTime = Date.now();
      const waitTime = requestEndTime - requestStartTime;

      if (waitTime > 1000) { // 如果等待時間超過1秒，表示可能有等待金鑰冷卻
        logger.info(`請求 ${req.url} 等待了 ${waitTime/1000} 秒直到有可用金鑰`);
      }

      if (!apiKey) {
        return res.status(503).json({ error: '目前沒有可用的 API 金鑰' });
      }
      logger.info(`成功取得 API 金鑰，繼續處理請求 ${req.url}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '無可用金鑰';
    return res.status(503).json({ error: message });
  }

  // 解析請求主體
  let requestBody: any = undefined;
  let isStream = false;

  try {
    if (req.body && Object.keys(req.body).length > 0) {
      requestBody = req.body;
      isStream = Boolean(requestBody.stream);

      // 檢查模型
      if (isOpenAI && req.method === 'POST' && requestBody.model) {
        logger.info(`使用模型: ${requestBody.model}`);
      }
    }
  } catch (e) {
    logger.debug(`無法解析請求主體: ${e}`);
  }

  if (isStream) {
    logger.info('檢測到流式請求');
  }

  try {
    // 對於 OpenAI 相容端點，使用 OpenAI 庫
    if (isOpenAI) {
      return await handleCompletions(req, res, apiKey, requestBody, isStream);
    } else if (isModels && config.openrouter.free_only) {
      // 如果是模型列表端點且設定為僅顯示免費模型，則使用特殊處理
      return await handleModelsEndpoint(req, res, apiKey);
    } else {
      // 其他端點使用 HTTP 客戶端代理
      return await proxyWithHTTP(req, res, path, apiKey, isStream, isCompletion);
    }
  } catch (error) {
    logger.error(`代理請求時出錯: ${error}`);

    if (axios.isAxiosError(error) && error.response) {
      // 透傳 OpenRouter 的錯誤
      const status = error.response.status;
      const data = error.response.data;

      // 檢查是否為速率限制錯誤
      if (apiKey && (status === 429 || (status === 400 && typeof data === 'string'))) {
        try {
          const responseBody =
            typeof data === 'string' ? data :
            typeof data === 'object' ? JSON.stringify(data) : '';

          const [hasRateLimitError, resetTimeMs] = checkRateLimit(responseBody);

          if (hasRateLimitError) {
            await keyManager.disableKey(apiKey, resetTimeMs);
          }
        } catch (e) {
          logger.error(`處理速率限制時出錯: ${e}`);
        }
      }

      return res.status(status).send(data);
    }

    return res.status(500).json({ error: '代理伺服器內部錯誤' });
  }
});

/**
 * 健康檢查端點
 */
router.get('/health', (req: Request, res: Response) => {
  return res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

/**
 * 使用 OpenAI 庫處理完成請求
 */
async function handleCompletions(
  req: Request,
  res: Response,
  apiKey: string,
  requestBody: any,
  isStream: boolean
): Promise<void> {
  try {
    // 提取要轉發的頭部
    const forwardHeaders = prepareForwardHeaders(req);

    // 建立 OpenAI 客戶端
    const openai = getOpenAIClient(apiKey);

    // 複製請求主體，去除 stream 參數（因為它將作為選項傳遞）
    const completionArgs = { ...requestBody };
    if ('stream' in completionArgs) {
      delete completionArgs.stream;
    }

    // 移動 OpenAI SDK 不支持的非標準參數到 extra_body
    const extraBody: Record<string, any> = {};
    const unsupportedParams = ['include_reasoning', 'transforms', 'route', 'provider'];

    for (const param of unsupportedParams) {
      if (param in completionArgs) {
        extraBody[param] = completionArgs[param];
        delete completionArgs[param];
      }
    }

    // 處理請求
    if (req.originalUrl.includes('/chat/completions')) {
      // 處理聊天完成請求
      if (isStream) {
        const stream = await openai.chat.completions.create({
          ...completionArgs,
          stream: true,
          extra_body: Object.keys(extraBody).length > 0 ? extraBody : undefined,
        } as any);

        // 設置適當的響應頭
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // 流式傳輸響應
        try {
          for await (const chunk of stream as any) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            // 確保立即發送數據
            if (res.socket?.writableCorked) {
              res.socket.uncork();
            }
          }
          res.write('data: [DONE]\n\n');
          logger.info(`流式請求完成: ${req.url}`);
        } catch (error) {
          logger.error(`流式處理錯誤: ${error}`);
          res.write(`data: {"error": "流式處理錯誤"}\n\n`);
        } finally {
          res.end();
        }
      } else {
        // 非流式請求
        const response = await openai.chat.completions.create({
          ...completionArgs,
          stream: false,
          extra_body: Object.keys(extraBody).length > 0 ? extraBody : undefined,
        } as any);

        res.json(response);
        logger.info(`請求完成: ${req.url}`);
      }
    } else if (req.originalUrl.includes('/completions')) {
      // 處理文本完成請求
      if (isStream) {
        const stream = await openai.completions.create({
          ...completionArgs,
          stream: true,
          extra_body: Object.keys(extraBody).length > 0 ? extraBody : undefined,
        } as any);

        // 設置適當的響應頭
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // 流式傳輸響應
        try {
          for await (const chunk of stream as any) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            // 確保立即發送數據
            if (res.socket?.writableCorked) {
              res.socket.uncork();
            }
          }
          res.write('data: [DONE]\n\n');
        } catch (error) {
          logger.error(`流式處理錯誤: ${error}`);
          res.write(`data: {"error": "流式處理錯誤"}\n\n`);
        } finally {
          res.end();
        }
      } else {
        // 非流式請求
        const response = await openai.completions.create({
          ...completionArgs,
          stream: false,
          extra_body: Object.keys(extraBody).length > 0 ? extraBody : undefined,
        } as any);

        res.json(response);
        logger.info(`請求完成: ${req.url}`);
      }
    } else {
      // 未識別的端點，返回錯誤
      res.status(400).json({ error: '未支持的 OpenAI 端點' });
    }
  } catch (error) {
    // 檢查速率限制錯誤
    if (error instanceof OpenAI.APIError) {
      const status = error.status || 500;
      const errorBody = JSON.stringify(error.error || error.message);

      const [hasRateLimitError, resetTimeMs] = checkRateLimit(errorBody);

      if (hasRateLimitError) {
        await keyManager.disableKey(apiKey, resetTimeMs);
      }

      res.status(status).json(error.error || { error: error.message });
    } else {
      throw error;
    }
  }
}

/**
 * 處理模型列表端點
 */
async function handleModelsEndpoint(
  req: Request,
  res: Response,
  apiKey: string
): Promise<void> {
  try {
    const targetUrl = `${config.openrouter.base_url}${req.originalUrl.replace('/api/v1', '')}`;
    const forwardHeaders = prepareForwardHeaders(req);

    if (apiKey) {
      forwardHeaders['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await httpClient.get(targetUrl, {
      headers: forwardHeaders,
      responseType: 'arraybuffer'
    });

    // 處理響應
    if (response.status >= 200 && response.status < 300) {
      // 只取免費模型
      const processedBody = removePaidModels(Buffer.from(response.data));

      // 設置相同的響應頭
      for (const [key, value] of Object.entries(response.headers)) {
        if (value !== undefined && key.toLowerCase() !== 'content-length') {
          res.setHeader(key, value);
        }
      }

      res.status(response.status).send(processedBody);
    } else {
      res.status(response.status).send(response.data);
    }
  } catch (error) {
    throw error;
  }
}

/**
 * 使用 HTTP 客戶端代理請求
 */
async function proxyWithHTTP(
  req: Request,
  res: Response,
  path: string,
  apiKey: string,
  isStream: boolean,
  isCompletion: boolean
): Promise<void> {
  // 構建目標 URL
  const targetUrl = `${config.openrouter.base_url}/${path}`;

  // 準備轉發頭部
  const forwardHeaders = prepareForwardHeaders(req);

  // 添加授權頭部
  if (apiKey) {
    forwardHeaders['Authorization'] = `Bearer ${apiKey}`;
  }

  // 準備請求配置
  const axiosConfig: AxiosRequestConfig = {
    method: req.method as any,
    url: targetUrl,
    headers: forwardHeaders,
    validateStatus: () => true, // 不抛出錯誤
  };

  // 添加請求主體（如果有）
  if (['POST', 'PUT', 'PATCH'].includes(req.method || '')) {
    axiosConfig.data = req.body;
  }

  if (isStream) {
    axiosConfig.responseType = 'stream';
  } else {
    axiosConfig.responseType = 'arraybuffer';
  }

  // 發送請求
  const response = await httpClient.request(axiosConfig);

  // 處理流式響應
  if (isStream && response.data instanceof Readable) {
    // 設置響應頭
    for (const [key, value] of Object.entries(response.headers)) {
      if (value !== undefined) {
        res.setHeader(key, value as string);
      }
    }

    // 監聽數據塊
    let buffer = '';
    response.data.on('data', (chunk: Buffer) => {
      const chunkStr = chunk.toString();
      buffer += chunkStr;

      // 檢查 SSE 註釋行（以冒號開頭）
      if (chunkStr.trimStart().startsWith(':')) {
        // 這是一個 SSE 註釋行，例如 ": OPENROUTER PROCESSING"
        logger.debug(`收到 SSE 註釋: ${chunkStr.trim()}`);
        // 直接轉發註釋
        res.write(chunkStr);
        return;
      }

      // 檢查完整的 SSE 消息
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const message = buffer.substring(0, idx + 2);
        buffer = buffer.substring(idx + 2);

        res.write(message);
        // 確保立即發送數據
        if (res.socket?.writableCorked) {
          res.socket.uncork();
        }
      }
    });

    // 完成或錯誤
    response.data.on('end', () => {
      if (buffer.length > 0) {
        res.write(buffer);
      }
      logger.info(`流式請求完成: ${req.url}`);
      res.end();
    });

    response.data.on('error', (err: Error) => {
      logger.error(`流式傳輸錯誤: ${err}`);
      res.end();
    });

    // 客戶端關閉連接
    req.on('close', () => {
      response.data.destroy();
    });
  } else {
    // 設置響應頭
    for (const [key, value] of Object.entries(response.headers)) {
      if (value !== undefined && key.toLowerCase() !== 'content-length') {
        res.setHeader(key, value as string);
      }
    }

    // 檢查是否為錯誤
    if (response.status >= 400) {
      try {
        const responseBody = Buffer.from(response.data).toString();
        const [hasRateLimitError, resetTimeMs] = checkRateLimit(responseBody);

        if (hasRateLimitError && apiKey) {
          await keyManager.disableKey(apiKey, resetTimeMs);
        }
      } catch (e) {
        logger.error(`檢查速率限制時出錯: ${e}`);
      }
    }

    // 設置狀態碼並發送主體
    res.status(response.status).send(response.data);
    logger.info(`請求完成: ${req.url}`);
  }
}
