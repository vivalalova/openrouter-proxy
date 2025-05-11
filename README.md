# OpenRouter 代理伺服器

這是一個用於 OpenRouter API 請求的代理伺服器，可以自動輪換 API 金鑰以繞過速率限制，提升大型語言模型 API 的可用性和穩定性。

## 功能特點

- 自動輪換多個 OpenRouter API 金鑰，有效繞過單一金鑰的速率限制
- 內建速率限制管理機制，智能處理超限狀況
- 支援所有 OpenRouter API 端點
- 透明轉發所有請求參數和回應
- 支援 HTTP 代理配置
- 提供簡單的存取控制
- 可選擇只顯示免費模型
- 為 Google 模型提供特殊延遲處理

## 安裝

```bash
# 安裝依賴
npm install

# 編譯 TypeScript
npm run build
```

## 配置

1. 複製範例配置檔：

```bash
cp config.example.yml config.yml
```

2. 編輯 `config.yml`，設定您的 OpenRouter API 金鑰和其他選項：

```yaml
server:
  host: "0.0.0.0"  # 伺服器監聽的主機位址
  port: 8080       # 伺服器監聽的連接埠
  log_level: "info" # 日誌級別: debug, info, warn, error

openrouter:
  base_url: "https://openrouter.ai/api/v1"
  keys:
    - "your_openrouter_key_1"
    - "your_openrouter_key_2"
  rate_limit_cooldown: 60
  free_only: true
  google_rate_delay: 0

request_proxy:
  enabled: false
  url: ""

access:
  key: ""  # 設定存取金鑰，留空則不需要驗證
```

## 運行

```bash
# 開發模式（自動重載）
npm run dev

# 生產模式
npm start
```

啟動後，伺服器將在配置的主機和連接埠上監聽，例如：`http://localhost:8080/api/v1`

## API 使用

使用本代理的方式與直接使用 OpenRouter API 相同，只需將請求 URL 從 `https://openrouter.ai/api/v1` 更改為您的代理伺服器 URL。

### 主要端點

- `/api/v1/chat/completions` - 聊天完成接口
- `/api/v1/completions` - 文本完成接口
- `/api/v1/models` - 模型列表接口
- `/health` - 健康檢查端點

### 存取驗證

如果您在配置中設定了存取金鑰，所有請求都需要在 HTTP 標頭中包含此金鑰：

```
X-Access-Key: your_access_key
```

## 開發

```bash
# 運行測試
npm test
```

## 授權

MIT

## 貢獻

歡迎提交問題報告和拉取請求！
