/**
 * 趋势策略引擎 - V2.4
 * 纯JavaScript实现，可在浏览器中运行
 * 策略：MA20/60双均线 + MACD + RSI + 入场/出场确认
 */

const StrategyEngine = {
  // 策略定义
  STRATEGIES: {
    'macd_cross': {
      name: 'MACD金叉死叉',
      desc: 'DIF上穿DEA买入，DIF下穿DEA卖出。胜率最高，回撤最小',
      defaultParams: {
        macdFast: 12,
        macdSlow: 26,
        macdSignal: 9,
        zeroAxisFilter: true,
      }
    },
    'ma_cross': {
      name: 'MA金叉死叉',
      desc: '快均线上穿慢均线买入，下穿卖出。交易最少，收益稳定',
      defaultParams: {
        fastMA: 20,
        slowMA: 60,
      }
    },
    'composite': {
      name: '复合趋势策略',
      desc: 'MA+MACD+RSI多条件过滤，确认机制减少假信号',
      defaultParams: {
        fastMA: 20, slowMA: 60,
        useMA60: false, useVolume: false, volumeRatio: 1.5,
        useMACD: true, useRSI: true, rsiLow: 40, rsiHigh: 70,
        entryConfirm: 2, exitConfirm: 2,
      }
    }
  },

  // 默认参数（MA20/60，市场主流共识参数）
  defaultParams: {
    fastMA: 20,
    slowMA: 60,
    useMA60: false,       // MA60长期趋势过滤
    useVolume: false,     // 成交量确认过滤
    volumeRatio: 1.5,     // 成交量放大倍数阈值
    useMACD: true,
    useRSI: true,
    rsiLow: 40,
    rsiHigh: 70,
    entryConfirm: 2,
    exitConfirm: 2,
  },

  /**
   * 校验并合并参数
   */
  validateParams(params) {
    const p = { ...this.defaultParams, ...params };
    
    // 范围校验
    if (!Number.isInteger(p.fastMA) || p.fastMA < 2 || p.fastMA > 200) {
      p.fastMA = this.defaultParams.fastMA;
    }
    if (!Number.isInteger(p.slowMA) || p.slowMA < 5 || p.slowMA > 500) {
      p.slowMA = this.defaultParams.slowMA;
    }
    if (p.fastMA >= p.slowMA) {
      p.fastMA = this.defaultParams.fastMA;
      p.slowMA = this.defaultParams.slowMA;
    }
    if (!Number.isInteger(p.rsiLow) || p.rsiLow < 1 || p.rsiLow > 99) {
      p.rsiLow = this.defaultParams.rsiLow;
    }
    if (!Number.isInteger(p.rsiHigh) || p.rsiHigh < 1 || p.rsiHigh > 99) {
      p.rsiHigh = this.defaultParams.rsiHigh;
    }
    if (p.rsiLow >= p.rsiHigh) {
      p.rsiLow = this.defaultParams.rsiLow;
      p.rsiHigh = this.defaultParams.rsiHigh;
    }
    if (!Number.isInteger(p.entryConfirm) || p.entryConfirm < 1 || p.entryConfirm > 30) {
      p.entryConfirm = this.defaultParams.entryConfirm;
    }
    if (!Number.isInteger(p.exitConfirm) || p.exitConfirm < 1 || p.exitConfirm > 30) {
      p.exitConfirm = this.defaultParams.exitConfirm;
    }
    if (typeof p.useMA60 !== 'boolean') p.useMA60 = this.defaultParams.useMA60;
    if (typeof p.useVolume !== 'boolean') p.useVolume = this.defaultParams.useVolume;
    if (typeof p.useMACD !== 'boolean') p.useMACD = this.defaultParams.useMACD;
    if (typeof p.useRSI !== 'boolean') p.useRSI = this.defaultParams.useRSI;
    if (typeof p.volumeRatio !== 'number' || p.volumeRatio <= 0 || p.volumeRatio > 10) {
      p.volumeRatio = this.defaultParams.volumeRatio;
    }
    
    return p;
  },

  /**
   * 计算技术指标
   * @param {Array} data - 数据数组 [{date, open, high, low, close, volume}]
   * @returns {Array} 带指标的数据
   */
  computeIndicators(data) {
    if (!data || !Array.isArray(data) || data.length === 0) {
      return [];
    }
    const result = data.map((d, i) => ({ ...d }));

    // 计算均线（滑动窗口法，O(n) 复杂度）
    for (let period of [5, 10, 15, 20, 30, 40, 50, 60]) {
      let sum = 0;
      for (let i = 0; i < result.length; i++) {
        sum += result[i].close;
        if (i >= period) sum -= result[i - period].close;
        result[i][`ma${period}`] = i >= period - 1 ? sum / period : null;
      }
    }

    // 成交量均线（MA20）
    const volPeriod = 20;
    for (let i = 0; i < result.length; i++) {
      if (i < volPeriod - 1) {
        result[i].volMA20 = null;
      } else {
        let sum = 0;
        for (let j = i - volPeriod + 1; j <= i; j++) {
          sum += result[j].volume || 0;
        }
        result[i].volMA20 = sum / volPeriod;
      }
    }

    // RSI (14)
    const rsiPeriod = 14;
    for (let i = 0; i < result.length; i++) {
      if (i < rsiPeriod) {
        result[i].rsi = null;
      } else if (i === rsiPeriod) {
        let gains = 0, losses = 0;
        for (let j = 1; j <= rsiPeriod; j++) {
          const change = result[j].close - result[j - 1].close;
          if (change > 0) gains += change;
          else losses -= change;
        }
        const avgGain = gains / rsiPeriod;
        const avgLoss = losses / rsiPeriod;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        result[i].rsi = 100 - 100 / (1 + rs);
        // 保存初始平均值，供后续递推使用
        result[i]._avgGain = avgGain;
        result[i]._avgLoss = avgLoss;
      } else {
        const change = result[i].close - result[i - 1].close;
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;
        const prevAvgGain = result[i - 1]._avgGain || 0;
        const prevAvgLoss = result[i - 1]._avgLoss || 0;
        const avgGain = (prevAvgGain * (rsiPeriod - 1) + gain) / rsiPeriod;
        const avgLoss = (prevAvgLoss * (rsiPeriod - 1) + loss) / rsiPeriod;
        result[i]._avgGain = avgGain;
        result[i]._avgLoss = avgLoss;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        result[i].rsi = 100 - 100 / (1 + rs);
      }
    }

    // MACD (12, 26, 9)
    const fastPeriod = 12, slowPeriod = 26, signalPeriod = 9;
    
    // EMA函数
    const computeEMA = (prices, period) => {
      const ema = [];
      const k = 2 / (period + 1);
      for (let i = 0; i < prices.length; i++) {
        if (i < period - 1) {
          ema.push(null);
        } else if (i === period - 1) {
          let sum = 0;
          for (let j = 0; j < period; j++) sum += prices[j];
          ema.push(sum / period);
        } else {
          ema.push(prices[i] * k + ema[i - 1] * (1 - k));
        }
      }
      return ema;
    };

    const closes = result.map(d => d.close);
    const fastEMA = computeEMA(closes, fastPeriod);
    const slowEMA = computeEMA(closes, slowPeriod);

    for (let i = 0; i < result.length; i++) {
      if (fastEMA[i] === null || slowEMA[i] === null) {
        result[i].macd = null;
        result[i].macdSignal = null;
        result[i].macdHist = null;
      } else {
        result[i].macd = fastEMA[i] - slowEMA[i];
      }
    }

    // MACD信号线
    const macdLine = result.map(d => d.macd);
    const signalLine = computeEMA(macdLine.filter(v => v !== null), signalPeriod);
    
    // 找到第一个有效macd的位置
    let firstValid = 0;
    for (let i = 0; i < result.length; i++) {
      if (result[i].macd !== null) { firstValid = i; break; }
    }
    
    for (let i = 0; i < result.length; i++) {
      if (i < firstValid + signalPeriod - 1) {
        result[i].macdSignal = null;
        result[i].macdHist = null;
      } else {
        const idx = i - firstValid;
        if (idx < signalLine.length && signalLine[idx] !== null) {
          result[i].macdSignal = signalLine[idx];
          result[i].macdHist = result[i].macd - signalLine[idx];
        } else {
          result[i].macdSignal = null;
          result[i].macdHist = null;
        }
      }
    }

    return result;
  },

  /**
   * 运行策略回测
   * @param {Array} data - 带指标的数据
   * @param {Object} params - 策略参数
   * @param {Number} initCapital - 初始资金
   * @returns {Object} 回测结果
   */
  runBacktest(data, params = {}, initCapital = 100000) {
    if (!data || !Array.isArray(data) || data.length < 60) {
      return {
        totalReturn: 0,
        annualReturn: 0,
        maxDrawdown: 0,
        winRate: 0,
        nTrades: 0,
        trades: [],
        equity: [],
        sharpe: 0,
        profitLossRatio: 0,
        calmar: 0,
        expectancy: 0,
        maxConsecLoss: 0,
        avgWin: 0,
        avgLoss: 0,
        finalValue: initCapital,
        error: '数据不足，无法回测',
      };
    }
    const p = this.validateParams(params);
    const fastKey = `ma${p.fastMA}`;
    const slowKey = `ma${p.slowMA}`;

    let capital = initCapital;
    let shares = 0;
    let inPosition = false;
    let entryPrice = 0;
    let highestPrice = 0;
    let holdDays = 0;
    let entryConfirm = 0;
    let exitConfirm = 0;

    const trades = [];
    const equity = [];
    let currentTrade = null;

    const commission = 0.0003;
    const stampDuty = 0.001;
    const slippage = 0.001;

    for (let i = 0; i < data.length; i++) {
      const d = data[i];
      const cp = d.close;
      const fma = d[fastKey];
      const sma = d[slowKey];

      if (fma === null || sma === null) {
        equity.push(capital + shares * cp);
        entryConfirm = 0;
        exitConfirm = 0;
        continue;
      }

      if (inPosition) {
        holdDays++;
        if (cp > highestPrice) highestPrice = cp;
      }

      const aboveFast = cp > fma;
      const aboveSlow = cp > sma;

      // 入场条件检查
      let baseEntry = aboveFast && aboveSlow;

      // MA60长期趋势过滤
      if (p.useMA60 && d.ma60 !== null) {
        baseEntry = baseEntry && cp > d.ma60;
      }

      // 成交量确认过滤
      if (p.useVolume && d.volMA20 !== null && d.volMA20 > 0) {
        baseEntry = baseEntry && d.volume > d.volMA20 * p.volumeRatio;
      }

      if (p.useMACD && d.macdHist !== null) {
        baseEntry = baseEntry && d.macdHist > 0;
      }

      if (p.useRSI && d.rsi !== null) {
        baseEntry = baseEntry && d.rsi >= p.rsiLow && d.rsi <= p.rsiHigh;
      }

      if (baseEntry) {
        entryConfirm++;
        exitConfirm = 0;
      } else {
        entryConfirm = 0;
      }

      const canEnter = entryConfirm >= p.entryConfirm;

      // 出场条件检查
      if (inPosition) {
        let shouldSell = false;
        let reason = '';

        if (!aboveFast) {
          exitConfirm++;
          if (exitConfirm >= p.exitConfirm) {
            shouldSell = true;
            reason = `连续${p.exitConfirm}天跌破MA${p.fastMA}`;
          }
        } else {
          exitConfirm = 0;
        }

        if (shouldSell) {
          const sellPrice = cp * (1 - slippage);
          const proceeds = shares * sellPrice * (1 - commission - stampDuty);
          capital += proceeds;
          const pnl = (sellPrice - entryPrice) / entryPrice;

          currentTrade.exitDate = d.date;
          currentTrade.exitPrice = sellPrice;
          currentTrade.pnl = pnl;
          currentTrade.holdDays = holdDays;
          currentTrade.reason = reason;
          currentTrade.maxProfit = (highestPrice - entryPrice) / entryPrice;
          trades.push(currentTrade);
          currentTrade = null;

          shares = 0;
          inPosition = false;
          exitConfirm = 0;
        }
      }

      // 入场
      if (!inPosition && canEnter) {
        const buyPrice = cp * (1 + slippage);
        const costPerShare = buyPrice * (1 + commission);
        const maxShares = Math.floor(capital / costPerShare / 100) * 100;

        if (maxShares > 0) {
          shares = maxShares;
          capital -= shares * buyPrice * (1 + commission);
          entryPrice = buyPrice;
          highestPrice = buyPrice;
          inPosition = true;
          holdDays = 0;
          entryConfirm = 0;
          exitConfirm = 0;

          currentTrade = {
            entryDate: d.date,
            entryPrice: buyPrice,
            shares: maxShares,
          };
        }
      }

      equity.push(capital + shares * cp);
    }

    // 强制平仓
    if (inPosition && currentTrade) {
      const lastPrice = data[data.length - 1].close;
      const sellPrice = lastPrice * (1 - slippage);
      const proceeds = shares * sellPrice * (1 - commission - stampDuty);
      capital += proceeds;
      const pnl = (sellPrice - entryPrice) / entryPrice;

      currentTrade.exitDate = data[data.length - 1].date;
      currentTrade.exitPrice = sellPrice;
      currentTrade.pnl = pnl;
      currentTrade.holdDays = holdDays;
      currentTrade.reason = '回测结束';
      currentTrade.maxProfit = (highestPrice - entryPrice) / entryPrice;
      trades.push(currentTrade);
    }

    // 计算统计指标
    const totalReturn = (capital - initCapital) / initCapital;
    const nTrades = trades.length;
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const winRate = nTrades > 0 ? wins.length / nTrades : 0;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
    const profitLossRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;
    const expectancy = winRate * avgWin + (1 - winRate) * avgLoss;

    // 最大回撤
    let maxDrawdown = 0;
    let peak = equity[0];
    for (let i = 1; i < equity.length; i++) {
      if (equity[i] > peak) peak = equity[i];
      const dd = (equity[i] - peak) / peak;
      if (dd < maxDrawdown) maxDrawdown = dd;
    }

    // 夏普比率
    const dailyReturns = [];
    for (let i = 1; i < equity.length; i++) {
      dailyReturns.push((equity[i] - equity[i - 1]) / equity[i - 1]);
    }
    const avgReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const stdReturn = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / dailyReturns.length);
    const sharpe = stdReturn > 0 ? Math.sqrt(252) * avgReturn / stdReturn : 0;

    // 最大连续亏损
    let maxConsecLoss = 0;
    let curLoss = 0;
    for (const t of trades) {
      if (t.pnl <= 0) {
        curLoss++;
        if (curLoss > maxConsecLoss) maxConsecLoss = curLoss;
      } else {
        curLoss = 0;
      }
    }

    // Calmar比率
    const years = data.length / 252;
    const annualReturn = years > 0 ? Math.pow(1 + totalReturn, 1 / years) - 1 : 0;
    const calmar = maxDrawdown !== 0 ? Math.abs(annualReturn / maxDrawdown) : 0;

    return {
      totalReturn,
      annualReturn,
      sharpe,
      maxDrawdown,
      calmar,
      nTrades,
      winRate,
      avgWin,
      avgLoss,
      profitLossRatio,
      expectancy,
      maxConsecLoss,
      trades,
      equity,
      finalValue: capital,
    };
  },

  /**
   * 获取当前信号
   * @param {Array} data - 带指标的数据（最后一天为最新）
   * @param {Object} params - 策略参数
   * @returns {Object} 当前信号状态
   */
  getCurrentSignal(data, params = {}) {
    if (!data || !Array.isArray(data) || data.length === 0) {
      return { error: '无数据' };
    }
    const p = this.validateParams(params);
    const fastKey = `ma${p.fastMA}`;
    const slowKey = `ma${p.slowMA}`;

    if (data.length < Math.max(p.fastMA, p.slowMA) + 30) {
      return { error: '数据不足' };
    }

    // 计算连续满足天数
    let confirmDays = 0;
    for (let i = data.length - 1; i >= 0; i--) {
      const d = data[i];
      if (d[fastKey] === null || d[slowKey] === null) break;

      let ok = d.close > d[fastKey] && d.close > d[slowKey];

      // MA60长期趋势过滤
      if (p.useMA60 && d.ma60 !== null) {
        ok = ok && d.close > d.ma60;
      }

      // 成交量确认过滤
      if (p.useVolume && d.volMA20 !== null && d.volMA20 > 0) {
        ok = ok && d.volume > d.volMA20 * p.volumeRatio;
      }

      if (p.useMACD && d.macdHist !== null) {
        ok = ok && d.macdHist > 0;
      }

      if (p.useRSI && d.rsi !== null) {
        ok = ok && d.rsi >= p.rsiLow && d.rsi <= p.rsiHigh;
      }

      if (ok) {
        confirmDays++;
      } else {
        break;
      }
    }

    const latest = data[data.length - 1];
    const aboveFast = latest.close > latest[fastKey];
    const aboveSlow = latest.close > latest[slowKey];
    const ma60Ok = !p.useMA60 || (latest.ma60 !== null && latest.close > latest.ma60);
    const volOk = !p.useVolume || (latest.volMA20 !== null && latest.volMA20 > 0 && latest.volume > latest.volMA20 * p.volumeRatio);
    const macdOk = latest.macdHist !== null && latest.macdHist > 0;
    const rsiOk = latest.rsi !== null && latest.rsi >= p.rsiLow && latest.rsi <= p.rsiHigh;

    const allOk = aboveFast && aboveSlow &&
      (!p.useMA60 || ma60Ok) &&
      (!p.useVolume || volOk) &&
      (!p.useMACD || macdOk) &&
      (!p.useRSI || rsiOk) &&
      confirmDays >= p.entryConfirm;

    let signal, signalType, action;
    if (allOk) {
      signal = '🟢 买入/持有';
      signalType = 'buy';
      action = '满足所有入场条件，可以建仓或继续持有';
    } else if (confirmDays > 0 && confirmDays < p.entryConfirm) {
      signal = '🟡 观察中';
      signalType = 'watch';
      action = `已连续满足${confirmDays}天，还需${p.entryConfirm - confirmDays}天确认`;
    } else {
      signal = '🔴 空仓/观望';
      signalType = 'sell';
      action = '不满足入场条件，建议空仓等待';
    }

    const missing = [];
    if (!aboveFast) missing.push(`价格低于MA${p.fastMA}`);
    if (!aboveSlow) missing.push(`价格低于MA${p.slowMA}`);
    if (p.useMA60 && !ma60Ok) missing.push('价格低于MA60');
    if (p.useVolume && !volOk) missing.push('成交量未放大');
    if (p.useMACD && !macdOk) missing.push('MACD柱≤0');
    if (p.useRSI && !rsiOk) missing.push(`RSI不在${p.rsiLow}-${p.rsiHigh}区间`);
    if (confirmDays < p.entryConfirm && aboveFast && aboveSlow &&
        (!p.useMA60 || ma60Ok) && (!p.useVolume || volOk) &&
        (!p.useMACD || macdOk) && (!p.useRSI || rsiOk)) {
      missing.push(`仅连续满足${confirmDays}天（需${p.entryConfirm}天）`);
    }

    return {
      signal,
      signalType,
      action,
      confirmDays,
      requiredConfirm: p.entryConfirm,
      checks: {
        aboveFast,
        aboveSlow,
        ma60Ok,
        volOk,
        macdOk,
        rsiOk,
      },
      latest: {
        price: latest.close,
        maFast: latest[fastKey],
        maSlow: latest[slowKey],
        ma60: latest.ma60,
        volMA20: latest.volMA20,
        volume: latest.volume,
        macdHist: latest.macdHist,
        rsi: latest.rsi,
        date: latest.date,
      },
      missing,
    };
  },

  /**
   * 运行策略回测（统一入口）
   * @param {Array} data - 带指标的数据
   * @param {String} strategyId - 策略ID
   * @param {Object} customParams - 自定义参数
   * @param {Number} initCapital - 初始资金
   * @returns {Object} 回测结果
   */
  runStrategyBacktest(data, strategyId, customParams = {}, initCapital = 100000) {
    const strategy = this.STRATEGIES[strategyId];
    if (!strategy) {
      return this.runBacktest(data, customParams, initCapital);
    }

    // 合并默认参数和自定义参数
    const params = { ...strategy.defaultParams, ...customParams };

    if (strategyId === 'composite') {
      return this.runBacktest(data, params, initCapital);
    }

    if (strategyId === 'macd_cross') {
      return this._runMACDCrossBacktest(data, params, initCapital);
    }

    if (strategyId === 'ma_cross') {
      return this._runMACrossBacktest(data, params, initCapital);
    }

    return this.runBacktest(data, customParams, initCapital);
  },

  /**
   * 获取策略信号（统一入口）
   * @param {Array} data - 带指标的数据
   * @param {String} strategyId - 策略ID
   * @param {Object} customParams - 自定义参数
   * @returns {Object} 当前信号状态
   */
  getStrategySignal(data, strategyId, customParams = {}) {
    const strategy = this.STRATEGIES[strategyId];
    if (!strategy) {
      return this.getCurrentSignal(data, customParams);
    }

    const params = { ...strategy.defaultParams, ...customParams };

    if (strategyId === 'composite') {
      return this.getCurrentSignal(data, params);
    }

    if (strategyId === 'macd_cross') {
      return this._getMACDCrossSignal(data, params);
    }

    if (strategyId === 'ma_cross') {
      return this._getMACrossSignal(data, params);
    }

    return this.getCurrentSignal(data, customParams);
  },

  /**
   * 运行回测（主入口，兼容旧调用）
   */
  runBacktest(data, params = {}, initCapital = 100000) {
    return this._runCompositeBacktest(data, params, initCapital);
  },

  /**
   * 复合策略回测（原runBacktest逻辑）
   */
  _runCompositeBacktest(data, params, initCapital) {
    if (!data || !Array.isArray(data) || data.length < 60) {
      return {
        totalReturn: 0, annualReturn: 0, maxDrawdown: 0, winRate: 0,
        nTrades: 0, trades: [], equity: [], sharpe: 0, profitLossRatio: 0,
        calmar: 0, expectancy: 0, maxConsecLoss: 0, avgWin: 0, avgLoss: 0,
        finalValue: initCapital, error: '数据不足，无法回测',
      };
    }
    const p = this.validateParams(params);
    const fastKey = `ma${p.fastMA}`;
    const slowKey = `ma${p.slowMA}`;

    let capital = initCapital;
    let shares = 0;
    let inPosition = false;
    let entryPrice = 0;
    let highestPrice = 0;
    let holdDays = 0;
    let entryConfirm = 0;
    let exitConfirm = 0;

    const trades = [];
    const equity = [];
    let currentTrade = null;

    const commission = 0.0003;
    const stampDuty = 0.001;
    const slippage = 0.001;

    for (let i = 0; i < data.length; i++) {
      const d = data[i];
      const cp = d.close;
      const fma = d[fastKey];
      const sma = d[slowKey];

      if (fma === null || sma === null) {
        equity.push(capital + shares * cp);
        entryConfirm = 0;
        exitConfirm = 0;
        continue;
      }

      if (inPosition) {
        holdDays++;
        if (cp > highestPrice) highestPrice = cp;
      }

      const aboveFast = cp > fma;
      const aboveSlow = cp > sma;

      // 入场条件检查
      let baseEntry = aboveFast && aboveSlow;

      // MA60长期趋势过滤
      if (p.useMA60 && d.ma60 !== null) {
        baseEntry = baseEntry && cp > d.ma60;
      }

      // 成交量确认过滤
      if (p.useVolume && d.volMA20 !== null && d.volMA20 > 0) {
        baseEntry = baseEntry && d.volume > d.volMA20 * p.volumeRatio;
      }

      if (p.useMACD && d.macdHist !== null) {
        baseEntry = baseEntry && d.macdHist > 0;
      }

      if (p.useRSI && d.rsi !== null) {
        baseEntry = baseEntry && d.rsi >= p.rsiLow && d.rsi <= p.rsiHigh;
      }

      if (baseEntry) {
        entryConfirm++;
        exitConfirm = 0;
      } else {
        entryConfirm = 0;
      }

      const canEnter = entryConfirm >= p.entryConfirm;

      // 出场条件检查
      if (inPosition) {
        let shouldSell = false;
        let reason = '';

        if (!aboveFast) {
          exitConfirm++;
          if (exitConfirm >= p.exitConfirm) {
            shouldSell = true;
            reason = `连续${p.exitConfirm}天跌破MA${p.fastMA}`;
          }
        } else {
          exitConfirm = 0;
        }

        if (shouldSell) {
          const sellPrice = cp * (1 - slippage);
          const proceeds = shares * sellPrice * (1 - commission - stampDuty);
          capital += proceeds;
          const pnl = (sellPrice - entryPrice) / entryPrice;

          currentTrade.exitDate = d.date;
          currentTrade.exitPrice = sellPrice;
          currentTrade.pnl = pnl;
          currentTrade.holdDays = holdDays;
          currentTrade.reason = reason;
          currentTrade.maxProfit = (highestPrice - entryPrice) / entryPrice;
          trades.push(currentTrade);
          currentTrade = null;

          shares = 0;
          inPosition = false;
          exitConfirm = 0;
        }
      }

      // 入场
      if (!inPosition && canEnter) {
        const buyPrice = cp * (1 + slippage);
        const costPerShare = buyPrice * (1 + commission);
        const maxShares = Math.floor(capital / costPerShare / 100) * 100;

        if (maxShares > 0) {
          shares = maxShares;
          capital -= shares * buyPrice * (1 + commission);
          entryPrice = buyPrice;
          highestPrice = buyPrice;
          inPosition = true;
          holdDays = 0;
          entryConfirm = 0;
          exitConfirm = 0;

          currentTrade = {
            entryDate: d.date,
            entryPrice: buyPrice,
            shares: maxShares,
          };
        }
      }

      equity.push(capital + shares * cp);
    }

    // 强制平仓
    if (inPosition && currentTrade) {
      const lastPrice = data[data.length - 1].close;
      const sellPrice = lastPrice * (1 - slippage);
      const proceeds = shares * sellPrice * (1 - commission - stampDuty);
      capital += proceeds;
      const pnl = (sellPrice - entryPrice) / entryPrice;

      currentTrade.exitDate = data[data.length - 1].date;
      currentTrade.exitPrice = sellPrice;
      currentTrade.pnl = pnl;
      currentTrade.holdDays = holdDays;
      currentTrade.reason = '回测结束';
      currentTrade.maxProfit = (highestPrice - entryPrice) / entryPrice;
      trades.push(currentTrade);
    }

    // 计算统计指标
    const totalReturn = (capital - initCapital) / initCapital;
    const nTrades = trades.length;
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const winRate = nTrades > 0 ? wins.length / nTrades : 0;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
    const profitLossRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;
    const expectancy = winRate * avgWin + (1 - winRate) * avgLoss;

    // 最大回撤
    let maxDrawdown = 0;
    let peak = equity[0];
    for (let i = 1; i < equity.length; i++) {
      if (equity[i] > peak) peak = equity[i];
      const dd = (equity[i] - peak) / peak;
      if (dd < maxDrawdown) maxDrawdown = dd;
    }

    // 夏普比率
    const dailyReturns = [];
    for (let i = 1; i < equity.length; i++) {
      dailyReturns.push((equity[i] - equity[i - 1]) / equity[i - 1]);
    }
    const avgReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const stdReturn = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / dailyReturns.length);
    const sharpe = stdReturn > 0 ? Math.sqrt(252) * avgReturn / stdReturn : 0;

    // 最大连续亏损
    let maxConsecLoss = 0;
    let curLoss = 0;
    for (const t of trades) {
      if (t.pnl <= 0) {
        curLoss++;
        if (curLoss > maxConsecLoss) maxConsecLoss = curLoss;
      } else {
        curLoss = 0;
      }
    }

    // Calmar比率
    const years = data.length / 252;
    const annualReturn = years > 0 ? Math.pow(1 + totalReturn, 1 / years) - 1 : 0;
    const calmar = maxDrawdown !== 0 ? Math.abs(annualReturn / maxDrawdown) : 0;

    return {
      totalReturn,
      annualReturn,
      sharpe,
      maxDrawdown,
      calmar,
      nTrades,
      winRate,
      avgWin,
      avgLoss,
      profitLossRatio,
      expectancy,
      maxConsecLoss,
      trades,
      equity,
      finalValue: capital,
    };
  },

  /**
   * MACD金叉死叉回测
   */
  _runMACDCrossBacktest(data, params, initCapital) {
    if (!data || !Array.isArray(data) || data.length < 40) {
      return {
        totalReturn: 0, annualReturn: 0, maxDrawdown: 0, winRate: 0,
        nTrades: 0, trades: [], equity: [], sharpe: 0, profitLossRatio: 0,
        calmar: 0, expectancy: 0, maxConsecLoss: 0, avgWin: 0, avgLoss: 0,
        finalValue: initCapital, error: '数据不足，无法回测',
      };
    }

    let capital = initCapital;
    let shares = 0;
    let inPosition = false;
    let entryPrice = 0;
    let highestPrice = 0;
    let holdDays = 0;

    const trades = [];
    const equity = [];
    let currentTrade = null;

    const commission = 0.0003;
    const stampDuty = 0.001;
    const slippage = 0.001;

    for (let i = 1; i < data.length; i++) {
      const d = data[i];
      const prev = data[i - 1];
      const cp = d.close;

      // 需要MACD和信号线有效
      if (d.macd === null || d.macdSignal === null || prev.macd === null || prev.macdSignal === null) {
        equity.push(capital + shares * cp);
        continue;
      }

      if (inPosition) {
        holdDays++;
        if (cp > highestPrice) highestPrice = cp;
      }

      // 金叉：前一日 DIF <= DEA，当日 DIF > DEA
      const goldenCross = prev.macd <= prev.macdSignal && d.macd > d.macdSignal;
      // 死叉：前一日 DIF >= DEA，当日 DIF < DEA
      const deathCross = prev.macd >= prev.macdSignal && d.macd < d.macdSignal;

      // 卖出（死叉）
      if (inPosition && deathCross) {
        const sellPrice = cp * (1 - slippage);
        const proceeds = shares * sellPrice * (1 - commission - stampDuty);
        capital += proceeds;
        const pnl = (sellPrice - entryPrice) / entryPrice;

        currentTrade.exitDate = d.date;
        currentTrade.exitPrice = sellPrice;
        currentTrade.pnl = pnl;
        currentTrade.holdDays = holdDays;
        currentTrade.reason = 'MACD死叉卖出';
        currentTrade.maxProfit = (highestPrice - entryPrice) / entryPrice;
        trades.push(currentTrade);
        currentTrade = null;

        shares = 0;
        inPosition = false;
      }

      // 买入（金叉）
      if (!inPosition && goldenCross) {
        // 零轴过滤
        if (params.zeroAxisFilter && d.macd <= 0) {
          equity.push(capital + shares * cp);
          continue;
        }

        const buyPrice = cp * (1 + slippage);
        const costPerShare = buyPrice * (1 + commission);
        const maxShares = Math.floor(capital / costPerShare / 100) * 100;

        if (maxShares > 0) {
          shares = maxShares;
          capital -= shares * buyPrice * (1 + commission);
          entryPrice = buyPrice;
          highestPrice = buyPrice;
          inPosition = true;
          holdDays = 0;

          currentTrade = {
            entryDate: d.date,
            entryPrice: buyPrice,
            shares: maxShares,
          };
        }
      }

      equity.push(capital + shares * cp);
    }

    // 强制平仓
    if (inPosition && currentTrade) {
      const lastPrice = data[data.length - 1].close;
      const sellPrice = lastPrice * (1 - slippage);
      const proceeds = shares * sellPrice * (1 - commission - stampDuty);
      capital += proceeds;
      const pnl = (sellPrice - entryPrice) / entryPrice;

      currentTrade.exitDate = data[data.length - 1].date;
      currentTrade.exitPrice = sellPrice;
      currentTrade.pnl = pnl;
      currentTrade.holdDays = holdDays;
      currentTrade.reason = '回测结束';
      currentTrade.maxProfit = (highestPrice - entryPrice) / entryPrice;
      trades.push(currentTrade);
    }

    return this._computeBacktestStats(trades, equity, capital, initCapital, data.length);
  },

  /**
   * MA金叉死叉回测
   */
  _runMACrossBacktest(data, params, initCapital) {
    if (!data || !Array.isArray(data) || data.length < 60) {
      return {
        totalReturn: 0, annualReturn: 0, maxDrawdown: 0, winRate: 0,
        nTrades: 0, trades: [], equity: [], sharpe: 0, profitLossRatio: 0,
        calmar: 0, expectancy: 0, maxConsecLoss: 0, avgWin: 0, avgLoss: 0,
        finalValue: initCapital, error: '数据不足，无法回测',
      };
    }

    const fastKey = `ma${params.fastMA}`;
    const slowKey = `ma${params.slowMA}`;

    let capital = initCapital;
    let shares = 0;
    let inPosition = false;
    let entryPrice = 0;
    let highestPrice = 0;
    let holdDays = 0;

    const trades = [];
    const equity = [];
    let currentTrade = null;

    const commission = 0.0003;
    const stampDuty = 0.001;
    const slippage = 0.001;

    for (let i = 1; i < data.length; i++) {
      const d = data[i];
      const prev = data[i - 1];
      const cp = d.close;

      if (d[fastKey] === null || d[slowKey] === null || prev[fastKey] === null || prev[slowKey] === null) {
        equity.push(capital + shares * cp);
        continue;
      }

      if (inPosition) {
        holdDays++;
        if (cp > highestPrice) highestPrice = cp;
      }

      // 金叉：前一日 fastMA <= slowMA，当日 fastMA > slowMA
      const goldenCross = prev[fastKey] <= prev[slowKey] && d[fastKey] > d[slowKey];
      // 死叉：前一日 fastMA >= slowMA，当日 fastMA < slowMA
      const deathCross = prev[fastKey] >= prev[slowKey] && d[fastKey] < d[slowKey];

      // 卖出（死叉）
      if (inPosition && deathCross) {
        const sellPrice = cp * (1 - slippage);
        const proceeds = shares * sellPrice * (1 - commission - stampDuty);
        capital += proceeds;
        const pnl = (sellPrice - entryPrice) / entryPrice;

        currentTrade.exitDate = d.date;
        currentTrade.exitPrice = sellPrice;
        currentTrade.pnl = pnl;
        currentTrade.holdDays = holdDays;
        currentTrade.reason = `MA${params.fastMA}/${params.slowMA}死叉卖出`;
        currentTrade.maxProfit = (highestPrice - entryPrice) / entryPrice;
        trades.push(currentTrade);
        currentTrade = null;

        shares = 0;
        inPosition = false;
      }

      // 买入（金叉）
      if (!inPosition && goldenCross) {
        const buyPrice = cp * (1 + slippage);
        const costPerShare = buyPrice * (1 + commission);
        const maxShares = Math.floor(capital / costPerShare / 100) * 100;

        if (maxShares > 0) {
          shares = maxShares;
          capital -= shares * buyPrice * (1 + commission);
          entryPrice = buyPrice;
          highestPrice = buyPrice;
          inPosition = true;
          holdDays = 0;

          currentTrade = {
            entryDate: d.date,
            entryPrice: buyPrice,
            shares: maxShares,
          };
        }
      }

      equity.push(capital + shares * cp);
    }

    // 强制平仓
    if (inPosition && currentTrade) {
      const lastPrice = data[data.length - 1].close;
      const sellPrice = lastPrice * (1 - slippage);
      const proceeds = shares * sellPrice * (1 - commission - stampDuty);
      capital += proceeds;
      const pnl = (sellPrice - entryPrice) / entryPrice;

      currentTrade.exitDate = data[data.length - 1].date;
      currentTrade.exitPrice = sellPrice;
      currentTrade.pnl = pnl;
      currentTrade.holdDays = holdDays;
      currentTrade.reason = '回测结束';
      currentTrade.maxProfit = (highestPrice - entryPrice) / entryPrice;
      trades.push(currentTrade);
    }

    return this._computeBacktestStats(trades, equity, capital, initCapital, data.length);
  },

  /**
   * 计算回测统计指标（通用）
   */
  _computeBacktestStats(trades, equity, capital, initCapital, dataLength) {
    const totalReturn = (capital - initCapital) / initCapital;
    const nTrades = trades.length;
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const winRate = nTrades > 0 ? wins.length / nTrades : 0;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
    const profitLossRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;
    const expectancy = winRate * avgWin + (1 - winRate) * avgLoss;

    let maxDrawdown = 0;
    let peak = equity[0];
    for (let i = 1; i < equity.length; i++) {
      if (equity[i] > peak) peak = equity[i];
      const dd = (equity[i] - peak) / peak;
      if (dd < maxDrawdown) maxDrawdown = dd;
    }

    const dailyReturns = [];
    for (let i = 1; i < equity.length; i++) {
      dailyReturns.push((equity[i] - equity[i - 1]) / equity[i - 1]);
    }
    const avgReturn = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
    const stdReturn = dailyReturns.length > 0 ? Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / dailyReturns.length) : 0;
    const sharpe = stdReturn > 0 ? Math.sqrt(252) * avgReturn / stdReturn : 0;

    let maxConsecLoss = 0;
    let curLoss = 0;
    for (const t of trades) {
      if (t.pnl <= 0) {
        curLoss++;
        if (curLoss > maxConsecLoss) maxConsecLoss = curLoss;
      } else {
        curLoss = 0;
      }
    }

    const years = dataLength / 252;
    const annualReturn = years > 0 ? Math.pow(1 + totalReturn, 1 / years) - 1 : 0;
    const calmar = maxDrawdown !== 0 ? Math.abs(annualReturn / maxDrawdown) : 0;

    return {
      totalReturn, annualReturn, sharpe, maxDrawdown, calmar,
      nTrades, winRate, avgWin, avgLoss, profitLossRatio, expectancy,
      maxConsecLoss, trades, equity, finalValue: capital,
    };
  },

  /**
   * MACD金叉死叉当前信号
   */
  _getMACDCrossSignal(data, params) {
    if (!data || !Array.isArray(data) || data.length < 40) {
      return { error: '无数据' };
    }

    const latest = data[data.length - 1];
    const prev = data[data.length - 2];

    if (!latest || !prev || latest.macd === null || latest.macdSignal === null ||
        prev.macd === null || prev.macdSignal === null) {
      return { error: '数据不足' };
    }

    const dif = latest.macd;
    const dea = latest.macdSignal;
    const prevDif = prev.macd;
    const prevDea = prev.macdSignal;

    const goldenCross = prevDif <= prevDea && dif > dea;
    const deathCross = prevDif >= prevDea && dif < dea;
    const aboveZero = dif > 0;
    const difAboveDea = dif > dea;

    let signal, signalType, action;
    if (goldenCross && (!params.zeroAxisFilter || aboveZero)) {
      signal = '🟢 买入/持有';
      signalType = 'buy';
      action = 'MACD金叉出现，DIF上穿DEA，建议买入';
    } else if (difAboveDea && !goldenCross) {
      signal = '🟢 持有';
      signalType = 'buy';
      action = 'DIF在DEA上方运行，继续持有';
    } else if (deathCross) {
      signal = '🔴 空仓/观望';
      signalType = 'sell';
      action = 'MACD死叉出现，DIF下穿DEA，建议卖出';
    } else {
      signal = '🔴 空仓/观望';
      signalType = 'sell';
      action = 'DIF在DEA下方运行，等待金叉信号';
    }

    const missing = [];
    if (!difAboveDea) missing.push('DIF低于DEA');
    if (params.zeroAxisFilter && !aboveZero) missing.push('DIF在零轴下方');
    if (difAboveDea && !goldenCross) missing.push('等待金叉确认');

    return {
      signal, signalType, action,
      confirmDays: difAboveDea ? 1 : 0,
      requiredConfirm: 1,
      checks: {
        difAboveDea,
        aboveZero,
        goldenCross,
        deathCross,
      },
      latest: {
        price: latest.close,
        dif: latest.macd,
        dea: latest.macdSignal,
        macdHist: latest.macdHist,
        date: latest.date,
      },
      missing,
    };
  },

  /**
   * MA金叉死叉当前信号
   */
  _getMACrossSignal(data, params) {
    if (!data || !Array.isArray(data) || data.length < 60) {
      return { error: '无数据' };
    }

    const fastKey = `ma${params.fastMA}`;
    const slowKey = `ma${params.slowMA}`;

    const latest = data[data.length - 1];
    const prev = data[data.length - 2];

    if (!latest || !prev || latest[fastKey] === null || latest[slowKey] === null ||
        prev[fastKey] === null || prev[slowKey] === null) {
      return { error: '数据不足' };
    }

    const fastMA = latest[fastKey];
    const slowMA = latest[slowKey];
    const prevFastMA = prev[fastKey];
    const prevSlowMA = prev[slowKey];

    const goldenCross = prevFastMA <= prevSlowMA && fastMA > slowMA;
    const deathCross = prevFastMA >= prevSlowMA && fastMA < slowMA;
    const fastAboveSlow = fastMA > slowMA;

    let signal, signalType, action;
    if (goldenCross) {
      signal = '🟢 买入/持有';
      signalType = 'buy';
      action = `MA${params.fastMA}上穿MA${params.slowMA}，金叉买入信号`;
    } else if (fastAboveSlow && !goldenCross) {
      signal = '🟢 持有';
      signalType = 'buy';
      action = `MA${params.fastMA}在MA${params.slowMA}上方运行，继续持有`;
    } else if (deathCross) {
      signal = '🔴 空仓/观望';
      signalType = 'sell';
      action = `MA${params.fastMA}下穿MA${params.slowMA}，死叉卖出信号`;
    } else {
      signal = '🔴 空仓/观望';
      signalType = 'sell';
      action = `MA${params.fastMA}在MA${params.slowMA}下方运行，等待金叉信号`;
    }

    const missing = [];
    if (!fastAboveSlow) missing.push(`MA${params.fastMA}低于MA${params.slowMA}`);
    if (fastAboveSlow && !goldenCross) missing.push('等待金叉确认');

    return {
      signal, signalType, action,
      confirmDays: fastAboveSlow ? 1 : 0,
      requiredConfirm: 1,
      checks: {
        fastAboveSlow,
        goldenCross,
        deathCross,
      },
      latest: {
        price: latest.close,
        maFast: fastMA,
        maSlow: slowMA,
        date: latest.date,
      },
      missing,
    };
  },
};

// 导出（兼容Node.js和浏览器）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StrategyEngine;
}
