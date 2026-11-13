# AudioQuick 交接文件（給 Claude Code）

## 背景

使用者原本用 Stream Deck 的 Audio Switcher 插件切換音源，但設定常在幾天後失效，裝置清單還會多出同名項目。
原因是該插件以 Windows 音訊裝置 ID 綁定，而 Windows 重新辨識裝置時會換 ID（例如同一個 USB 喇叭換插到另一個孔，名稱就變成「喇叭 (2- USB DAC)」這種帶編號的形式）。

使用者要求自製一個功能相近的插件，只需要兩件事：**音源切換**、**麥克風啟用／靜音**。
做法是改以「去掉編號後的裝置名稱」比對，按下按鍵當下才用名稱找出目前的 ID。

使用者環境：Windows、Stream Deck；同時接有多個音訊輸出裝置與麥克風。
回覆請用繁體中文。
版控內的測試資料一律使用虛構的通用裝置名稱，不要寫入使用者實際的裝置型號。

## 目前狀態

已在實機（Windows 11、Stream Deck 7.6）上安裝並驗證，結果見下方待辦第 2、3 項。

| 項目 | 狀態 |
|---|---|
| 名稱比對、切換順序、按鍵顯示邏輯（`src/logic.js`） | 單元測試通過 |
| 插件主程式對 Stream Deck 協定的收發（`src/plugin.js`） | 整合測試通過；實機驗證通過 |
| 設定頁（`ui/*.html`） | headless Chrome 測試通過；實機驗證通過 |
| 首次執行編譯流程（`src/host.js`） | 實機上由插件呼叫內建 csc.exe 編譯成功；重開 Stream Deck 後沿用已編譯的 exe |
| manifest | `streamdeck validate` 通過 |
| `host/AudioHost.cs` | 實機驗證通過：列舉裝置、中文名稱、`setDefault`、`setMute`、偵測外部靜音變化、關閉 stdin 後結束 |
| 在 Stream Deck 上實際安裝、按鍵 | 驗收清單除「換孔」一項外皆通過 |

以上自動測試在 Linux 與 GitHub Actions 的 Windows runner（`.github/workflows/test.yml`）上都會跑；在實機 Windows 上 `npm test` 也全部通過（假 csc 的測試在 Windows 上依設計跳過）。

## 待辦

### 1. 建立 GitHub repo 並推送（已完成）

- 公開 repo：https://github.com/mumuriri0801/streamdeck-audioquick
- `com.diy.audioquick.sdPlugin/bin/plugin.js` 是打包產物，但刻意保留在版控內，讓 clone 下來就能直接安裝；CI 會檢查它與 `src/` 一致。

### 2. 在 Windows 上驗證音訊程式（已完成）

`npm ci` 後跑 `node --test test/compile.test.js`：會用內建 csc.exe 編譯、列出目前的裝置名稱與預設裝置（只讀取，不改任何設定）。
手動試切換與靜音時，單獨編譯後手動執行：

```
%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize+ /target:exe /platform:anycpu /out:AudioHost.exe com.diy.audioquick.sdPlugin\host\AudioHost.cs
AudioHost.exe
```

啟動後印出一行 `{"type":"hello",...}`，接著一行 `{"type":"state","devices":[...],"defaults":{...}}`。
之後從 stdin 輸入指令（欄位以 TAB 分隔），每行會回一筆 `result`：

```
1<TAB>refresh
2<TAB>setDefault<TAB><裝置 id><TAB>1
3<TAB>setMute<TAB><麥克風 id><TAB>1
```

注意：程式在 stdin 關閉時會立刻結束，所以用管線一次送完指令（`echo ... | AudioHost.exe`）可能在指令執行前就結束；要保持 stdin 開著逐行送。

實機結果：

- [x] 內建 csc（C# 5）編譯通過。
- [x] `devices` 的名稱與 Windows 音效設定一致，中文名稱正確（輸出為 `\uXXXX`，解碼後正確）。
- [x] `setDefault` 實際切換預設裝置（約 30–50 毫秒後出現新的 `state`）；第四欄 `1` 時連預設通訊裝置一起切，`0` 時通訊裝置不動。
- [x] `setMute` 生效；從 Windows 控制台手動靜音／取消靜音後，下一筆 `state` 的 `muted` 跟著變。
- [x] 關閉 stdin 後程式在幾毫秒內自行結束；關閉 Stream Deck 時插件與音訊程式都不會殘留。
- [x] 未知 ID 的 `setDefault` 回 `0x80070490`，`setMute` 回 `GetDevice failed`，程式不會當掉。

### 3. 在 Stream Deck 上驗證（大致完成）

- 安裝：雙擊 `dist/*.streamDeckPlugin`，或用 `streamdeck link com.diy.audioquick.sdPlugin` 連結開發資料夾。
- 記錄檔：`%APPDATA%\Elgato\StreamDeck\Plugins\com.diy.audioquick.sdPlugin\logs\audioquick.log`
- 驗收清單：
  - [x] 插件出現在動作清單，兩個動作都能拖到按鍵上
  - [x] 設定頁列出目前連接的裝置，沒有重複項目，名稱不帶 `2-` 這類編號
  - [x] 音源切換：兩個裝置之間來回切換，按鍵圖示與名稱跟著變
  - [x] 從 Windows 音效選單手動切換後，按鍵在一秒內跟上
  - [x] 麥克風靜音：按下切換，圖示正確；從別處靜音時按鍵同步
  - [x] 麥克風按鍵放開後狀態不會被 Stream Deck 自己翻回去（Stream Deck 7.6，`DisableAutomaticStates` 有效）
  - [ ] 拔掉裝置再插到另一個 USB 孔（讓 ID 與「2-」編號改變），不重新設定也能繼續切換 —— **使用者當時不方便操作，尚未實測**；邏輯由 `test/logic.test.js`、`test/integration.test.js` 的「換 ID 與編號」案例涵蓋
  - [x] 重新啟動後設定仍有效（以結束並重開 Stream Deck 軟體驗證：設定保留、插件自動啟動、沿用已編譯的 exe；未實際重開機）

### 4. 讓測試能在 Windows 上跑（已完成）

- `test/ui.test.js`：Chrome 路徑可用 `CHROME_PATH` 指定，否則自動尋找 Chrome／Edge，找不到就跳過；頁面網址改用 `pathToFileURL`，Windows 路徑才會正確。
- `test/compile.test.js`：假 csc.exe 的測試在 Windows 上跳過；改為在 Windows 上用內建 csc.exe 編譯真正的 `AudioHost.cs`，檢查 hello／state、`ping`／`refresh`、未知 ID 的 `setMute`／`setDefault` 回傳錯誤而不當掉，以及關閉 stdin 後自行結束。這個測試只讀取，不會改變任何音訊設定。
- `.github/workflows/test.yml`：在 Ubuntu 與 Windows runner 上跑測試。
- `build/make_icons.py` 仍需要 `rsvg-convert`；PNG 已在版控內，平常不必重跑。

### 5. 實機驗證後的修正（v1.0.1）

- `src/logic.js` 的 `GENERIC_DESCRIPTIONS` 加入「耳麥式麥克風」（Windows 繁中對耳機麥克風的命名），自動標題改顯示括號內的裝置名稱。

## 設計重點

- **名稱比對**：`src/logic.js` 的 `normalizeName` 去掉 `(` 後面的「數字- 」編號並整理空白，比對時不分大小寫。設定頁 `ui/common.js` 的 `nameKey` 用同一條規則，兩邊要一起改。
- **不依賴 Stream Deck SDK 套件**：`src/plugin.js` 直接用 `ws` 講 WebSocket 協定，用 esbuild 打包成單一檔案。
- **音訊程式獨立成 exe**：Node 無法直接呼叫 COM，所以用 C# 寫一個小程式，以 stdin／stdout 逐行溝通。只附原始碼，第一次執行時由插件呼叫 Windows 內建的 csc.exe 編譯；檔名帶原始碼雜湊，原始碼更新後會自動重新編譯（注意：git 的 `core.autocrlf` 會改變換行，同一份原始碼在不同 checkout 的雜湊可能不同，只會多編譯一次，沒有其他影響）。
- **狀態更新靠輪詢**：音訊程式每 500 毫秒檢查一次，有變化才輸出。沒有用 COM 事件回呼，是為了減少無法實測的程式碼。
- **測試掛鉤**：環境變數 `AUDIOQUICK_HOST_CMD`（JSON 陣列）可以把音訊程式換成別的指令，`test/fake-host.js` 就是這樣接上的。

其餘結構與指令見 `README.md`。
