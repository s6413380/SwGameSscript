# 網頁遊戲自動化與數據分析工具

多帳號掛機管理 × 自動鍛造 × 遊戲數據統計。以 Tampermonkey 瀏覽器腳本為核心，搭配本機中繼站與 Google 試算表雲端同步。

完整介紹（架構、功能、用到的技術）：[docs/專案介紹.pdf](docs/專案介紹.pdf)

## 檔案

| 檔案 | 用途 |
|---|---|
| `auto-clicker-v2.user.js` | 主程式：自動化、API 攔截、遊戲內面板、統計分析 |
| `auto-clicker-v2.loader.user.js` | 載入器：瀏覽器只裝這個，開頁面時從中繼站載入最新主程式 |
| `monitor-server.ps1`、`啟動中繼站.cmd` | 本機中繼站（Windows 內建 PowerShell） |
| `monitor-dashboard.html` | 多帳號總覽頁 |
| `cloud-sheet.gs` | 雲端共享用的 Google Apps Script |
| `使用說明.txt` | 安裝與使用說明 |

## 雲端同步

公開版沒有內建試算表網址。要用的話，照 `使用說明.txt` 的「雲端共用」部署 `cloud-sheet.gs`，再把網址填進面板「其他 → 雲端」。

## 注意

個人學習與研究用途。自動化操作可能違反遊戲使用規範，使用風險自負。
