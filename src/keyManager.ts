/**
 * API 金鑰管理模組
 * 實現金鑰輪換和速率限制處理
 */

import { logger } from './config';

/**
 * 遮蔽 API 金鑰用於日誌記錄
 */
function maskKey(key: string): string {
  if (key.length <= 8) {
    return "****";
  }
  return key.substring(0, 4) + "****" + key.substring(key.length - 4);
}

export class KeyManager {
  private keys: string[];
  private cooldownSeconds: number;
  private currentIndex: number;
  private disabledUntil: Map<string, Date>;
  private lockPromise: Promise<void> | null;

  /**
   * 建立新的金鑰管理器
   * @param keys API 金鑰列表
   * @param cooldownSeconds 冷卻時間（秒）
   */
  constructor(keys: string[], cooldownSeconds: number) {
    this.keys = keys;
    this.cooldownSeconds = cooldownSeconds;
    this.currentIndex = 0;
    this.disabledUntil = new Map<string, Date>();
    this.lockPromise = null;

    if (keys.length === 0) {
      logger.error("配置中未提供 API 金鑰。");
      process.exit(1);
    }
  }

  /**
   * 取得下一個可用的 API 金鑰，使用循環選擇法
   * @param cooldownSeconds 金鑰使用後的冷卻時間（秒）
   */
  async getNextKey(cooldownSeconds: number = 0): Promise<string> {
    // 等待鎖釋放
    while (this.lockPromise) {
      await this.lockPromise;
    }

    // 建立新鎖
    let releaseLock: (() => void) | undefined;
    this.lockPromise = new Promise<void>(resolve => {
      releaseLock = resolve;
    });

    try {
      // 尋找下一個可用的金鑰
      for (let i = 0; i < this.keys.length; i++) {
        const key = this.keys[this.currentIndex];
        logger.info(`檢查金鑰 index: ${this.currentIndex}`);

        this.currentIndex = (this.currentIndex + 1) % this.keys.length;

        // 檢查金鑰是否被禁用
        if (this.disabledUntil.has(key)) {
          const disabledUntil = this.disabledUntil.get(key)!;
          if (new Date() >= disabledUntil) {
            // 金鑰冷卻期已過
            this.disabledUntil.delete(key);
            logger.info(`API 金鑰 ${maskKey(key)} 已重新啟用。`);

            // 設定冷卻時間
            if (cooldownSeconds > 0) {
              const disableUntil = new Date();
              disableUntil.setSeconds(disableUntil.getSeconds() + cooldownSeconds);
              this.disabledUntil.set(key, disableUntil);
              logger.info(`API 金鑰 ${maskKey(key)} 已被禁用 ${cooldownSeconds} 秒。`);
            }

            return key;
          }
        } else {
          // 設定冷卻時間
          if (cooldownSeconds > 0) {
            const disableUntil = new Date();
            disableUntil.setSeconds(disableUntil.getSeconds() + cooldownSeconds);
            this.disabledUntil.set(key, disableUntil);
            logger.info(`API 金鑰 ${maskKey(key)} 已被禁用 ${cooldownSeconds} 秒。`);
          }

          return key;
        }
      }

      // 所有金鑰都被禁用，尋找最早可用的金鑰並等待
      const soonestAvailable = Array.from(this.disabledUntil.values()).reduce(
        (earliest, current) => current < earliest ? current : earliest,
        new Date(8640000000000000) // 遠未來的日期
      );

      const waitMs = Math.max(0, soonestAvailable.getTime() - new Date().getTime());
      const waitSeconds = waitMs / 1000;

      logger.warn(
        `所有 API 金鑰目前皆已禁用。等待 ${waitSeconds.toFixed(2)} 秒直到下一個金鑰可用。`
      );

      // 釋放鎖以允許其他請求等待
      if (releaseLock) {
        this.lockPromise = null;
        releaseLock();
      }

      // 等待直到最早的金鑰可用
      await new Promise(resolve => setTimeout(resolve, waitMs));

      // 再次嘗試獲取金鑰（遞迴調用）
      return this.getNextKey(cooldownSeconds);
    } finally {
      // 確保鎖被釋放
      if (releaseLock) {
        this.lockPromise = null;
        releaseLock();
      }
    }
  }

  /**
   * 禁用金鑰直到重設時間或設定的冷卻時間
   * @param key 要禁用的 API 金鑰
   * @param resetTimeMs 可選的重設時間（毫秒，自紀元以來）
   */
  async disableKey(key: string, resetTimeMs?: number): Promise<void> {
    // 等待鎖釋放
    while (this.lockPromise) {
      await this.lockPromise;
    }

    // 建立新鎖
    let releaseLock: (() => void) | undefined;
    this.lockPromise = new Promise<void>(resolve => {
      releaseLock = resolve;
    });

    try {
      let disabledUntil: Date;

      if (resetTimeMs) {
        try {
          // 檢查重設時間格式
          let resetDatetime: Date;

          // 測試是否是有效的時間戳（毫秒）
          if (resetTimeMs > Date.now()) {
            // 如果值大於當前時間戳，則直接使用
            resetDatetime = new Date(resetTimeMs);
            logger.info(`使用毫秒時間戳: ${resetTimeMs}`);
          } else if (resetTimeMs > Date.now() / 1000) {
            // 如果值大於當前秒時間戳但小於毫秒時間戳，認為是毫秒
            resetDatetime = new Date(resetTimeMs);
            logger.info(`使用毫秒時間戳: ${resetTimeMs}`);
          } else {
            // 假設是秒時間戳
            resetDatetime = new Date(resetTimeMs * 1000);
            logger.info(`使用秒時間戳，轉換為毫秒: ${resetTimeMs * 1000}`);
          }

          // 確保重設時間在未來
          if (resetDatetime > new Date()) {
            disabledUntil = resetDatetime;
            logger.info(`使用伺服器提供的重設時間：${disabledUntil.toISOString()}`);
          } else {
            // 如果重設時間在過去，則使用預設冷卻
            disabledUntil = new Date(Date.now() + this.cooldownSeconds * 1000);
            logger.warn(
              `伺服器提供的重設時間在過去，使用預設冷卻時間 ${this.cooldownSeconds} 秒`
            );
          }
        } catch (e) {
          // 出錯時使用預設冷卻
          disabledUntil = new Date(Date.now() + this.cooldownSeconds * 1000);
          logger.error(
            `處理重設時間 ${resetTimeMs} 時出錯，使用預設冷卻：${e}`
          );
        }
      } else {
        // 使用預設冷卻時間
        disabledUntil = new Date(Date.now() + this.cooldownSeconds * 1000);
        logger.info(
          `未提供重設時間，使用預設冷卻時間 ${this.cooldownSeconds} 秒`
        );
      }

      this.disabledUntil.set(key, disabledUntil);
      logger.warn(
        `API 金鑰 ${maskKey(key)} 已被禁用直到 ${disabledUntil.toISOString()}`
      );
    } finally {
      // 釋放鎖
      if (releaseLock) {
        this.lockPromise = null;
        releaseLock();
      }
    }
  }
}
