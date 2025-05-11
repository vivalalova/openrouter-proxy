# OpenRouter API 代理

這是一個 OpenRouter API 的代理服務，用於輪換 API 金鑰以繞過速率限制。每個金鑰每分鐘可以使用一次，如果所有金鑰都在冷卻中，請求會等待直到有金鑰可用。

## 功能特點

- 輪換 API 金鑰處理請求
- 金鑰冷卻和速率限制處理
- 支援 OpenAI 相容端點
- 支援流式回應
- 可選擇只顯示免費模型
- 健康檢查端點
- 支援 HTTP 代理

## 安裝

1. 克隆此儲存庫
2. 安裝依賴
   ```bash
   npm install
   ```
3. 複製範例配置文件
   ```bash
   cp config.example.yml config.yml
   ```
4. 根據需要編輯 `config.yml` 文件，至少添加您的 OpenRouter API 金鑰

## 配置

配置文件 `config.yml` 中可以設定以下選項：

- `server`: 服務器配置
  - `host`: 綁定地址 (預設 "0.0.0.0")
  - `port`: 監聽端口 (預設 8080)
  - `log_level`: 日誌級別 (debug, info, warn, error)

- `openrouter`: OpenRouter API 配置
  - `base_url`: API 基本 URL (預設 "https://openrouter.ai/api/v1")
  - `keys`: API 金鑰列表 (按順序輪換使用)
  - `rate_limit_cooldown`: 速率限制冷卻時間 (秒)
  - `public_endpoints`: 不需要授權的公共端點
  - `free_only`: 是否只顯示免費模型

- `request_proxy`: HTTP 代理配置 (用於連接 OpenRouter API)
  - `enabled`: 是否啟用代理
  - `url`: 代理 URL

- `access`: 本地服務器訪問控制
  - `key`: 訪問金鑰 (留空則不需要驗證)

## 使用方法

### 開發模式

```bash
npm run dev
```

### 構建和運行

```bash
npm run build
npm start
```

## API 端點

使用方式與 OpenRouter API 相同，只需將請求發送到本地代理服務器：

```
http://localhost:8080/api/v1/chat/completions
```

如果在配置中設置了訪問金鑰，請在 HTTP 請求頭中添加：

```
Authorization: Bearer your_access_key
```

## 健康檢查

健康檢查端點：

```
http://localhost:8080/health
```

## 許可證

MIT
