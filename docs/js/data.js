/**
 * 数据层 - 支持本地bundle缓存和在线API下载
 * 优先顺序：内存bundle → localStorage缓存 → 本地JSON → 在线API
 */

const DataManager = {
  STORAGE_KEY: 'trend_trader_data',
  WATCHLIST_KEY: 'trend_trader_watchlist',
  SETTINGS_KEY: 'trend_trader_settings',
  bundleData: null, // 内存中的bundle数据
  backendAvailable: null, // 后端是否可用

  // 默认自选股（12个品种）
  defaultWatchlist: [
    { code: '512000', name: '证券ETF', type: 'etf' },
    { code: '159819', name: '人工智能ETF', type: 'etf' },
    { code: '159562', name: '黄金股ETF', type: 'etf' },
    { code: '300308.SZ', name: '中际旭创', type: 'stock' },
    { code: '601899.SH', name: '紫金矿业', type: 'stock' },
    { code: '002594.SZ', name: '比亚迪', type: 'stock' },
    { code: '688981.SH', name: '中芯国际', type: 'stock' },
    { code: '603986.SH', name: '兆易创新', type: 'stock' },
    { code: '600519.SH', name: '贵州茅台', type: 'stock' },
    { code: '000651.SZ', name: '格力电器', type: 'stock' },
    { code: '601318.SH', name: '中国平安', type: 'stock' },
    { code: '600436.SH', name: '片仔癀', type: 'stock' },
  ],

  /**
   * 带超时的fetch请求
   */
  async fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      const resp = await fetch(url, { ...options, signal: controller.signal });
      return resp;
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error('请求超时');
      }
      throw e;
    } finally {
      clearTimeout(timeoutId);
    }
  },

  /**
   * 验证股票代码格式
   * 支持格式：
   * - 纯6位数字：512000、600519、000001
   * - 腾讯格式：sh600000、sz000001
   * - 点格式：600000.SH、000001.SZ
   */
  isValidCode(code) {
    if (!code || typeof code !== 'string') return false;
    const purePattern = /^\d{6}$/;
    const tencentPattern = /^(sh|sz)\d{6}$/i;
    const dotPattern = /^\d{6}\.(SH|SZ|sh|sz)$/;
    return purePattern.test(code) || tencentPattern.test(code) || dotPattern.test(code);
  },

  /**
   * 检查后端是否可用
   */
  async checkBackend() {
    if (this.backendAvailable !== null) return this.backendAvailable;
    
    try {
      const resp = await this.fetchWithTimeout('/api/health', {}, 3000);
      if (resp.ok) {
        const data = await resp.json();
        this.backendAvailable = data.status === 'ok';
        console.log('后端服务可用:', data.akshare_version || '');
        return true;
      }
    } catch (e) {
      console.warn('后端服务不可用:', e.message || e);
    }
    
    this.backendAvailable = false;
    return false;
  },

  /**
   * 从后端API获取数据（AKShare）
   */
  async fetchFromBackend(code) {
    try {
      if (!this.isValidCode(code)) {
        throw new Error('无效的股票代码格式');
      }
      const codeClean = code.split('.')[0];
      const resp = await this.fetchWithTimeout(`/api/stock/history?code=${codeClean}`, {}, 15000);
      if (resp.ok) {
        const result = await resp.json();
        if (result.data && result.data.length > 0) {
          return {
            data: result.data,
            name: result.name || code,
            type: result.type || 'stock',
          };
        } else {
          throw new Error(result.error || '无数据');
        }
      } else {
        const err = await resp.json();
        throw new Error(err.error || '请求失败');
      }
    } catch (e) {
      console.warn('后端API获取失败:', e);
      throw e;
    }
  },

  /**
   * 初始化：加载bundle数据 + 检查后端
   */
  async init() {
    // 并行加载
    const bundlePromise = this.loadBundle();
    const backendPromise = this.checkBackend();
    
    await Promise.all([bundlePromise, backendPromise]);
    
    console.log(`数据加载完成: bundle=${this.bundleData ? 'OK' : '无'}, 后端=${this.backendAvailable ? '可用' : '不可用'}`);
    return true;
  },

  /**
   * 加载bundle数据
   */
  async loadBundle() {
    try {
      const resp = await this.fetchWithTimeout('data/bundle.json', {}, 5000);
      if (resp.ok) {
        this.bundleData = await resp.json();
        console.log(`Bundle加载成功: ${Object.keys(this.bundleData).length}个品种`);
        return true;
      }
    } catch (e) {
      console.warn('Bundle加载失败:', e);
    }
    return false;
  },

  /**
   * 标准化代码匹配
   */
  matchCode(code, dataKeys) {
    // 精确匹配
    if (dataKeys.includes(code)) return code;
    
    // 尝试去掉交易所后缀
    const simpleCode = code.split('.')[0];
    if (dataKeys.includes(simpleCode)) return simpleCode;
    
    // 尝试加后缀
    for (const suffix of ['.SH', '.SZ', '.sh', '.sz']) {
      if (dataKeys.includes(code + suffix)) return code + suffix;
    }
    
    // 下划线格式
    const underscoreCode = code.replace('.', '_');
    if (dataKeys.includes(underscoreCode)) return underscoreCode;
    
    return null;
  },

  /**
   * 获取自选股列表
   */
  getWatchlist() {
    try {
      const saved = localStorage.getItem(this.WATCHLIST_KEY);
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return [...this.defaultWatchlist];
  },

  /**
   * 保存自选股列表
   */
  saveWatchlist(list) {
    try {
      localStorage.setItem(this.WATCHLIST_KEY, JSON.stringify(list));
    } catch (e) {
      console.warn('保存自选列表失败（可能存储空间不足）:', e);
    }
  },

  /**
   * 获取策略设置
   */
  getSettings() {
    try {
      const saved = localStorage.getItem(this.SETTINGS_KEY);
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return {
      fastMA: 15,
      slowMA: 40,
      useMA60: false,
      useVolume: false,
      volumeRatio: 1.5,
      useMACD: true,
      useRSI: true,
      rsiLow: 40,
      rsiHigh: 70,
      entryConfirm: 2,
      exitConfirm: 2,
    };
  },

  /**
   * 保存策略设置
   */
  saveSettings(settings) {
    try {
      localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
      console.warn('保存设置失败:', e);
    }
  },

  /**
   * 从本地缓存获取股票数据
   */
  getCachedData(code) {
    try {
      const allData = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '{}');
      if (allData[code]) {
        const cached = allData[code];
        const age = Date.now() - cached.timestamp;
        if (age < 7 * 24 * 60 * 60 * 1000) {
          return cached.data;
        }
      }
    } catch (e) {}
    return null;
  },

  /**
   * 检查缓存是否新鲜
   * @param {String} code - 股票代码
   * @param {Number} maxAgeHours - 最大新鲜时长（小时）
   * @returns {Boolean} 是否新鲜
   */
  isCacheFresh(code, maxAgeHours = 6) {
    try {
      const allData = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '{}');
      if (allData[code]) {
        const age = Date.now() - allData[code].timestamp;
        return age < maxAgeHours * 60 * 60 * 1000;
      }
    } catch (e) {}
    return false;
  },

  /**
   * 获取缓存时间戳
   */
  getCacheTimestamp(code) {
    try {
      const allData = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '{}');
      if (allData[code]) {
        return allData[code].timestamp;
      }
    } catch (e) {}
    return null;
  },

  /**
   * 缓存股票数据
   */
  cacheData(code, data) {
    try {
      const allData = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '{}');
      allData[code] = { data, timestamp: Date.now() };
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(allData));
    } catch (e) {
      console.warn('缓存失败:', e);
    }
  },

  /**
   * 从bundle获取数据
   */
  getFromBundle(code) {
    if (!this.bundleData) return null;
    const matched = this.matchCode(code, Object.keys(this.bundleData));
    if (matched) {
      return this.bundleData[matched];
    }
    return null;
  },

  /**
   * 从腾讯财经API获取数据（支持CORS，纯前端可用）
   */
  async fetchFromTencent(code, type = 'stock') {
    if (!this.isValidCode(code)) {
      throw new Error('无效的股票代码格式');
    }
    let tencentCode;
    const simple = code.split('.')[0];
    
    // 判断市场
    if (simple.startsWith('6') || simple.startsWith('5') || simple.startsWith('9')) {
      tencentCode = 'sh' + simple;
    } else if (simple.startsWith('0') || simple.startsWith('3') || simple.startsWith('1') || simple.startsWith('2')) {
      tencentCode = 'sz' + simple;
    } else {
      tencentCode = 'sh' + simple;
    }

    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tencentCode},day,,,500,qfq`;
    
    // 最多重试2次，间隔递增
    const maxRetries = 2;
    let lastError = null;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const resp = await this.fetchWithTimeout(url, {}, 15000);
        if (!resp.ok) {
          throw new Error('HTTP错误: ' + resp.status);
        }
        
        const json = await resp.json();
        if (json.code !== 0 || !json.data) {
          throw new Error('数据格式错误');
        }
        
        const stockData = json.data[tencentCode];
        if (!stockData) {
          throw new Error('无此股票，请检查代码是否正确');
        }
        
        // 优先用前复权数据，没有的话用普通日K
        const klines = stockData.qfqday || stockData.day || [];
        if (klines.length === 0) {
          throw new Error('无K线数据');
        }
        
        // 只取最近500条
        const recent = klines.slice(-500);
        
        return {
          data: this.parseTencentData(recent),
          name: stockData.qt?.[tencentCode]?.[1] || code,
        };
      } catch (e) {
        lastError = e;
        // 最后一次不重试
        if (attempt < maxRetries) {
          const waitMs = 1000 * (attempt + 1) + Math.random() * 500;
          console.warn(`腾讯财经请求失败 (${attempt + 1}/${maxRetries})，${waitMs.toFixed(0)}ms后重试:`, e.message);
          await new Promise(r => setTimeout(r, waitMs));
        }
      }
    }
    
    throw lastError;
  },

  /**
   * 解析腾讯财经数据
   * 格式: [日期, 开盘, 收盘, 最高, 最低, 成交量]
   */
  parseTencentData(raw) {
    if (!raw || !Array.isArray(raw)) return [];
    return raw.map(item => ({
      date: item[0],
      open: parseFloat(item[1]),
      close: parseFloat(item[2]),
      high: parseFloat(item[3]),
      low: parseFloat(item[4]),
      volume: parseFloat(item[5]),
    })).filter(d => !isNaN(d.close) && d.date);
  },

  /**
   * 从在线API获取数据（Sina财经，JSONP，备用）
   */
  async fetchFromSina(code, type = 'stock') {
    let sinaCode;
    if (type === 'etf') {
      if (code.startsWith('5')) sinaCode = 'sh' + code;
      else sinaCode = 'sz' + code;
    } else {
      const simple = code.split('.')[0];
      if (simple.startsWith('6') || simple.startsWith('5')) sinaCode = 'sh' + simple;
      else sinaCode = 'sz' + simple;
    }

    return new Promise((resolve, reject) => {
      const callbackName = 'sina_cb_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
      const script = document.createElement('script');
      
      script.onerror = () => {
        document.head.removeChild(script);
        delete window[callbackName];
        reject(new Error('网络请求失败'));
      };

      window[callbackName] = (data) => {
        document.head.removeChild(script);
        delete window[callbackName];
        resolve(this.parseSinaData(data));
      };

      const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sinaCode}&scale=240&ma=no&datalen=500&callback=${callbackName}`;
      script.src = url;
      document.head.appendChild(script);

      setTimeout(() => {
        if (window[callbackName]) {
          document.head.removeChild(script);
          delete window[callbackName];
          reject(new Error('请求超时'));
        }
      }, 15000);
    });
  },

  /**
   * 解析新浪数据
   */
  parseSinaData(raw) {
    if (!raw || !Array.isArray(raw)) return [];
    return raw.map(item => ({
      date: item.day,
      open: parseFloat(item.open),
      high: parseFloat(item.high),
      low: parseFloat(item.low),
      close: parseFloat(item.close),
      volume: parseFloat(item.volume),
    })).filter(d => !isNaN(d.close));
  },

  /**
   * 获取股票数据
   * 优先顺序：后端API(AKShare) → bundle → 缓存 → 新浪API
   */
  async getData(code, name, type = 'stock', forceRefresh = false) {
    // 后端API（最优先，数据最准）
    if (this.backendAvailable && forceRefresh !== false) {
      try {
        const result = await this.fetchFromBackend(code);
        if (result && result.data && result.data.length > 0) {
          this.cacheData(code, result.data);
          return {
            data: result.data,
            source: 'backend',
            fromCache: false,
            name: result.name,
            type: result.type,
          };
        }
      } catch (e) {
        console.warn('后端获取失败，尝试其他方式:', e);
      }
    }

    // bundle（内置数据，秒开）
    if (!forceRefresh) {
      const bundleData = this.getFromBundle(code);
      if (bundleData && bundleData.length > 0) {
        return { data: bundleData, source: 'bundle', fromCache: true };
      }
    }

    // localStorage缓存
    if (!forceRefresh) {
      const cached = this.getCachedData(code);
      if (cached && cached.length > 0) {
        return { data: cached, source: 'cache', fromCache: true };
      }
    }

    // 后端API（首次获取时也试一次）
    if (this.backendAvailable) {
      try {
        const result = await this.fetchFromBackend(code);
        if (result && result.data && result.data.length > 0) {
          this.cacheData(code, result.data);
          return {
            data: result.data,
            source: 'backend',
            fromCache: false,
            name: result.name,
            type: result.type,
          };
        }
      } catch (e) {
        console.warn('后端获取失败:', e);
      }
    }

    // 腾讯财经API（首选，支持CORS，数据稳定）
    try {
      const result = await this.fetchFromTencent(code, type);
      if (result && result.data && result.data.length > 0) {
        this.cacheData(code, result.data);
        return {
          data: result.data,
          source: 'tencent',
          fromCache: false,
          name: result.name,
          type: type,
        };
      }
    } catch (e) {
      console.warn('腾讯财经获取失败，尝试新浪:', e.message);
    }

    // 新浪在线API（备用）
    try {
      const data = await this.fetchFromSina(code, type);
      if (data && data.length > 0) {
        this.cacheData(code, data);
        return { data, source: 'sina', fromCache: false };
      }
    } catch (e) {
      console.warn('新浪下载失败:', e);
    }

    return { data: [], source: 'none', fromCache: false, error: '无法获取数据' };
  },

  /**
   * 批量获取数据（串行加载 + 随机延迟，避免触发限流）
   */
  async getAllData(watchlist, forceRefresh = false, onProgress = null) {
    const results = {};
    
    // 先全部从bundle取（同步，瞬间完成）
    let loadedFromBundle = 0;
    for (let i = 0; i < watchlist.length; i++) {
      const item = watchlist[i];
      const bundleData = this.getFromBundle(item.code);
      
      if (bundleData && bundleData.length > 0 && !forceRefresh) {
        results[item.code] = { ...item, data: bundleData, source: 'bundle', fromCache: true };
        loadedFromBundle++;
        if (onProgress) onProgress(i + 1, watchlist.length, item.name);
      }
    }
    
    // 剩下的逐个加载（串行 + 随机延迟，降低被限流风险）
    let networkCount = 0;
    for (let i = 0; i < watchlist.length; i++) {
      const item = watchlist[i];
      if (results[item.code]) continue;
      
      if (onProgress) onProgress(i + 1, watchlist.length, item.name);
      
      try {
        const result = await this.getData(item.code, item.name, item.type, forceRefresh);
        results[item.code] = { ...item, ...result };
        
        // 非首次且有网络请求时，加随机延迟（500-1200ms）
        networkCount++;
        if (result.source !== 'cache' && result.source !== 'bundle') {
          const delay = 500 + Math.random() * 700;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } catch (e) {
        console.error(`加载 ${item.code} 失败:`, e.message);
        // 单只失败不影响整体，标记错误状态
        results[item.code] = { 
          ...item, 
          data: [], 
          source: 'error', 
          error: e.message || '加载失败',
          fromCache: false 
        };
      }
    }
    
    return results;
  },

  /**
   * 智能刷新：只刷新缓存过期的股票（更省流量、更安全）
   * @param {Array} watchlist - 自选列表
   * @param {Number} maxAgeHours - 缓存有效期（小时），默认6小时
   * @param {Function} onProgress - 进度回调
   * @returns {Object} 刷新结果
   */
  async smartRefresh(watchlist, maxAgeHours = 6, onProgress = null) {
    const results = {};
    const staleCodes = [];
    
    // 第一步：先全部从缓存/bundle加载，同时找出过期的
    for (let i = 0; i < watchlist.length; i++) {
      const item = watchlist[i];
      
      // 尝试bundle
      const bundleData = this.getFromBundle(item.code);
      if (bundleData && bundleData.length > 0) {
        results[item.code] = { ...item, data: bundleData, source: 'bundle', fromCache: true };
        // bundle数据也需要刷新（bundle是内置的，可能过期）
        if (!this.isCacheFresh(item.code, maxAgeHours)) {
          staleCodes.push(item);
        }
        continue;
      }
      
      // 尝试缓存
      const cached = this.getCachedData(item.code);
      if (cached && cached.length > 0) {
        results[item.code] = { ...item, data: cached, source: 'cache', fromCache: true };
        if (!this.isCacheFresh(item.code, maxAgeHours)) {
          staleCodes.push(item);
        }
        continue;
      }
      
      // 没有缓存，需要网络请求
      staleCodes.push(item);
    }
    
    // 第二步：逐个刷新过期的股票（串行 + 随机延迟）
    let refreshedCount = 0;
    for (const item of staleCodes) {
      try {
        const result = await this.getData(item.code, item.name, item.type, true);
        if (result.data && result.data.length > 0) {
          results[item.code] = { ...item, ...result };
          refreshedCount++;
        }
      } catch (e) {
        console.warn(`刷新 ${item.code} 失败:`, e);
      }
      
      // 随机延迟（500-1200ms），降低被限流风险
      if (staleCodes.length > 1) {
        const delay = 500 + Math.random() * 700;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    return { results, refreshed: refreshedCount, total: staleCodes.length };
  },

  /**
   * 清除所有缓存
   */
  clearCache() {
    localStorage.removeItem(this.STORAGE_KEY);
    // 注意：不清除 bundleData，那是内置数据
  },
};
