# 趋势交易助手 - iPhone App 部署指南

## 📱 这是什么？

这是一个可以在 iPhone 上运行的**趋势交易助手 App**，基于 PWA 技术，添加到主屏幕后和原生 App 一模一样。

## ✅ iOS 18 / iOS 26 完美支持

苹果没有禁止 PWA，禁止的只是「从文件 App 直接打开 HTML 文件」。

**正确的打开方式是：通过网址访问 → 添加到主屏幕**

---

## 🚀 三种部署方式（任选其一）

### 方式一：Vercel 一键部署（最简单，30秒搞定）

1. 把 `pwa` 文件夹上传到 GitHub
2. 打开 [vercel.com](https://vercel.com) 用 GitHub 登录
3. Import 仓库，直接点 Deploy
4. 完成！你会得到一个 `xxx.vercel.app` 的网址

### 方式二：GitHub Pages（免费稳定）

1. 新建 GitHub 仓库，上传 `pwa` 文件夹里的所有文件
2. Settings → Pages → 选择 main 分支 → Save
3. 等几分钟，网址是 `你的用户名.github.io/仓库名/`

### 方式三：Netlify 拖拽部署（最快）

1. 打开 [app.netlify.com/drop](https://app.netlify.com/drop)
2. 把 `pwa` 文件夹整个拖进去
3. 直接得到一个临时网址（注册后可以自定义域名）

---

## 📲 iPhone 安装步骤

1. **Safari 打开部署好的网址**
2. 点击底部「分享」按钮
3. 往下滑，点「添加到主屏幕」
4. 点「添加」
5. 回到桌面，就有 App 图标了！
6. 点图标全屏运行，完全像原生 App

---

## ✨ App 功能

- 📊 **12只内置品种**，打开就能用
- 🔍 搜索添加任意 A股 / ETF
- 📈 自动下载500天历史数据（腾讯财经API）
- 🎯 策略信号：MA15/MA40 + MACD + RSI
- ⚙️ 策略参数自定义
- 💾 数据本地缓存，离线也能用
- 📱 iPhone 全屏原生体验

---

## 📊 数据来源

| 数据源 | 说明 | 优先级 |
|--------|------|--------|
| 腾讯财经 | 支持CORS，纯前端可用，数据稳定 | 首选 |
| 新浪财经 | JSONP方式，备用 | 备用 |
| 本地缓存 | localStorage，离线可用 | 已有数据 |
| 内置数据 | 12只品种bundle数据 | 初始数据 |

---

## 🔧 本地测试（开发者）

```bash
cd pwa
python3 -m http.server 8080
```

然后浏览器打开 http://localhost:8080

---

## 📁 文件结构

```
pwa/
├── index.html          # 主页面
├── manifest.json       # PWA 配置
├── sw.js             # 离线缓存
├── README.md         # 本文件
├── css/
│   └── style.css      # iPhone 样式
├── js/
│   ├── app.js         # 应用逻辑
│   ├── data.js        # 数据层（腾讯财经+新浪+缓存）
│   └── strategy.js    # 策略引擎
├── data/
│   └── bundle.json    # 内置12只数据
└── icons/
    ├── icon-192.png    # 图标
    └── icon-512.png
```

---

## ⚠️ 注意事项

- 必须用 **Safari** 打开才能「添加到主屏幕」
- 第一次打开需要联网下载数据
- 已添加的股票数据存在本地，离线可看
- 必须是 **HTTPS** 才能用完整 PWA 功能（Vercel/GitHub Pages 都是 HTTPS）
- iOS 上 PWA 有独立的存储空间，和 Safari 分开
