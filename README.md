# AudioQuick 音訊快切（Stream Deck 插件原始碼）

以「裝置名稱」而非 Windows 裝置 ID 來切換預設音訊裝置，並提供麥克風靜音切換。

## 安裝

到 [Releases](https://github.com/mumuriri0801/streamdeck-audioquick/releases) 下載 `com.diy.audioquick.streamDeckPlugin`，雙擊即可安裝到 Stream Deck。
需要 Windows 10 以上與 Stream Deck 6.4 以上；第一次啟動時會用 Windows 內建的 C# 編譯器建立音訊小程式，不必另外安裝任何東西。

## 結構

| 路徑 | 內容 |
|---|---|
| `src/logic.js` | 純邏輯：名稱比對、切換順序、按鍵顯示（可單獨測試） |
| `src/host.js` | 啟動並連接 Windows 音訊小程式；第一次執行時用 Windows 內建 `csc.exe` 編譯 |
| `src/plugin.js` | Stream Deck WebSocket 通訊與按鍵事件 |
| `com.diy.audioquick.sdPlugin/host/AudioHost.cs` | 呼叫 Windows Core Audio API 的 C# 小程式 |
| `com.diy.audioquick.sdPlugin/ui/` | 兩個動作的設定頁 |
| `build/make_icons.py` | 由 SVG 產生所有 PNG 圖示（需要 `rsvg-convert`） |
| `test/` | 單元測試、模擬 Stream Deck 的整合測試、設定頁測試 |

## 指令

```
npm install
npm run build      # 打包 src/ -> com.diy.audioquick.sdPlugin/bin/plugin.js
npm test
npm run validate
npm run pack       # 產生 dist/com.diy.audioquick.streamDeckPlugin
```

## 測試

| 檔案 | 內容 | 平台 |
|---|---|---|
| `test/logic.test.js` | 名稱比對、切換順序、按鍵顯示 | 全部 |
| `test/integration.test.js` | 打包後的插件，對模擬的 Stream Deck 與假音訊程式（`test/fake-host.js`） | 全部 |
| `test/ui.test.js` | 設定頁，用 headless Chrome 操作 | 全部。自動尋找 Chrome 或 Edge，也可用環境變數 `CHROME_PATH` 指定；找不到就跳過 |
| `test/compile.test.js` | 首次執行的編譯流程 | Linux／macOS：用假的 csc.exe。Windows：用內建 csc.exe 編譯真正的 `AudioHost.cs`，再對實際的音訊 API 檢查（只讀取，不會切換裝置或改變靜音） |

在 Windows 上單跑 `node --test test/compile.test.js`，輸出會列出目前的裝置名稱與預設裝置，可用來對照 Windows 音效設定。

`.github/workflows/test.yml` 在 Ubuntu 與 Windows 上各跑一次 `npm test`；Ubuntu 另外檢查 `bin/plugin.js` 與 `src/` 一致，並驗證 manifest。

## 名稱比對規則

Windows 重新安裝裝置時會換一個新的 ID，名稱常變成「喇叭 (2- USB DAC)」這種帶編號的形式。
插件儲存的是去掉編號後的名稱（「喇叭 (USB DAC)」），每次按下按鍵時才用名稱找出當下的 ID。
規則在 `src/logic.js` 的 `normalizeName`，設定頁 `ui/common.js` 的 `nameKey` 使用同一條規則。

## 記錄檔

`%APPDATA%\Elgato\StreamDeck\Plugins\com.diy.audioquick.sdPlugin\logs\audioquick.log`
