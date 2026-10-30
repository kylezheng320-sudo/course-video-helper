# 課程影片助手

用於線上課程頁面的 Tampermonkey 使用者腳本，提供播放控制、時間統計與自動更新。目前版本為 **3.2.4**。

## 安裝與更新

安裝 Tampermonkey 後，開啟 [安裝最新版](https://raw.githubusercontent.com/kylezheng320-sudo/course-video-helper/main/video-helper.user.js)。從舊版遷移時覆蓋原腳本，避免同時啟用多個版本。重新整理課程頁面，再從助手面板啟動。

3.2.4 將更新來源改為 GitHub。首次從 3.2.3 或更早版本遷移，需要手動安裝一次；後續由 Tampermonkey 依自身的更新檢查設定下載新版，重新整理課程頁面後生效。原腳本名稱、命名空間與設定儲存鍵保持一致。

此更新方式無須依賴本機更新服務，也無須登入 GitHub，但需要能夠連線至 `raw.githubusercontent.com`。GitHub 頁面網址不能代替腳本的原始檔案網址。

## 功能

- 自動播放、靜音、連播及下一個任務點設定。
- 影片互動彈窗處理與章節頁面適配。
- 讀取課程目錄中的影片時長，依所選比例估算剩餘觀看時間。
- 依課程儲存本機可觀察到的累計播放時間。
- 支援暫停、主題切換、收合與拖曳面板。

3.2.4 的播放、章節切換、計時與 UI 邏輯沿用 3.2.3；本次僅調整版本號與更新網址。

## 發布後續版本

需要 Node.js，無須安裝額外依賴。

1. 修改 `video-helper.user.js` 中的功能程式碼，保留目前版本號。
2. 執行 `node tools/release.cjs prepare 3.2.5`，產生遞增版本的腳本、中繼資料、版本封存與校驗值。
3. 執行 `node tools/release.cjs check`，核對版本、語法、更新網址與檔案一致性。
4. 將這次產生的檔案放在同一個 Git 提交中，推送至 `main`。

更新下載檔案時也必須提高版本號。`release.json` 與 `CHECKSUMS.sha256` 供發布者核對；Tampermonkey 透過 `@updateURL` 與 `@downloadURL` 檢查及下載更新。

## 來源

部分影片適配程式碼參考 alv 的上游專案 v5.3.54，來源及修改紀錄見 [來源說明](SOURCE-NOTES-3.0.1.md)。內嵌 Geist / Geist Mono 字型的版權與授權條款見 [字型說明](FONT-NOTICES-3.1.0.txt)。
