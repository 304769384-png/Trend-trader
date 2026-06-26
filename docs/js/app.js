/**
 * 趋势交易助手 - 主应用逻辑
 */

const App = {
  currentPage: 'home',
  watchlist: [],
  settings: {},
  stockData: {},
  signals: {},
  detailCode: null,
  chartInstance: null,
  manageMode: false,
  currentSearchResult: null,
  isRefreshing: false,
  detailTimeoutId: null,
  currentStrategy: 'composite', // 默认复合策略（向后兼容）

  /**
   * 初始化
   */
  async init() {
    this.watchlist = DataManager.getWatchlist();
    this.settings = DataManager.getSettings();

    // 读取保存的策略类型，向后兼容：如果没有 strategy 字段，默认使用 composite
    const savedSettings = this.settings;
    if (savedSettings.strategy && StrategyEngine.STRATEGIES[savedSettings.strategy]) {
      this.currentStrategy = savedSettings.strategy;
    } else {
      // 旧版本没有 strategy 字段，升级到 composite 并更新默认参数
      this.currentStrategy = 'composite';
      this.settings.fastMA = 20;
      this.settings.slowMA = 60;
      this.settings.strategy = 'composite';
      DataManager.saveSettings(this.settings);
    }

    this.bindEvents();
    this.showPage('home');

    // 先加载bundle数据（快速显示）
    await DataManager.init();

    // 第一步：从bundle/缓存加载，立即显示
    await this.loadAllData(false);

    // 第二步：后台静默刷新，获取最新数据
    this.silentRefresh();
  },

  /**
   * 后台静默刷新数据（智能刷新：只刷新缓存过期的股票）
   */
  async silentRefresh() {
    try {
      // 智能刷新：缓存6小时内的股票不刷新，减少请求量
      const result = await DataManager.smartRefresh(this.watchlist, 6, null);
      
      // 只更新有刷新到的股票数据
      if (result.refreshed > 0) {
        for (const code in result.results) {
          this.stockData[code] = result.results[code];
        }
        this.computeAllSignals();
        this.renderHome();
        console.log(`后台刷新完成：更新了 ${result.refreshed}/${result.total} 只股票`);
      } else {
        console.log('数据已是最新，无需刷新');
      }
    } catch (e) {
      console.warn('后台刷新失败:', e);
    }
  },

  /**
   * 绑定事件
   */
  bindEvents() {
    // Tab切换
    document.querySelectorAll('.tab-item').forEach(tab => {
      tab.addEventListener('click', () => {
        const page = tab.dataset.page;
        this.switchTab(page);
      });
    });

    // 刷新按钮
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this.refreshAll());
    }

    // 设置保存
    const saveSettingsBtn = document.getElementById('saveSettingsBtn');
    if (saveSettingsBtn) {
      saveSettingsBtn.addEventListener('click', () => this.saveSettings());
    }

    // 清除缓存
    const clearCacheBtn = document.getElementById('clearCacheBtn');
    if (clearCacheBtn) {
      clearCacheBtn.addEventListener('click', () => this.clearCache());
    }

    // 恢复默认设置
    const restoreDefaultBtn = document.getElementById('restoreDefaultBtn');
    if (restoreDefaultBtn) {
      restoreDefaultBtn.addEventListener('click', () => this.restoreDefaultSettings());
    }

    // 返回按钮
    const backBtn = document.getElementById('backBtn');
    if (backBtn) {
      backBtn.addEventListener('click', () => this.showPage('home'));
    }

    // 搜索按钮
    const searchBtn = document.getElementById('searchBtn');
    if (searchBtn) {
      searchBtn.addEventListener('click', () => this.handleSearch());
    }

    // 搜索输入框回车
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.handleSearch();
        }
      });
    }

    // 管理按钮
    const manageBtn = document.getElementById('manageBtn');
    if (manageBtn) {
      manageBtn.addEventListener('click', () => this.toggleManageMode());
    }

    // 策略选择器
    const strategySelector = document.getElementById('strategySelector');
    if (strategySelector) {
      strategySelector.addEventListener('click', (e) => {
        const option = e.target.closest('.strategy-option');
        if (!option) return;
        const strategyId = option.dataset.strategy;
        this.switchStrategy(strategyId);
      });
    }
  },

  /**
   * 切换Tab
   */
  switchTab(page) {
    // 更新tab状态
    document.querySelectorAll('.tab-item').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.page === page);
    });

    if (page === 'home') {
      this.showPage('home');
    } else if (page === 'settings') {
      this.showPage('settings');
      this.renderSettings();
    }
  },

  /**
   * 显示页面
   */
  showPage(page) {
    this.currentPage = page;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const pageEl = document.getElementById(page + 'Page');
    if (pageEl) pageEl.classList.add('active');

    // 更新导航
    const navTitle = document.getElementById('navTitle');
    const navRight = document.getElementById('navRight');
    const backBtn = document.getElementById('backBtn');

    if (page === 'home') {
      navTitle.textContent = '趋势交易助手';
      navRight.style.display = 'flex';
      backBtn.style.display = 'none';
    } else if (page === 'detail') {
      const stock = this.stockData[this.detailCode];
      navTitle.textContent = stock ? stock.name : '详情';
      navRight.style.display = 'none';
      backBtn.style.display = 'flex';
    } else if (page === 'settings') {
      navTitle.textContent = '策略设置';
      navRight.style.display = 'none';
      backBtn.style.display = 'none';
    }
  },

  /**
   * 加载所有数据
   */
  async loadAllData(forceRefresh = false) {
    if (this.isRefreshing) return; // 防止重复刷新
    this.isRefreshing = true;
    
    const loadingEl = document.getElementById('homeLoading');
    const listEl = document.getElementById('stockList');
    const statsEl = document.getElementById('statsGrid');
    const refreshBtn = document.getElementById('refreshBtn');

    loadingEl.style.display = 'block';
    listEl.style.display = 'none';
    statsEl.style.display = 'none';
    if (refreshBtn) refreshBtn.style.opacity = '0.5';

    try {
      const results = await DataManager.getAllData(
        this.watchlist,
        forceRefresh,
        (current, total, name) => {
          const loadingText = document.querySelector('#homeLoading .loading-text');
          if (loadingText) {
            loadingText.textContent = `正在加载 ${name} (${current}/${total})...`;
          }
        }
      );

      this.stockData = results;
      this.computeAllSignals();
      this.renderHome();

      loadingEl.style.display = 'none';
      listEl.style.display = 'block';
      statsEl.style.display = 'grid';
    } catch (e) {
      console.error('加载数据失败:', e);
      loadingEl.style.display = 'none';
      listEl.style.display = 'block';
      statsEl.style.display = 'grid';
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">😔</div>
          <div class="empty-text">数据加载失败</div>
          <div style="font-size: 12px; color: var(--text-secondary); margin-top: 8px;">
            ${e.message || '请检查网络连接后重试'}
          </div>
          <button class="btn btn-primary" style="margin-top: 16px; width: auto; padding: 10px 24px;" onclick="App.refreshAll()">
            重新加载
          </button>
        </div>
      `;
    } finally {
      this.isRefreshing = false;
      if (refreshBtn) refreshBtn.style.opacity = '1';
    }
  },

  /**
   * 计算所有股票的信号
   */
  computeAllSignals() {
    this.signals = {};

    for (const item of this.watchlist) {
      const stock = this.stockData[item.code];
      if (!stock || !stock.data || stock.data.length === 0) continue;

      try {
        // 计算指标
        const withIndicators = StrategyEngine.computeIndicators(stock.data);

        // 计算信号（使用当前策略）
        const signal = StrategyEngine.getStrategySignal(withIndicators, this.currentStrategy, this.settings);
        
        // 检查信号是否有效
        if (signal.error) {
          console.warn(`信号计算失败 ${item.code}: ${signal.error}`);
          this.signals[item.code] = {
            signal: '⚠️ 数据不足',
            signalType: 'sell',
            action: '数据量不足，无法计算有效信号',
            confirmDays: 0,
            requiredConfirm: this.settings.entryConfirm,
            checks: {},
            latest: { price: stock.data[stock.data.length - 1]?.close || 0, date: stock.data[stock.data.length - 1]?.date || '' },
            missing: ['数据不足'],
            withIndicators,
            error: signal.error,
          };
          continue;
        }

        this.signals[item.code] = {
          ...signal,
          withIndicators,
        };
      } catch (e) {
        console.error(`计算信号失败 ${item.code}:`, e);
        this.signals[item.code] = {
          signal: '❌ 计算失败',
          signalType: 'sell',
          action: '信号计算异常，请刷新重试',
          confirmDays: 0,
          requiredConfirm: this.settings.entryConfirm,
          checks: {},
          latest: { price: stock.data[stock.data.length - 1]?.close || 0, date: stock.data[stock.data.length - 1]?.date || '' },
          missing: ['计算异常'],
          withIndicators: stock.data || [],
          error: e.message,
        };
      }
    }
  },

  /**
   * 搜索并添加股票
   */
  async handleSearch() {
    const input = document.getElementById('searchInput');
    const code = input.value.trim();
    const btn = document.getElementById('searchBtn');
    const resultEl = document.getElementById('searchResult');

    if (!code) {
      this.showToast('请输入股票代码');
      return;
    }

    // 简单验证
    if (!/^\d{6}$/.test(code.split('.')[0])) {
      this.showToast('请输入6位股票/ETF代码');
      return;
    }

    // 检查是否已在自选
    const exists = this.watchlist.find(s => s.code.startsWith(code) || code.startsWith(s.code.split('.')[0]));
    if (exists) {
      this.showToast('已在自选列表中');
      return;
    }

    // 开始下载
    btn.disabled = true;
    btn.textContent = '下载中...';
    resultEl.style.display = 'block';
    resultEl.innerHTML = `
      <div class="search-result-card">
        <div class="loading" style="padding: 20px;">
          <div class="loading-spinner"></div>
          <div class="loading-text">正在下载 ${code} 的历史数据...</div>
        </div>
      </div>
    `;

    try {
      // 判断类型
      let type = 'stock';
      let name = code;
      let fullCode = code;
      
      if (code.startsWith('5') || code.startsWith('15') || code.startsWith('5')) {
        type = 'etf';
      }
      
      // 补齐交易所后缀
      if (!code.includes('.')) {
        if (code.startsWith('6') || code.startsWith('5')) {
          fullCode = code + '.SH';
        } else {
          fullCode = code + '.SZ';
        }
      }

      // 下载数据（强制刷新，使用后端API）
      const result = await DataManager.getData(fullCode, name, type, true);
      
      if (!result.data || result.data.length === 0) {
        throw new Error(result.error || '无法获取数据，请检查代码是否正确');
      }

      // 用后端返回的名称（如果有）
      if (result.name && result.name !== fullCode && result.name !== code) {
        name = result.name;
      }
      if (result.type) {
        type = result.type;
      }

      // 计算指标和信号
      const withIndicators = StrategyEngine.computeIndicators(result.data);
      const signal = StrategyEngine.getStrategySignal(withIndicators, this.currentStrategy, this.settings);
      
      // 运行回测
      const backtest = StrategyEngine.runStrategyBacktest(withIndicators, this.currentStrategy, this.settings);

      // 如果API没有返回名称，尝试从已知映射获取
      if (!name || name === code || name === fullCode) {
        name = this.guessName(fullCode) || this.guessName(code) || code;
      }

      this.currentSearchResult = {
        code: fullCode,
        name,
        type,
        data: result.data,
        signal,
        backtest,
        withIndicators,
      };

      // 显示结果
      this.renderSearchResult();

    } catch (e) {
      console.error('搜索失败:', e);
      resultEl.innerHTML = `
        <div class="search-result-card">
          <div class="empty-state">
            <div class="empty-icon">😔</div>
            <div class="empty-text">下载失败：${e.message || '未知错误'}</div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 8px;">
              请检查代码是否正确，或稍后重试
            </div>
          </div>
        </div>
      `;
    } finally {
      btn.disabled = false;
      btn.textContent = '添加';
    }
  },

  /**
   * 渲染搜索结果
   */
  renderSearchResult() {
    const resultEl = document.getElementById('searchResult');
    const r = this.currentSearchResult;
    if (!r) return;

    const bt = r.backtest;
    const sig = r.signal;

    resultEl.innerHTML = `
      <div class="search-result-card">
        <div class="search-result-header">
          <div>
            <div class="search-result-name">${this.escapeHtml(r.name)}</div>
            <div class="search-result-code">${this.escapeHtml(r.code)}</div>
          </div>
          <span class="signal-badge ${sig.signalType}">${this.escapeHtml(sig.signal)}</span>
        </div>
        <div class="search-result-metrics">
          <div class="search-result-metric">
            <div class="sr-metric-value ${bt.totalReturn >= 0 ? '' : ''}" style="color: ${bt.totalReturn >= 0 ? 'var(--success)' : 'var(--danger)'}">${(bt.totalReturn * 100).toFixed(1)}%</div>
            <div class="sr-metric-label">总收益</div>
          </div>
          <div class="search-result-metric">
            <div class="sr-metric-value">${(bt.winRate * 100).toFixed(1)}%</div>
            <div class="sr-metric-label">胜率</div>
          </div>
          <div class="search-result-metric">
            <div class="sr-metric-value">${bt.profitLossRatio.toFixed(2)}</div>
            <div class="sr-metric-label">盈亏比</div>
          </div>
        </div>
        <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 12px;">
          共 ${r.data.length} 个交易日 · ${bt.nTrades} 笔交易 · 最大回撤 ${(bt.maxDrawdown * 100).toFixed(1)}%
        </div>
        <div class="search-result-actions">
          <button class="btn btn-secondary" onclick="App.clearSearchResult()">取消</button>
          <button class="btn btn-primary" onclick="App.addToWatchlist()">加入自选</button>
        </div>
      </div>
    `;
  },

  /**
   * 清除搜索结果
   */
  clearSearchResult() {
    const resultEl = document.getElementById('searchResult');
    resultEl.style.display = 'none';
    document.getElementById('searchInput').value = '';
    this.currentSearchResult = null;
  },

  /**
   * 加入自选
   */
  addToWatchlist() {
    if (!this.currentSearchResult) return;

    const r = this.currentSearchResult;
    
    // 添加到自选列表
    this.watchlist.unshift({
      code: r.code,
      name: r.name,
      type: r.type,
    });
    DataManager.saveWatchlist(this.watchlist);

    // 添加到数据缓存
    this.stockData[r.code] = {
      code: r.code,
      name: r.name,
      type: r.type,
      data: r.data,
      source: 'sina',
      fromCache: false,
    };

    // 计算信号
    this.signals[r.code] = {
      ...r.signal,
      withIndicators: r.withIndicators,
    };

    // 重新渲染
    this.renderHome();
    this.clearSearchResult();
    this.showToast(`已添加 ${r.name} 到自选`);
  },

  /**
   * 猜测名称（从已知映射获取）
   */
  guessName(code) {
    const known = {
      '512000.SH': '证券ETF',
      '512000': '证券ETF',
      '159819.SZ': '人工智能ETF',
      '159819': '人工智能ETF',
      '159562.SZ': '黄金股ETF',
      '159562': '黄金股ETF',
      '510300.SH': '沪深300ETF',
      '510300': '沪深300ETF',
      '510500.SH': '中证500ETF',
      '510500': '中证500ETF',
      '518880.SH': '黄金ETF',
      '518880': '黄金ETF',
      '513100.SH': '纳指ETF',
      '513100': '纳指ETF',
      '159915.SZ': '创业板ETF',
      '159915': '创业板ETF',
      '588000.SH': '科创50ETF',
      '588000': '科创50ETF',
      '512660.SH': '军工ETF',
      '512660': '军工ETF',
      '512010.SH': '医药ETF',
      '512010': '医药ETF',
      '512690.SH': '酒ETF',
      '512690': '酒ETF',
      '159901.SZ': '深100ETF',
      '159901': '深100ETF',
      '515790.SH': '光伏ETF',
      '515790': '光伏ETF',
      '515030.SH': '新能源车ETF',
      '515030': '新能源车ETF',
    };
    return known[code] || null;
  },

  /**
   * HTML转义，防止XSS
   */
  escapeHtml(str) {
    if (str === null || str === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  },

  /**
   * 切换管理模式
   */
  toggleManageMode() {
    this.manageMode = !this.manageMode;
    const btn = document.getElementById('manageBtn');
    btn.textContent = this.manageMode ? '完成' : '管理';
    this.renderHome();
  },

  /**
   * 从自选删除
   */
  removeFromWatchlist(code) {
    const stock = this.stockData[code];
    const name = stock?.name || code;
    
    if (!confirm(`确定要删除 ${name} 吗？`)) return;

    this.watchlist = this.watchlist.filter(s => s.code !== code);
    DataManager.saveWatchlist(this.watchlist);
    
    delete this.stockData[code];
    delete this.signals[code];
    
    this.renderHome();
    this.showToast('已删除');
  },

  /**
   * 渲染首页
   */
  renderHome() {
    const listEl = document.getElementById('stockList');
    const statsEl = document.getElementById('statsGrid');
    const countEl = document.getElementById('watchlistCount');

    // 更新计数
    if (countEl) countEl.textContent = `（${this.watchlist.length}只）`;

    // 统计
    let buyCount = 0, watchCount = 0, sellCount = 0;
    for (const code in this.signals) {
      const type = this.signals[code].signalType;
      if (type === 'buy') buyCount++;
      else if (type === 'watch') watchCount++;
      else sellCount++;
    }

    // 更新概览卡片
    const overviewValue = document.getElementById('overviewValue');
    const overviewBuy = document.getElementById('overviewBuy');
    const overviewWatch = document.getElementById('overviewWatch');
    const overviewSell = document.getElementById('overviewSell');
    if (overviewValue) overviewValue.textContent = `${this.watchlist.length} 只`;
    if (overviewBuy) overviewBuy.textContent = buyCount;
    if (overviewWatch) overviewWatch.textContent = watchCount;
    if (overviewSell) overviewSell.textContent = sellCount;

    // 同时更新统计网格
    statsEl.innerHTML = `
      <div class="stat-card">
        <div class="stat-value success">${buyCount}</div>
        <div class="stat-label">买入</div>
      </div>
      <div class="stat-card">
        <div class="stat-value warning">${watchCount}</div>
        <div class="stat-label">观察</div>
      </div>
      <div class="stat-card">
        <div class="stat-value danger">${sellCount}</div>
        <div class="stat-label">观望</div>
      </div>
    `;

    // 股票列表
    let html = '<div class="stock-list">';

    // 按信号类型排序：买入 > 观察 > 观望（使用 slice 避免修改原数组）
    const sorted = [...this.watchlist].sort((a, b) => {
      const sa = this.signals[a.code]?.signalType || 'sell';
      const sb = this.signals[b.code]?.signalType || 'sell';
      const order = { buy: 0, watch: 1, sell: 2 };
      return order[sa] - order[sb];
    });

    for (const stock of sorted) {
      const signal = this.signals[stock.code];
      if (!signal) continue;

      const latestPrice = signal.latest?.price || 0;
      const signalType = signal.signalType;
      const signalText = signal.signal.split(' ')[1] || '';

      html += `
        <div class="stock-item ${this.manageMode ? 'manage-mode' : ''}" 
             onclick="${this.manageMode ? '' : `App.showDetail('${stock.code}')`}">
          ${this.manageMode ? `
            <span class="delete-icon" onclick="event.stopPropagation(); App.removeFromWatchlist('${stock.code}')">✕</span>
          ` : ''}
          <div class="stock-info">
            <div class="stock-name">${this.escapeHtml(stock.name)}</div>
            <div class="stock-code">${this.escapeHtml(stock.code)}</div>
          </div>
          <div class="stock-right">
            <div class="stock-price">${latestPrice.toFixed(2)}</div>
            <span class="signal-badge ${signalType}">${signalText}</span>
          </div>
          ${this.manageMode ? `
            <span class="edit-icon" onclick="event.stopPropagation(); App.editStockName('${stock.code}')">✎</span>
          ` : `<div class="stock-arrow">›</div>`}
        </div>
      `;
    }

    html += '</div>';

    if (sorted.length === 0) {
      html = `
        <div class="empty-state">
          <div class="empty-icon">📭</div>
          <div class="empty-text">自选列表为空</div>
          <div style="font-size: 12px; color: var(--text-secondary); margin-top: 8px;">
            在上方输入框添加股票/ETF
          </div>
        </div>
      `;
    }

    listEl.innerHTML = html;
  },

  /**
   * 编辑股票名称
   */
  editStockName(code) {
    const stock = this.watchlist.find(s => s.code === code);
    if (!stock) return;

    const newName = prompt('编辑名称:', stock.name);
    if (newName && newName.trim()) {
      stock.name = newName.trim();
      DataManager.saveWatchlist(this.watchlist);
      
      // 同步更新stockData
      if (this.stockData[code]) {
        this.stockData[code].name = newName.trim();
      }
      
      this.renderHome();
      this.showToast('名称已更新');
    }
  },

  /**
   * 显示详情页
   */
  async showDetail(code) {
    this.detailCode = code;
    const stock = this.stockData[code];
    const signal = this.signals[code];

    if (!stock || !signal) {
      this.showToast('数据不可用');
      return;
    }

    this.showPage('detail');

    // 头部信息
    const detailHeader = document.getElementById('detailHeader');
    detailHeader.innerHTML = `
      <div>
        <div class="detail-title">${this.escapeHtml(stock.name)}</div>
        <div class="detail-subtitle">${this.escapeHtml(stock.code)}</div>
        <div class="detail-price">${signal.latest.price.toFixed(2)}</div>
      </div>
      <div class="detail-signal">
        <span class="signal-badge ${signal.signalType}">${this.escapeHtml(signal.signal)}</span>
      </div>
    `;

    // 渲染图表
    this.renderChart(code);

    // 数据范围信息
    const dataRange = document.getElementById('dataRange');
    if (dataRange && signal.withIndicators) {
      const allData = signal.withIndicators;
      const firstDate = allData[0]?.date || '';
      const lastDate = allData[allData.length - 1]?.date || '';
      dataRange.textContent = `${firstDate} 至 ${lastDate} · 共 ${allData.length} 个交易日`;
    }

    // 操作建议
    const actionBox = document.getElementById('actionBox');
    actionBox.className = `action-box ${signal.signalType}`;
    actionBox.innerHTML = `
      <div class="action-title">${this.escapeHtml(signal.signal)}</div>
      <div class="action-text">${this.escapeHtml(signal.action)}</div>
    `;

    // 信号检查（根据策略显示不同检查项）
    const checks = signal.checks;
    const checksEl = document.getElementById('signalChecks');
    checksEl.innerHTML = this.renderSignalChecks(signal);

    // 计算回测数据（延迟，避免阻塞UI）
    if (this.detailTimeoutId) {
      clearTimeout(this.detailTimeoutId);
    }
    this.detailTimeoutId = setTimeout(() => {
      // 检查是否仍然是当前详情页的股票
      if (this.detailCode !== code) return;
      
      // 检查数据可用性
      if (!signal.withIndicators || signal.withIndicators.length === 0) {
        console.warn(`详情页回测: ${code} 无指标数据`);
        this.renderDetailMetrics({ error: '无数据', nTrades: 0 });
        this.renderTrades([]);
        return;
      }
      
      const backtest = StrategyEngine.runStrategyBacktest(signal.withIndicators, this.currentStrategy, this.settings);
      console.log(`详情页回测: ${code}, 策略=${this.currentStrategy}, 数据量=${signal.withIndicators.length}, 交易数=${backtest.nTrades}`);
      this.renderDetailMetrics(backtest);
      this.renderTrades(backtest.trades.slice(-10).reverse()); // 最近10笔
    }, 100);
  },

  /**
   * 渲染图表
   */
  renderChart(code) {
    const signal = this.signals[code];
    if (!signal) return;

    // 检查 ECharts 是否可用
    if (typeof echarts === 'undefined') {
      const chartDom = document.getElementById('detailChart');
      if (chartDom) {
        chartDom.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);font-size:14px;">图表组件加载失败，请刷新页面重试</div>';
      }
      console.error('ECharts 未加载');
      return;
    }

    const data = signal.withIndicators;
    const backtest = StrategyEngine.runStrategyBacktest(data, this.currentStrategy, this.settings);

    // 显示全部数据（与回测数据范围一致）
    const displayData = data;
    const dates = displayData.map(d => d.date.slice(5));
    const closes = displayData.map(d => d.close);

    // 买卖点
    const buyPoints = [];
    const sellPoints = [];
    for (const trade of backtest.trades) {
      const entryIdx = data.findIndex(d => d.date === trade.entryDate);
      const exitIdx = data.findIndex(d => d.date === trade.exitDate);

      if (entryIdx >= 0) {
        buyPoints.push([entryIdx, trade.entryPrice]);
      }
      if (exitIdx >= 0) {
        sellPoints.push([exitIdx, trade.exitPrice, trade.pnl * 100]);
      }
    }

    // 根据策略类型构建不同的指标线
    const indicatorSeries = [];

    if (this.currentStrategy === 'macd_cross') {
      // MACD策略：显示DIF、DEA
      const macdFast = this.settings.macdFast || 12;
      const macdSlow = this.settings.macdSlow || 26;
      indicatorSeries.push({
        name: `DIF(${macdFast},${macdSlow})`,
        type: 'line',
        data: displayData.map(d => d.macd),
        lineStyle: { width: 1.5, color: '#FF9500' },
        showSymbol: false,
        z: 1,
      });
      indicatorSeries.push({
        name: 'DEA',
        type: 'line',
        data: displayData.map(d => d.macdSignal),
        lineStyle: { width: 1.5, color: '#34C759' },
        showSymbol: false,
        z: 1,
      });
    } else if (this.currentStrategy === 'ma_cross') {
      // MA策略：显示快/慢均线
      const fastMA = this.settings.fastMA || 20;
      const slowMA = this.settings.slowMA || 60;
      indicatorSeries.push({
        name: `MA${fastMA}`,
        type: 'line',
        data: displayData.map(d => d[`ma${fastMA}`]),
        lineStyle: { width: 1.5, color: '#FF9500' },
        showSymbol: false,
        z: 1,
      });
      indicatorSeries.push({
        name: `MA${slowMA}`,
        type: 'line',
        data: displayData.map(d => d[`ma${slowMA}`]),
        lineStyle: { width: 1.5, color: '#34C759' },
        showSymbol: false,
        z: 1,
      });
    } else {
      // 复合策略：显示MA快线、慢线、MA60
      const fastMA = this.settings.fastMA || 20;
      const slowMA = this.settings.slowMA || 60;
      indicatorSeries.push({
        name: `MA${fastMA}`,
        type: 'line',
        data: displayData.map(d => d[`ma${fastMA}`]),
        lineStyle: { width: 1.5, color: '#FF9500' },
        showSymbol: false,
        z: 1,
      });
      indicatorSeries.push({
        name: `MA${slowMA}`,
        type: 'line',
        data: displayData.map(d => d[`ma${slowMA}`]),
        lineStyle: { width: 1.5, color: '#34C759' },
        showSymbol: false,
        z: 1,
      });
      indicatorSeries.push({
        name: 'MA60',
        type: 'line',
        data: displayData.map(d => d.ma60),
        lineStyle: { width: 1, color: '#8E8E93', type: 'dashed' },
        showSymbol: false,
        z: 1,
      });
    }

    const chartDom = document.getElementById('detailChart');
    if (!this.chartInstance) {
      this.chartInstance = echarts.init(chartDom, null, {
        renderer: 'canvas',
        devicePixelRatio: Math.min(window.devicePixelRatio || 2, 3),
        useDirtyRect: true,
      });
      // 监听窗口大小变化 + 屏幕旋转 + 视觉视口变化（iOS键盘/Safari工具栏）
      const resizeChart = () => {
        if (this.chartInstance && this.currentPage === 'detail') {
          this.chartInstance.resize();
        }
      };
      window.addEventListener('resize', resizeChart);
      window.addEventListener('orientationchange', () => setTimeout(resizeChart, 300));
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', resizeChart);
      }
    }
    
    // 默认显示最近120天，但可通过dataZoom查看全部
    const defaultEnd = 100;
    const defaultStart = data.length > 120 ? Math.round((1 - 120 / data.length) * 100) : 0;

    const option = {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line' },
        backgroundColor: 'rgba(0,0,0,0.85)',
        borderWidth: 0,
        textStyle: { color: '#fff', fontSize: 12 },
        confine: true,
        formatter: function(params) {
          let res = displayData[params[0].dataIndex]?.date || '';
          res += '<br/>';
          params.forEach(p => {
            if (p.seriesName === '买入点') {
              res += '🟢 买入: ' + p.value[1].toFixed(2) + '<br/>';
            } else if (p.seriesName === '卖出点') {
              const pnl = p.value[2];
              res += '🔴 卖出: ' + p.value[1].toFixed(2);
              if (pnl !== undefined) res += ' (' + (pnl > 0 ? '+' : '') + pnl.toFixed(1) + '%)';
              res += '<br/>';
            } else {
              res += p.marker + p.seriesName + ': ' + (typeof p.value === 'number' ? p.value.toFixed(4) : '') + '<br/>';
            }
          });
          return res;
        }
      },
      grid: { left: '3%', right: '4%', bottom: '15%', top: '10%', containLabel: true },
      dataZoom: [
        {
          type: 'inside',
          start: defaultStart,
          end: defaultEnd,
        },
        {
          type: 'slider',
          start: defaultStart,
          end: defaultEnd,
          height: 28,
          bottom: 5,
          borderColor: 'transparent',
          backgroundColor: 'rgba(0,0,0,0.05)',
          fillerColor: 'rgba(0,122,255,0.15)',
          handleStyle: { color: '#007AFF', borderWidth: 2 },
          moveHandleSize: 12,
          textStyle: { fontSize: 10 },
        },
      ],
      xAxis: {
        type: 'category',
        data: dates,
        axisLabel: {
          fontSize: 10,
          interval: Math.floor(dates.length / 8),
        },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLabel: { fontSize: 10 },
        splitLine: { lineStyle: { type: 'dashed', opacity: 0.3 } },
      },
      series: [
        {
          name: '收盘价',
          type: 'line',
          data: closes,
          lineStyle: { width: 2, color: '#007AFF' },
          showSymbol: false,
          z: 1,
        },
        ...indicatorSeries,
        {
          name: '买入点',
          type: 'scatter',
          data: buyPoints,
          symbolSize: 10,
          itemStyle: { color: '#34C759', borderColor: '#fff', borderWidth: 2 },
          z: 10,
        },
        {
          name: '卖出点',
          type: 'scatter',
          data: sellPoints,
          symbolSize: 10,
          itemStyle: { color: '#FF3B30', borderColor: '#fff', borderWidth: 2 },
          z: 10,
        },
      ],
    };

    this.chartInstance.setOption(option, true); // true = 不合并，完全替换
  },

  /**
   * 渲染详情页指标
   */
  renderDetailMetrics(backtest) {
    const el = document.getElementById('detailMetrics');
    if (!el) return;

    if (backtest.error || backtest.nTrades === 0) {
      el.innerHTML = `
        <div class="detail-metric">
          <div class="detail-metric-value" style="color: var(--text-secondary)">--</div>
          <div class="detail-metric-label">总收益</div>
        </div>
        <div class="detail-metric">
          <div class="detail-metric-value" style="color: var(--text-secondary)">--</div>
          <div class="detail-metric-label">年化收益</div>
        </div>
        <div class="detail-metric">
          <div class="detail-metric-value" style="color: var(--text-secondary)">--</div>
          <div class="detail-metric-label">胜率</div>
        </div>
        <div class="detail-metric">
          <div class="detail-metric-value" style="color: var(--text-secondary)">--</div>
          <div class="detail-metric-label">盈亏比</div>
        </div>
        <div class="detail-metric">
          <div class="detail-metric-value" style="color: var(--text-secondary)">--</div>
          <div class="detail-metric-label">期望值/笔</div>
        </div>
        <div class="detail-metric">
          <div class="detail-metric-value" style="color: var(--text-secondary)">--</div>
          <div class="detail-metric-label">最大回撤</div>
        </div>
      `;
      return;
    }

    const totalReturnColor = backtest.totalReturn >= 0 ? 'var(--success)' : 'var(--danger)';
    el.innerHTML = `
      <div class="detail-metric">
        <div class="detail-metric-value" style="color: ${totalReturnColor}">${(backtest.totalReturn * 100).toFixed(2)}%</div>
        <div class="detail-metric-label">总收益</div>
      </div>
      <div class="detail-metric">
        <div class="detail-metric-value">${(backtest.annualReturn * 100).toFixed(2)}%</div>
        <div class="detail-metric-label">年化收益</div>
      </div>
      <div class="detail-metric">
        <div class="detail-metric-value">${(backtest.winRate * 100).toFixed(1)}%</div>
        <div class="detail-metric-label">胜率</div>
      </div>
      <div class="detail-metric">
        <div class="detail-metric-value">${backtest.profitLossRatio.toFixed(2)}</div>
        <div class="detail-metric-label">盈亏比</div>
      </div>
      <div class="detail-metric">
        <div class="detail-metric-value">${(backtest.expectancy * 100).toFixed(2)}%</div>
        <div class="detail-metric-label">期望值/笔</div>
      </div>
      <div class="detail-metric">
        <div class="detail-metric-value">${(backtest.maxDrawdown * 100).toFixed(1)}%</div>
        <div class="detail-metric-label">最大回撤</div>
      </div>
    `;
  },

  /**
   * 渲染交易记录
   */
  renderTrades(trades) {
    const el = document.getElementById('tradesList');
    if (!el) return;

    if (trades.length === 0) {
      el.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-text">暂无交易记录</div></div>';
      return;
    }

    let html = '';
    for (const trade of trades) {
      const isWin = trade.pnl > 0;
      html += `
        <div class="trade-item">
          <div>
            <div class="trade-dates">${trade.entryDate?.slice(5)} → ${trade.exitDate?.slice(5)}</div>
            <div class="trade-reason">${trade.reason || ''} · ${trade.holdDays || 0}天</div>
          </div>
          <div class="trade-pnl ${isWin ? 'win' : 'lose'}">${isWin ? '+' : ''}${(trade.pnl * 100).toFixed(2)}%</div>
        </div>
      `;
    }
    el.innerHTML = html;
  },

  /**
   * 渲染设置页
   */
  renderSettings() {
    // 更新策略选择器UI
    document.querySelectorAll('.strategy-option').forEach(opt => {
      opt.classList.toggle('active', opt.dataset.strategy === this.currentStrategy);
    });

    // 显示/隐藏对应参数组
    document.querySelectorAll('.strategy-params').forEach(p => {
      p.classList.toggle('active', p.id === `params_${this.currentStrategy}`);
    });

    // 根据策略填充参数
    if (this.currentStrategy === 'macd_cross') {
      document.getElementById('macdFastInput').value = this.settings.macdFast || 12;
      document.getElementById('macdSlowInput').value = this.settings.macdSlow || 26;
      document.getElementById('macdSignalInput').value = this.settings.macdSignal || 9;
      document.getElementById('zeroAxisFilterInput').checked = this.settings.zeroAxisFilter !== false;
    } else if (this.currentStrategy === 'ma_cross') {
      document.getElementById('maFastInput').value = this.settings.fastMA || 20;
      document.getElementById('maSlowInput').value = this.settings.slowMA || 60;
    } else {
      // composite
      document.getElementById('fastMAInput').value = this.settings.fastMA;
      document.getElementById('slowMAInput').value = this.settings.slowMA;
      document.getElementById('rsiLowInput').value = this.settings.rsiLow;
      document.getElementById('rsiHighInput').value = this.settings.rsiHigh;
      document.getElementById('entryConfirmInput').value = this.settings.entryConfirm;
      document.getElementById('exitConfirmInput').value = this.settings.exitConfirm;
      document.getElementById('useMACDInput').checked = this.settings.useMACD;
      document.getElementById('useRSIInput').checked = this.settings.useRSI;
      document.getElementById('useMA60Input').checked = this.settings.useMA60 || false;
      document.getElementById('useVolumeInput').checked = this.settings.useVolume || false;
      document.getElementById('volumeRatioInput').value = this.settings.volumeRatio || 1.5;
    }
  },

  /**
   * 保存设置
   */
  saveSettings() {
    const errors = [];

    if (this.currentStrategy === 'macd_cross') {
      const macdFast = parseInt(document.getElementById('macdFastInput').value);
      const macdSlow = parseInt(document.getElementById('macdSlowInput').value);
      const macdSignal = parseInt(document.getElementById('macdSignalInput').value);
      const zeroAxisFilter = document.getElementById('zeroAxisFilterInput').checked;

      if (isNaN(macdFast) || macdFast < 2 || macdFast > 200) errors.push('DIF快线周期应在 2-200 之间');
      if (isNaN(macdSlow) || macdSlow < 2 || macdSlow > 500) errors.push('DIF慢线周期应在 2-500 之间');
      if (isNaN(macdSignal) || macdSignal < 2 || macdSignal > 100) errors.push('信号线周期应在 2-100 之间');
      if (macdFast >= macdSlow) errors.push('快线周期应小于慢线周期');

      if (errors.length > 0) { this.showToast(errors[0]); return; }

      this.settings = {
        ...this.settings,
        strategy: this.currentStrategy,
        macdFast, macdSlow, macdSignal, zeroAxisFilter,
      };
    } else if (this.currentStrategy === 'ma_cross') {
      const fastMA = parseInt(document.getElementById('maFastInput').value);
      const slowMA = parseInt(document.getElementById('maSlowInput').value);

      if (isNaN(fastMA) || fastMA < 2 || fastMA > 200) errors.push('快均线周期应在 2-200 之间');
      if (isNaN(slowMA) || slowMA < 5 || slowMA > 500) errors.push('慢均线周期应在 5-500 之间');
      if (fastMA >= slowMA) errors.push('快均线应小于慢均线');

      if (errors.length > 0) { this.showToast(errors[0]); return; }

      this.settings = {
        ...this.settings,
        strategy: this.currentStrategy,
        fastMA, slowMA,
      };
    } else {
      // composite
      const fastMA = parseInt(document.getElementById('fastMAInput').value);
      const slowMA = parseInt(document.getElementById('slowMAInput').value);
      const rsiLow = parseInt(document.getElementById('rsiLowInput').value);
      const rsiHigh = parseInt(document.getElementById('rsiHighInput').value);
      const entryConfirm = parseInt(document.getElementById('entryConfirmInput').value);
      const exitConfirm = parseInt(document.getElementById('exitConfirmInput').value);
      const volumeRatio = parseFloat(document.getElementById('volumeRatioInput').value);

      if (isNaN(fastMA) || fastMA < 2 || fastMA > 200) errors.push('快均线周期应在 2-200 之间');
      if (isNaN(slowMA) || slowMA < 5 || slowMA > 500) errors.push('慢均线周期应在 5-500 之间');
      if (fastMA >= slowMA) errors.push('快均线应小于慢均线');
      if (isNaN(rsiLow) || rsiLow < 1 || rsiLow > 99) errors.push('RSI下限应在 1-99 之间');
      if (isNaN(rsiHigh) || rsiHigh < 1 || rsiHigh > 99) errors.push('RSI上限应在 1-99 之间');
      if (rsiLow >= rsiHigh) errors.push('RSI下限应小于RSI上限');
      if (isNaN(entryConfirm) || entryConfirm < 1 || entryConfirm > 30) errors.push('入场确认天数应在 1-30 之间');
      if (isNaN(exitConfirm) || exitConfirm < 1 || exitConfirm > 30) errors.push('出场确认天数应在 1-30之间');
      if (document.getElementById('useVolumeInput').checked) {
        if (isNaN(volumeRatio) || volumeRatio <= 0 || volumeRatio > 10) errors.push('成交量放大倍数应在 0.1-10 之间');
      }

      if (errors.length > 0) { this.showToast(errors[0]); return; }

      this.settings = {
        strategy: this.currentStrategy,
        fastMA: fastMA,
        slowMA: slowMA,
        useMA60: document.getElementById('useMA60Input').checked,
        useVolume: document.getElementById('useVolumeInput').checked,
        volumeRatio: volumeRatio,
        useMACD: document.getElementById('useMACDInput').checked,
        useRSI: document.getElementById('useRSIInput').checked,
        rsiLow: rsiLow,
        rsiHigh: rsiHigh,
        entryConfirm: entryConfirm,
        exitConfirm: exitConfirm,
      };
    }

    DataManager.saveSettings(this.settings);
    this.showToast('设置已保存');

    // 重新计算信号
    this.computeAllSignals();
    this.renderHome();
  },

  /**
   * 恢复默认设置
   */
  restoreDefaultSettings() {
    if (!confirm('确定要恢复所有参数为默认值吗？')) return;

    this.settings = { ...StrategyEngine.defaultParams };
    DataManager.saveSettings(this.settings);
    this.renderSettings();
    this.showToast('已恢复默认设置');

    // 重新计算信号
    this.computeAllSignals();
    this.renderHome();
  },

  /**
   * 刷新所有数据
   */
  async refreshAll() {
    await this.loadAllData(true);
    this.showToast('数据已更新');
  },

  /**
   * 清除缓存
   */
  clearCache() {
    if (confirm('确定要清除所有缓存数据吗？')) {
      DataManager.clearCache();
      this.showToast('缓存已清除');
    }
  },

  /**
   * 切换策略
   */
  switchStrategy(strategyId) {
    if (!StrategyEngine.STRATEGIES[strategyId]) return;
    if (this.currentStrategy === strategyId) return;

    this.currentStrategy = strategyId;

    // 更新策略选择器UI
    document.querySelectorAll('.strategy-option').forEach(opt => {
      opt.classList.toggle('active', opt.dataset.strategy === strategyId);
    });

    // 显示/隐藏对应参数组
    document.querySelectorAll('.strategy-params').forEach(p => {
      p.classList.toggle('active', p.id === `params_${strategyId}`);
    });

    // 重新计算所有信号
    this.computeAllSignals();
    this.renderHome();
    this.showToast(`已切换到${StrategyEngine.STRATEGIES[strategyId].name}`);
  },

  /**
   * 渲染信号检查项（根据策略显示不同内容）
   */
  renderSignalChecks(signal) {
    const checks = signal.checks;
    const latest = signal.latest;

    if (this.currentStrategy === 'macd_cross') {
      return `
        <div class="check-item">
          <span class="check-label">DIF > DEA (${latest.dif?.toFixed(4) || '-'} vs ${latest.dea?.toFixed(4) || '-'})</span>
          <span class="check-value ${checks.difAboveDea ? 'pass' : 'fail'}">${checks.difAboveDea ? '✓ 满足' : '✗ 不满足'}</span>
        </div>
        <div class="check-item">
          <span class="check-label">DIF在零轴上方 (${latest.dif?.toFixed(4) || '-'})</span>
          <span class="check-value ${checks.aboveZero ? 'pass' : 'fail'}">${checks.aboveZero ? '✓ 满足' : '✗ 不满足'}</span>
        </div>
        <div class="check-item">
          <span class="check-label">MACD金叉状态</span>
          <span class="check-value ${checks.goldenCross ? 'pass' : ''}">${checks.goldenCross ? '✓ 金叉' : checks.deathCross ? '✗ 死叉' : '— 无交叉'}</span>
        </div>
        <div class="check-item highlight">
          <span class="check-label">MACD柱状图</span>
          <span class="check-value ${latest.macdHist > 0 ? 'pass' : 'fail'}">${latest.macdHist?.toFixed(4) || '-'}</span>
        </div>
      `;
    }

    if (this.currentStrategy === 'ma_cross') {
      return `
        <div class="check-item">
          <span class="check-label">MA${this.settings.fastMA} > MA${this.settings.slowMA} (${latest.maFast?.toFixed(2) || '-'} vs ${latest.maSlow?.toFixed(2) || '-'})</span>
          <span class="check-value ${checks.fastAboveSlow ? 'pass' : 'fail'}">${checks.fastAboveSlow ? '✓ 满足' : '✗ 不满足'}</span>
        </div>
        <div class="check-item">
          <span class="check-label">MA金叉状态</span>
          <span class="check-value ${checks.goldenCross ? 'pass' : ''}">${checks.goldenCross ? '✓ 金叉' : checks.deathCross ? '✗ 死叉' : '— 无交叉'}</span>
        </div>
        <div class="check-item highlight">
          <span class="check-label">当前价格</span>
          <span class="check-value">${latest.price?.toFixed(2) || '-'}</span>
        </div>
      `;
    }

    // composite（默认）
    return `
      <div class="check-item">
        <span class="check-label">价格 > MA${this.settings.fastMA} (${latest.maFast?.toFixed(2) || '-'})</span>
        <span class="check-value ${checks.aboveFast ? 'pass' : 'fail'}">${checks.aboveFast ? '✓ 满足' : '✗ 不满足'}</span>
      </div>
      <div class="check-item">
        <span class="check-label">价格 > MA${this.settings.slowMA} (${latest.maSlow?.toFixed(2) || '-'})</span>
        <span class="check-value ${checks.aboveSlow ? 'pass' : 'fail'}">${checks.aboveSlow ? '✓ 满足' : '✗ 不满足'}</span>
      </div>
      ${this.settings.useMA60 ? `
      <div class="check-item">
        <span class="check-label">价格 > MA60 (${latest.ma60?.toFixed(2) || '-'})</span>
        <span class="check-value ${checks.ma60Ok ? 'pass' : 'fail'}">${checks.ma60Ok ? '✓ 满足' : '✗ 不满足'}</span>
      </div>
      ` : ''}
      ${this.settings.useVolume ? `
      <div class="check-item">
        <span class="check-label">成交量 > 均量×${this.settings.volumeRatio} (${latest.volMA20?.toFixed(0) || '-'})</span>
        <span class="check-value ${checks.volOk ? 'pass' : 'fail'}">${checks.volOk ? '✓ 满足' : '✗ 不满足'}</span>
      </div>
      ` : ''}
      ${this.settings.useMACD ? `
      <div class="check-item">
        <span class="check-label">MACD柱 > 0 (${latest.macdHist?.toFixed(4) || '-'})</span>
        <span class="check-value ${checks.macdOk ? 'pass' : 'fail'}">${checks.macdOk ? '✓ 满足' : '✗ 不满足'}</span>
      </div>
      ` : ''}
      ${this.settings.useRSI ? `
      <div class="check-item">
        <span class="check-label">RSI在${this.settings.rsiLow}-${this.settings.rsiHigh} (${latest.rsi?.toFixed(1) || '-'})</span>
        <span class="check-value ${checks.rsiOk ? 'pass' : 'fail'}">${checks.rsiOk ? '✓ 满足' : '✗ 不满足'}</span>
      </div>
      ` : ''}
      <div class="check-item highlight">
        <span class="check-label">连续满足天数</span>
        <span class="check-value ${signal.confirmDays >= signal.requiredConfirm ? 'pass' : ''}">
          ${signal.confirmDays >= signal.requiredConfirm ? '✓' : '⏳'} ${signal.confirmDays} / ${signal.requiredConfirm} 天
        </span>
      </div>
    `;
  },

  /**
   * 显示Toast
   */
  showToast(message, duration = 2000) {
    let toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), duration);
  },
};

// 启动
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
