#!/usr/bin/env bash
# ============================================================
#  自解压包：宽度 MA20/MA30 斜率验证（代码 + 文档，共 6 个文件）
#  用法：bash breadth_slope_bundle.sh
#  生成：/workspace/jayce-workflow/backtest-v15/ 下的 5 个 .py + deep_audit/HANDOFF_25.md
#  另需手动放置 4 个数据 JSON（本包不含，避免手抄大文件出错）：
#    backtest-v15/market_breadth.json                        1,379 KB
#    backtest-v15/regime_breadth.json                        7 KB
#    backtest-v15/deep_audit/out/trade_calendar.json         120 KB
#    backtest-v15/deep_audit/out/candidates_hfq_wide.json    最大件
# ============================================================
set -e
ROOT=/workspace/jayce-workflow/backtest-v15
mkdir -p "$ROOT/deep_audit/out"

cat > "$ROOT/engine_v2.py" <<'__PY_ENGINE_V2__'
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""engine_v2: 统一回测引擎 (成本模型固化 + 可插拔退出规则)
用法: from engine_v2 import Engine
退出规则: {'exit':'close'} | {'exit':'sl_tp','sl':0.03,'tp':0.08,'paths':{code:{date:[o,c,h,l]}}}
"""
import json, math, statistics as st
from collections import defaultdict

BASE = '/workspace/jayce-workflow/backtest-v15/'

# ============================================================
#  用户真实费率（2026-09-27 定档，勿再询问 / 勿再改动）
#   券商佣金  0.8725‱ = 0.00008725 / 单边，买卖双边各收一次
#   印花税    0.5‰   = 0.0005     / 仅卖出单边（2023-08-28 起现行税率）
#   现行往返成本 = 2×0.00008725 + 0.0005 = 0.0006745 ≈ 0.06745%
#  历史回测段印花税按 stamp_rates() 的当时实际税率计（方法论正确），
#  现行段即为用户真实费率。
# ============================================================
COMM = 0.00008725  # 佣金 0.8725‱ 单边 (用户真实费率, 已定档)
STAMP_NOW = 0.0005  # 印花税 0.5‰ 卖出单边 (现行, 与用户一致)

def stamp_rates(dt):
    if dt < '2001-11-16': return (0.003, 0.003)
    if dt < '2005-01-24': return (0.002, 0.002)
    if dt < '2007-05-30': return (0.001, 0.001)
    if dt < '2008-04-24': return (0.003, 0.003)
    if dt < '2008-09-19': return (0.001, 0.001)
    if dt < '2023-08-28': return (0.0, 0.001)
    return (0.0, 0.0005)

def round_trip_cost(dt):
    """往返成本率(小数): 佣金双边 + 印花税(买卖各按规则)"""
    bs, ss = stamp_rates(dt)
    return 2 * COMM + bs + ss

# ============================================================
#  【永久口径·2026-10-23】可交易板块排除 (勿再违反)
#   排除 ①科创板 688/689  ②北交所 bj*(含920)
#   保留 沪主板 600/601/603/605 + 深主板 000/001/002/003 + 创业板 300/301/302
#
#   ST 不再按名称剔除：stock_adj 只有【当前】名称，用"今天的ST名单"去剔整段历史
#   是前视偏差（实测：6324 条 ST 候选中 96.1% 可用 20 日内 >5.35% 的涨跌幅证明"当时不是ST"）。
#   代价已量化：2014+ 基准 剔ST 605.8% → 不剔ST 536.3%，那 69.5 个百分点是前视收益。
#   ST 本身可交易（券商签风险揭示书即可），故默认放行；若要剔，必须接历史ST名单，不能靠名称。
# ============================================================
def board_ok(code):
    """True=可交易(保留); 排除 北交所 bj* / 科创板 688|689"""
    if code.startswith('bj'):
        return False
    body = code[2:] if code[:2] in ('sh', 'sz', 'bj') else code
    if body.startswith('688') or body.startswith('689'):
        return False
    if body.startswith('8') or body.startswith('4') or body.startswith('920'):
        return False
    return True

def is_tradable(c):
    """候选是否可交易: 非科创/非北交 + T0未跌停(v41, 2026-10-09)"""
    if not board_ok(c['code']):
        return False
    # 【永久口径·2026-10-09】T0 跌停/近跌停剔除:
    #   封死跌停 → 量比失真(近5年 123/123 笔全部通过『量比≤0.8』) + 收/MA10 被砸进 S1 最高分桶;
    #   近5年 123 笔 D1 -2.98% / 胜率 30.1%; 相邻桶 (-9.5,-8] 反而 +0.97% → 边界取 -9.5
    #   主板(±10%) chg<=-9.5 ; 创业板(±20%) chg<=-19.5; 仅按收盘, 盘中触及不剔
    body = c['code'][2:] if c['code'][:2] in ('sh', 'sz', 'bj') else c['code']
    lim = -19.5 if body.startswith(('300', '301', '302')) else -9.5
    chg = c.get('chg')
    return not (chg is not None and chg <= lim)

def filter_tradable(cands):
    """回测/选股统一入口: 剔除 科创/北交/ST 后的候选池"""
    return [c for c in cands if is_tradable(c)]

class Engine:
    def __init__(self, cands, thr=70, topn=8, cap=0.20, scorer='v28'):
        if callable(scorer):
            sc = scorer
        elif scorer == 'v28':
            from strategy_v28 import score_v28 as sc
        else:
            from strategy_final import score_final as sc
        self.by_day = defaultdict(list)
        for c in cands:
            c['score'] = sc(c)
            self.by_day[c['date']].append(c)
        self.dates = sorted(self.by_day)
        self.thr, self.topn, self.cap = thr, topn, cap

    def picks_on(self, dt):
        pool = [c for c in self.by_day.get(dt, []) if c['score'] >= self.thr]
        if not pool: return None
        pool.sort(key=lambda c: c['score'], reverse=True)
        return pool[:self.topn]

    def run(self, exit_rule=None, cost=True, seg=None, brakes=None):
        """exit_rule: None(收盘) | dict(sl_tp+paths); brakes: dict(lose_n=3) 连亏N日次日空仓"""
        eq = 1.0; peak = 1.0; mx = 0.0
        daily = []; di = []; trig = 0; lose_run = 0
        for dt in self.dates:
            if seg and (dt < seg[0] or dt > seg[1]): continue
            if brakes and brakes.get('lose_n') and lose_run >= brakes['lose_n']:
                daily.append(0.0); di.append(dt); lose_run = 0; continue
            pw = self.picks_on(dt)
            r = 0.0
            if pw:
                w = min(self.cap, 1.0 / len(pw))
                for c in pw:
                    ri = c['next_ret']
                    if exit_rule and exit_rule.get('paths'):
                        rp = self._exit_ret(c, exit_rule)
                        if rp is not None:
                            ri = rp
                            if exit_rule.get('sl') and rp <= -exit_rule['sl'] * 100:
                                trig += 1
                    r += ri * w
                if cost:
                    r -= len(pw) * w * round_trip_cost(dt) * 100
            if r < 0: lose_run += 1
            else: lose_run = 0
            eq *= (1 + r / 100.0)
            daily.append(r); di.append(dt)
            peak = max(peak, eq); mx = max(mx, (peak - eq) / peak * 100)
        n = len(daily); mean = st.mean(daily); sd = st.pstdev(daily)
        return dict(n=n, cum=(eq - 1) * 100, ann=((eq ** (252.0 / n)) - 1) * 100, maxdd=mx,
                    sharpe=mean / sd * math.sqrt(252) if sd > 0 else 0,
                    day_win=sum(1 for x in daily if x > 0) / n * 100, trig=trig,
                    daily=daily, di=di)

    @staticmethod
    def _exit_ret(c, rule):
        """真实路径退出: 低开穿损卖开盘 / 盘中触sl卖sl / 触tp卖tp / 否则收盘"""
        ph = rule['paths'].get(c['code'])
        if not ph: return None
        nxt = ph.get(c['date'])
        if not nxt: return None
        o, cl, h, l = nxt
        buy = rule.get('buy_px')
        if buy is None: return None  # 需外部提供买入价
        sl_p = buy * (1 - rule.get('sl', 0)); tp_p = buy * (1 + rule.get('tp', 99))
        if rule.get('sl') and o <= sl_p: return (o / buy - 1) * 100
        if rule.get('tp') and h >= tp_p: return (tp_p / buy - 1) * 100
        if rule.get('sl') and l <= sl_p: return (sl_p / buy - 1) * 100
        return (cl / buy - 1) * 100
__PY_ENGINE_V2__

cat > "$ROOT/r9_strategy.py" <<'__PY_R9_STRATEGY__'
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""R9 策略模块（历史基线实现；现行生产评分见 strategy_final.py / strategy_v28.py）

⚠️ 本模块的 R9_H=3.0 / R9_PENALTY=-10 是 2026-09-30 之前的旧档，仅用于历史复现。
   现行 V28 用 strategy_final.r9_hit_final（h=5.0）与 R9_PENALTY=-5。

================================================================
R9 规则（2026-09-13 大样本验证成立 · 2026-09-14 旧档 -10 分）
================================================================
最近涨停日的次日, 同时满足三条 → R9 违规（涨停次日放量滞涨 = 出货特征）:
  a) 收阴线            (r9_yin=True)
  b) 次日量/涨停日量 >= 1.0   (R9_K, 放量)
  c) 次日最高较涨停收盘冲高 >= 3%  (R9_H, 冲高回落滞涨)

大样本证据 (candidates_r9.json, n=211,040, 2000-2026):
  全样本:     有R9 n=21,803 D1+0.014%/49.6% vs 无R9 n=189,237 D1+0.046%/49.3%
  宏盛画像内(pd=3 & 20日2板, n=7,714):
              有R9 n=722 D1+0.016%/51.4% vs 无R9 n=6,992 D1+0.599%/57.6%
              → ΔD1 = -0.583%: R9 把强势画像的期望几乎清零
  组合层(V6≥70): 原版 +0.366%/54.0% → 扣10 +0.371%/54.2% (三档10/15/20几乎无差, 取最小有效档)
  宏盛 9/8: 79.9 分复现一致, 扣10后 69.9<70 被拦下, 躲过 -20.58%

评分口径（历史档）: V6.0 六因子桶分 × (W6/W15) 加权 + S9(候选无缺口字段时默认0)
          + 风控乘数(跌停×0.4 / 大跌×0.7 / ST×0.9) + R9 扣分 -10
          —— 现行 PWA v41 已改为无风控乘数、R9=-5、加入回调结构项 P1/P3/B1
"""
import statistics as st
from collections import defaultdict

# ============ R9 规则常量（⚠️ 历史档 3% / -10，勿用于现行评分） ============
# 现行定档在 strategy_final.py: R9_H_FINAL=5.0 / R9_PENALTY=-5（2026-09-30 改）。
# V28 生产评分走 r9_hit_final()，不读这里的常量；这里只保留给 2026-09 之前的历史脚本复现。
R9_K = 1.0        # 次日量/涨停日量 ≥ 1.0（放量）
R9_H = 3.0        # 【历史档】次日最高较涨停收盘冲高 ≥ 3%（现行=5.0）
R9_PENALTY = -10  # 【历史档】扣分幅度（现行=-5）

# ============ V6.0 六因子权重（W15 → W6 等比放大 ×1.185） ============
W6 = {'s1': 17.2, 's3': 23.7, 's4': 11.4, 's5': 13.7, 's6': 22.0, 's8': 12.2}
W15 = {'s1': 14.5, 's3': 20.0, 's4': 9.6, 's5': 11.6, 's6': 18.6, 's8': 10.3}

# ============ 因子桶分（与 PWA v24 / BACKTEST_RULES §1.2 逐字一致） ============
def S1(r):
    if r <= 1.00: return 0.0
    if r < 1.01: return 0.0
    if r < 1.02: return 6.4
    if r < 1.03: return 13.7
    if r < 1.04: return 14.5
    if r <= 1.05: return 12.8
    return 0.0

V6_S3 = {0: 0.0, 1: 0.5, 2: 13.6, 3: 20.0, 4: 5.4, 5: 10.0, 6: 10.5, 7: 7.2,
         8: 1.3, 9: 3.2, 10: 2.9, 11: 0.0, 12: 15.0, 13: 8.5, 14: 4.3, 15: 0.7,
         16: 5.1, 17: 5.2, 18: 9.8, 19: 8.8, 20: 4.7}
def S3(pd):
    if pd in V6_S3: return V6_S3[pd]
    if pd is not None and pd > 20: return 10.8
    return 0.0

def S4(sl):
    if sl <= 0: return 5.6
    if sl < 0.01: return 7.2
    if sl < 0.02: return 5.5
    if sl < 0.03: return 2.9
    if sl < 0.04: return 0.0
    if sl < 0.05: return 1.3
    if sl < 0.06: return 0.8
    if sl < 0.07: return 2.5
    return 9.6

def S5(lc):
    return {1: 9.1, 2: 11.6, 3: 7.9}.get(lc, 0.0)

def S6(vr):
    if vr is None: return 0.0
    if vr < 1.0: return 6.5
    if vr < 1.5: return 0.0
    if vr < 2.0: return 1.2
    if vr < 2.5: return 1.9
    if vr < 3.0: return 5.7
    if vr < 3.5: return 4.4
    if vr < 4.0: return 10.2
    if vr < 4.5: return 9.0
    if vr < 5.0: return 9.4
    if vr < 5.5: return 14.2
    if vr < 6.0: return 18.6
    return 3.6

def S8(g):
    if g <= 0: return 0.0
    if g < 0.01: return 9.1
    if g < 0.02: return 8.8
    if g < 0.03: return 10.3
    if g < 0.04: return 10.1
    if g < 0.05: return 7.7
    if g < 0.06: return 6.0
    if g < 0.07: return 7.3
    if g < 0.08: return 8.1
    if g < 0.09: return 0.0
    if g <= 0.10: return 2.1
    return 0.0

# ============ 核心评分（与 PWA scoreStock() 逐字一致） ============
def bucket_scores(c):
    """六因子原始桶分 dict"""
    return {'s1': S1(c['ratio']), 's3': S3(c['pullback']), 's4': S4(c['slope5']),
            's5': S5(c['limit_count']), 's6': S6(c['limit_vr']), 's8': S8(c['gap'])}

def v6score(c):
    """加权总分（W6/W15 归一），与 PWA total 一致"""
    b = bucket_scores(c)
    return round(sum(b[k] * W6[k] / W15[k] for k in b) * 10) / 10

def risk_multiplier(c):
    """风控乘数：跌停×0.4 / 大跌×0.7 / ST×0.9（与 PWA 一致）"""
    m = 1.0
    chg = c.get('chg')
    if chg is not None and chg <= -9.5: m *= 0.4
    elif chg is not None and chg <= -5: m *= 0.7
    if c.get('is_st'): m *= 0.9
    return m

def r9_hit(c, k=R9_K, h=R9_H):
    """R9 违规定义：最近涨停日次日 收阴 & 放量(≥k) & 冲高滞涨(≥h%)"""
    return bool(c.get('r9_yin')) and c.get('r9_vol_ratio') is not None \
        and c['r9_vol_ratio'] >= k and (c.get('r9_high_pct') or 0) >= h

def score_total(c, r9=True, s9=0.0):
    """完整策略分 = V6 加权总分 + S9扣分 + R9扣分, 再乘风控乘数
    s9: 未补缺口扣分(候选数据无缺口字段默认0; 有字段时传入 ≤0)
    """
    total = v6score(c)
    if s9 < 0:
        total = round((total + s9) * 10) / 10
    if r9 and r9_hit(c):
        total = round((total + R9_PENALTY) * 10) / 10
    return round(total * risk_multiplier(c) * 10) / 10

# ============ R1 分段（5 分一段，永久规则） ============
SEGMENTS = ['<=5'] + [f'{i}-{i+5}' for i in range(5, 100, 5)] + ['>=100']

def segment(score):
    if score <= 5: return '<=5'
    for lo in range(5, 100, 5):
        if score < lo + 5: return f'{lo}-{lo+5}'
    return '>=100'

# ============ 组合回测（每日等权，D1 次日收盘卖） ============
def daily_portfolio(cands, thr=70, r9=True, s9=0.0):
    """返回 {date: [d1,...]}：每日入选票（score>=thr）的 D1 列表"""
    days = defaultdict(list)
    for c in cands:
        if score_total(c, r9=r9, s9=s9) >= thr:
            days[c['date']].append(c['next_ret'])
    return days

def summarize(days, label=''):
    """按日聚合统计：交易日/票次/日D1均值/日胜率"""
    if not days:
        print(f'{label}: 无交易日'); return None
    dret = [st.mean(v) for v in days.values()]
    out = {
        'label': label, 'days': len(days), 'picks': sum(len(v) for v in days.values()),
        'avg_pick': round(sum(len(v) for v in days.values()) / len(days), 2),
        'd1': round(st.mean(dret), 4), 'win': round(sum(1 for r in dret if r > 0) / len(dret) * 100, 1),
    }
    print(f"{label}: 交易日{out['days']} 票次{out['picks']} 日均{out['avg_pick']} "
          f"日D1={out['d1']:+.3f}% 胜率={out['win']:.1f}%")
    return out

def r1_table(cands, r9=True, thr=70, s9=0.0):
    """R1 5分分段：每段 (n, D1均值, 胜率) — 按票口径"""
    from collections import defaultdict as dd
    seg = dd(list)
    for c in cands:
        sc = score_total(c, r9=r9, s9=s9)
        if sc >= thr:
            seg[segment(sc)].append(c['next_ret'])
    rows = []
    for s in SEGMENTS:
        if s in seg and len(seg[s]) >= 1:
            r = seg[s]
            rows.append({'seg': s, 'n': len(r), 'd1': round(st.mean(r), 4),
                         'win': round(sum(1 for x in r if x > 0) / len(r) * 100, 1)})
    return rows
__PY_R9_STRATEGY__

cat > "$ROOT/strategy_final.py" <<'__PY_STRATEGY_FINAL__'
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""FINAL 策略模块（定档方案权威实现）
================================================================
V6.0 六因子加权 + 风控乘数
  + R9 强势日次日放量滞涨扣分: k=1.0, h=5%, 扣 -5（2026-09-30 定档: -10→-5）
  + S9 未补跳空缺口扣分:    阈值 5% 起扣(≥5%扣6/≥7%扣8/≥10%扣10), distF 反转(越远扣越多)
  + 加分项: limit_vr ∈ [5,6) 加 +3
  + 回调结构 加减分项:
      P1 信号日高开≥1%              → 扣 -3
      P2 强势日日收盘封在最高位≥0.99   → 0 (未通过, 关闭)
      P3 信号日贴近强势日高点≥-3%(套牢) → 扣 -2
      B1 信号日深跌≤-5%             → 加 +2
评分顺序（与 PWA scoreStock() 一致）: total = (v6 + s9 + r9 + bonus + P1 + P2 + P3 + B1) × risk
================================================================
"""
import math
import sys
sys.path.insert(0, '/workspace/jayce-workflow/backtest-v15')
from r9_strategy import v6score, risk_multiplier, SEGMENTS, segment

# ===== 统一定档常量 =====
R9_K_FINAL = 1.0        # R9 放量阈值（次日量/强势日日量 ≥ 1.0）
R9_H_FINAL = 5.0        # R9 冲高阈值（次日最高较强势日收盘冲高 ≥ 5%）
R9_PENALTY = -5         # R9 扣分（2026-09-30 定档: -10→-5, 三窗口确认全为正: Δ全史+0.29/近5年+1.44/近3年+1.57）
S9_MIN_SIZE = 0.05      # S9 起扣缺口幅度（5%）
S9_DIST_MODE = 'inv'    # distF 反转：越远扣越多
BONUS_LVR_LO, BONUS_LVR_HI, BONUS_PTS = 5.0, 6.0, 3   # limit_vr 5~6 加 3 分
# 注: 三窗口扫描 lvr 幅度 {0,2,3,5,8} 年化Δ 全史(+0.39/+0.16/0/-1.28/-2.01)
#     / 近5年(-0.82/-0.78/0/-3.51/-6.81) / 近3年(+0.89/-0.61/0/-1.73/-1.60);
#     关掉(=0)只在近5年转负, 故保持 +3（旧结论"关闭更好"仅看全史2000起+近3年是错的）。

# ===== 回调结构 加减分项（2026-09-30 修订定档, 统一三窗口确认）=====
# 统一窗口口径: 全史=2005-01-01~2026-08-06(4868日, 剔2000~2004薄样本段)
#               近5年=2021-01-04~2026-08-06(1334日) / 近3年=2023-08-01~2026-08-06(710日)
# 口径: engine_v2 同款 (thr70 Top8 cap20 含真实费率; 剔科创/北交; ST 放行, 不按当前名称回溯剔除)
# 注: 上述三窗口数字为 2026-09-30 旧口径（ST 剔除 + 全市场统一 9.5% 强势日阈值）下的结果,
#     已不适用于现行口径; 2026-10-23 修复后的新数字见 strategy_v28.py 头注。
# 筛选: 只保留【三窗口 Δ 全为正】的因子; 幅度取三窗口联合最优
# 定档(方案H = P1-3 + P3-2 + 深跌+2 + R9-5):
#   全史 +15.09%→+17.50% (Δ+2.41, 回撤38.6%→34.0%, 夏普0.92→1.07)
#   近5年 +36.83%→+41.00% (Δ+4.16, 回撤22.4%→21.1%, 夏普1.66→1.84)
#   近3年 +18.31%→+20.16% (Δ+1.85, 回撤22.4%→21.1%, 夏普0.91→1.01)
# 被否掉的: P2 封最高≥0.99 / 回调≤2天 / 强势日次数≥3 / 未缩量≥0.8 / ratio<1.02 / 上影线≥3%
#            / 回调最大回撤 · 远离强势日高点 · 真封板 · gap≥7% · 量比≤0.5 (均至少一个窗口方向反转)
# 修订说明: 旧定档 P3=-8 只看"全史2000起+近3年"; 纳入近5年后 P3=-8 转负(-0.54) → 改 -2。
GAP_OPEN_MIN = 1.0      # P1 信号日跳空开盘 ≥ 1% → 减分
GAP_OPEN_PENALTY = -3   # 单条扫描 -2/-3/-4 三窗口皆正, -3 联合最优; ≥-6 在近5年/近3年翻负
SEAL_POS_MIN = 0.99     # P2 强势日日收盘封在最高位 ≥ 0.99 → 定档关闭
SEAL_POS_PENALTY = 0
NEAR_HIGH_MIN = -3.0    # P3 信号日收盘距强势日日最高 ≥ -3%(头顶套牢区) → 减分
NEAR_HIGH_PENALTY = -2  # -2/-3/-4 三窗口皆正; -2 联合最优 (旧 -8 在近5年转负)
DEEP_DROP_MAX = -5.0    # B1 信号日跌幅 ≤ -5%(深跌) → 加分
DEEP_DROP_BONUS = 2     # +2 全史/近3年为正, 近5年≈0; 加大在近5年/近3年翻负

def roundH(x):
    f = math.floor(x); d = x - f
    if d < 0.5: return float(f)
    if d > 0.5: return float(f + 1)
    return float(f) if f % 2 == 0 else float(f + 1)

def s9_recalc(c, min_size=S9_MIN_SIZE, dist_mode=S9_DIST_MODE):
    """S9 定档扣分：阈值 min_size 起扣，dist_mode='inv' 越远扣越多 / 'orig' 越远扣越少"""
    gs, gd = c.get('s9_gap_size'), c.get('s9_gap_dist')
    if gs is None:
        return 0.0
    pen = 0
    for mn, p in [(0.10, 10), (0.07, 8), (0.05, 6)]:
        if gs >= mn:
            pen = p
            break
    if pen == 0:
        return 0.0
    if dist_mode == 'inv':
        distF = 0.3 if gd < 0.30 else (0.6 if gd < 0.60 else 1.0)
    else:
        distF = 1.0 if gd < 0.30 else (0.6 if gd < 0.60 else 0.3)
    return -roundH(pen * distF * 10) / 10

def r9_hit_final(c, k=R9_K_FINAL, h=R9_H_FINAL):
    """R9 定档命中：次日收阴 & 放量(≥k) & 冲高滞涨(≥h%)"""
    return bool(c.get('r9_yin')) and c.get('r9_vol_ratio') is not None \
        and c['r9_vol_ratio'] >= k and (c.get('r9_high_pct') or 0) >= h

def lvr_bonus(c):
    """limit_vr ∈ [5,6) 加 3 分，否则 0"""
    lvr = c.get('limit_vr')
    if lvr is not None and BONUS_LVR_LO <= lvr < BONUS_LVR_HI:
        return BONUS_PTS
    return 0

# ===== 回调结构 减分项 =====
def gap_open_penalty(c, thr=GAP_OPEN_MIN, pts=GAP_OPEN_PENALTY):
    """P1 信号日高开≥1% → 减分(默认 -3)"""
    g = c.get('sig_gap_open')
    if g is not None and g >= thr:
        return pts
    return 0

def seal_pos_penalty(c, thr=SEAL_POS_MIN, pts=SEAL_POS_PENALTY):
    """P2 强势日日收盘封在最高位≥0.99 → 减分(定档 0=关闭)"""
    p = c.get('lim_close_pos')
    if p is not None and p >= thr:
        return pts
    return 0

def near_high_penalty(c, thr=NEAR_HIGH_MIN, pts=NEAR_HIGH_PENALTY):
    """P3 信号日收盘贴近强势日日最高(≥-3%, 头顶套牢) → 减分(默认 -2)"""
    d = c.get('pb_drop_hi')
    if d is not None and d >= thr:
        return pts
    return 0

def deep_drop_bonus(c, thr=DEEP_DROP_MAX, pts=DEEP_DROP_BONUS):
    """B1 信号日深跌≤-5% → 加分(默认 +2)"""
    g = c.get('chg')
    if g is not None and g <= thr:
        return pts
    return 0

def struct_penalty(c, gap_pts=GAP_OPEN_PENALTY, seal_pts=SEAL_POS_PENALTY,
                   near_pts=NEAR_HIGH_PENALTY):
    """三条回调结构减分项合计(≤0)"""
    return gap_open_penalty(c, pts=gap_pts) + seal_pos_penalty(c, pts=seal_pts) \
        + near_high_penalty(c, pts=near_pts)

def score_v6(c):
    """纯 V6 模型：六因子加权 × 风控乘数（无 R9/S9/加分）"""
    return round(v6score(c) * risk_multiplier(c) * 10) / 10

def score_final(c):
    """FINAL 定档方案：total = (v6 + s9 + r9 + bonus + P1 + P2 + P3 + B1) × risk"""
    tot = v6score(c)
    s9 = s9_recalc(c)
    if s9 < 0:
        tot = round((tot + s9) * 10) / 10
    if r9_hit_final(c):
        tot = round((tot + R9_PENALTY) * 10) / 10
    b = lvr_bonus(c)
    if b:
        tot = round((tot + b) * 10) / 10
    sp = struct_penalty(c)
    if sp:
        tot = round((tot + sp) * 10) / 10
    dd = deep_drop_bonus(c)
    if dd:
        tot = round((tot + dd) * 10) / 10
    return round(tot * risk_multiplier(c) * 10) / 10

def score_v28_struct(c, gap_pts=GAP_OPEN_PENALTY, seal_pts=SEAL_POS_PENALTY,
                     near_pts=NEAR_HIGH_PENALTY, deep_pts=DEEP_DROP_BONUS):
    """V28 基础分 + 回调结构 加减分项（可覆盖幅度）。
    注: 默认幅度已并入生产评分 strategy_v28.score_v28（方案H）；本函数保留供旧研究脚本扫档/对照。"""
    from strategy_v28 import v28_base
    tot = v28_base(c)
    sp = gap_open_penalty(c, pts=gap_pts) + seal_pos_penalty(c, pts=seal_pts) \
        + near_high_penalty(c, pts=near_pts)
    if sp:
        tot = round((tot + sp) * 10) / 10
    dd = deep_drop_bonus(c, pts=deep_pts)
    if dd:
        tot = round((tot + dd) * 10) / 10
    return round(tot * 10) / 10

def score_old(c):
    """现状模型（对比用）：V6 + S9现档(阈值1%, dist orig) + R9(h3, k1, -10)"""
    tot = v6score(c)
    s9 = c.get('s9', 0.0)
    if s9 < 0:
        tot = round((tot + s9) * 10) / 10
    from r9_strategy import r9_hit
    if r9_hit(c):   # 现状 h=3
        tot = round((tot + R9_PENALTY) * 10) / 10
    return round(tot * risk_multiplier(c) * 10) / 10
__PY_STRATEGY_FINAL__

cat > "$ROOT/strategy_v28.py" <<'__PY_STRATEGY_V28__'
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""V28 生产定版（2026-09-19 桶分审计+校准；2026-09-30 回调结构定档）: 无风控乘数 + 桶分校准 + 回调结构项
（原 strategy_v7 / score_v7，2026-09-24 统一命名为 v28，逻辑未变）
与 strategy_final 的差异:
  1) 风控乘数取消 (risk=1.0) —— 超跌反弹A桶实锤正收益, 惩罚过度 (grid-verification)
  2) 桶分校准 (26年D1审计 + 近5年逐年确认):
     S1 1.01-1.02: 6.4→2.0   (26年 D1 +0.02% 几乎中性, 高估)
     S3 4天: 5.4→3.0         (26年 D1 -0.07% 反向)
     S3 6天: 10.5→8.0        (26年 D1 +0.03% 高估)
     S3 13天: 8.5→3.0        (26年 D1 -0.02%, 近5年弱)
     S3 19天: 8.8→6.0        (26年 D1 -0.19% 反向)
     S6 ≥6: 3.6→10.0         (26年 D1 +0.09%, 近5年全正, 低估)
     S6 <1: 6.5→2.0          (26年 D1 +0.03%, 近5年4/5负, 高估)
     S8 4-5%: 7.7→5.0        (26年 D1 +0.02% 高估)
     S8 5-6%: 6.0→4.0        (26年 D1 +0.03% 高估)
  3) R9 扣分 -10 → -5 (2026-09-30 三窗口确认: Δ全史+0.29 / 近5年+1.44 / 近3年+1.57)
  4) 回调结构项并入 score_v28 (2026-09-30 定档, 方案H; 基础分见 v28_base):
     P1 信号日高开≥1% → -3  |  P3 信号日收盘贴近强势日最高(≥-3%) → -2  |  B1 信号日深跌≤-5% → +2
     (P2 强势日封最高≥0.99 未通过, 关闭为 0)
  评分顺序: score_v28 = v28_base(六因子校准+S9+R9+加分) → +(P1+P2+P3) → +B1, 每步半数取偶1位
  验证 (组合层 Top8 thr70 cap20, 成本后; 2026-10-23 按现行口径重算):
    口径: 唯一生产池 candidates_full_r9s9.json / 强势日=全市场统一 9.5% / R9 无前视 / ST 放行
         / 可交易池=沪深主板+创业板(剔科创/北交, T0跌停剔除)
    "基线V28"=不启用 P1/P2/P3 (即 B2 臂); "本版"=启用回调结构项 (B 臂)。两者同池同区间。
    全史 2005-01-05~2026-08-06 (4797日): 年化 +15.73% → +17.26%  回撤 36.43%→31.66%  夏普 0.92→1.03
    近6年 2021-01-04~2026-08-06 (1330日): 年化 +39.84% → +42.89%  回撤 22.74%→22.21%  夏普 1.72→1.87
    2014-2019 (1345日):                年化  +4.90% →  +5.62%  回撤 32.95%→30.66%  夏普 0.38→0.43
    现行生产全区间 2005-01-05~2026-10-21 (4843日, 不剔任何日期): 累计 +1865.6%  年化 +16.76%  回撤 31.66%  夏普 1.00
    (2026-08-07 是真实全市场大涨日: 中证1000 +1.98%, 组合当日 +4.63%, 次日开盘买 +4.71%; 旧"复权断裂"判断已纠正)
  说明: 回撤 36.43% 为跨年连续回撤(峰 2017-12-12 → 谷 2020-06-19); 旧报告的 27.3% 疑为"逐年重置峰值"的假回撤
        (2018 单年内回撤 28.5%), 实际被低估约 11pp。
        2026-10-23 修复记录(旧数字 +15.09%→+17.50% 作废, 因旧池缺结构字段且 R9 有 pullback=0 前视):
        · 结构字段 sig_gap_open/lim_close_pos/pb_drop_hi 并入生产池 → P1/P3 真正生效
        · R9 只在次日 j<=i 时评估 → 消除 21 条(0.02%)"用未来数据"的候选
        · 单源化: 废弃 recent/live/oct 四池合并, 只读本文件 (旧合并会用缺字段侧车池覆盖)
        · 强势日口径保持 9.5%: 改成创业板 1.195 会让 2020+ 累计 447%→135%, 仅作 LIMIT_MODE=truelimit 研究对照
        · 修复前后对比: 2020+ 447.5%→533.7% / 全周期 1500.9%→1973.3% / 夏普 0.92→1.03
        2026-10-23 反幻觉审计(详见 RESEARCH_INDEX 第十章, "方向可信、幅度打折"):
        · 置换检验 40 次: 真实 B 全周期落随机分布 100% 分位, 2020+ 落 98% 分位 → P1/P3 位置信息非噪声
        · 但配对 t=1.59(不显著), 10日块 bootstrap 95%CI 跨0; thr=72/74 时增益反转为负
        · 增益是"排序微调"而非换股: Jaccard 0.893, 平均持仓 2.71→2.45, 空仓日占比不变
        · 极值依赖低: 剔最好 20 日仍 +146.8pp; 剔 2021 年仍 +128.9pp
"""
import sys
sys.path.insert(0, '/workspace/jayce-workflow/backtest-v15')
import r9_strategy as R9
from strategy_final import (s9_recalc, lvr_bonus, r9_hit_final, R9_PENALTY,
                            gap_open_penalty, seal_pos_penalty, near_high_penalty,
                            deep_drop_bonus)

CALIB = {
    ('s1', '1.01-1.02'): 2.0,
    ('s3', 4): 3.0, ('s3', 13): 3.0, ('s3', 19): 6.0, ('s3', 6): 8.0,
    ('s6', '>=6'): 10.0, ('s6', '<1'): 2.0,
    ('s8', '4-5%'): 5.0, ('s8', '5-6%'): 4.0,
}

def s1_b(c):
    v = c['ratio']
    if v <= 1.00: return '<=1.00'
    if v < 1.01: return '1.00-1.01'
    if v < 1.02: return '1.01-1.02'
    if v < 1.03: return '1.02-1.03'
    if v < 1.04: return '1.03-1.04'
    if v <= 1.05: return '1.04-1.05'
    return '>1.05'

def s6_b(c):
    vr = c['limit_vr']
    if vr is None: return None
    if vr < 1.0: return '<1'
    if vr < 1.5: return '1-1.5'
    if vr < 2.0: return '1.5-2'
    if vr < 2.5: return '2-2.5'
    if vr < 3.0: return '2.5-3'
    if vr < 3.5: return '3-3.5'
    if vr < 4.0: return '3.5-4'
    if vr < 4.5: return '4-4.5'
    if vr < 5.0: return '4.5-5'
    if vr < 5.5: return '5-5.5'
    if vr < 6.0: return '5.5-6'
    return '>=6'

def s8_b(c):
    g = c['gap']
    if g <= 0: return '<=0'
    if g < 0.01: return '0-1%'
    if g < 0.02: return '1-2%'
    if g < 0.03: return '2-3%'
    if g < 0.04: return '3-4%'
    if g < 0.05: return '4-5%'
    if g < 0.06: return '5-6%'
    if g < 0.07: return '6-7%'
    if g < 0.08: return '7-8%'
    if g < 0.09: return '8-9%'
    if g <= 0.10: return '9-10%'
    return '>10%'

def v28_calib(c):
    s1 = R9.S1(c['ratio']); s3 = R9.S3(c['pullback'])
    s4 = R9.S4(c['slope5']); s5 = R9.S5(c['limit_count'])
    s6 = R9.S6(c['limit_vr']); s8 = R9.S8(c['gap'])
    if ('s1', s1_b(c)) in CALIB: s1 = CALIB[('s1', s1_b(c))]
    if ('s3', c['pullback']) in CALIB: s3 = CALIB[('s3', c['pullback'])]
    b6 = s6_b(c)
    if b6 and ('s6', b6) in CALIB: s6 = CALIB[('s6', b6)]
    if ('s8', s8_b(c)) in CALIB: s8 = CALIB[('s8', s8_b(c))]
    b = {'s1': s1, 's3': s3, 's4': s4, 's5': s5, 's6': s6, 's8': s8}
    return round(sum(b[k] * R9.W6[k] / R9.W15[k] for k in b) * 10) / 10

def v28_base(c):
    """V28 基础分（不含回调结构项）: 六因子校准 + S9 + R9 + limit_vr 加分（×1.0 无风控）"""
    tot = v28_calib(c)
    s9 = s9_recalc(c)
    if s9 < 0:
        tot = round((tot + s9) * 10) / 10
    if r9_hit_final(c):
        tot = round((tot + R9_PENALTY) * 10) / 10
    b = lvr_bonus(c)
    if b:
        tot = round((tot + b) * 10) / 10
    return round(tot * 10) / 10

def score_v28(c):
    """V28 生产定版评分（2026-09-30 回调结构定档, 方案H）
    = v28_base + P1(信号日高开≥1% -3) + P3(信号日收盘贴近涨停日最高 -2) + B1(信号日深跌≤-5% +2)
    与 PWA index.html 逐字一致；三窗口确认年化全升/回撤全降（详见 strategy_final.py 头注）"""
    tot = v28_base(c)
    sp = gap_open_penalty(c) + seal_pos_penalty(c) + near_high_penalty(c)
    if sp:
        tot = round((tot + sp) * 10) / 10
    dd = deep_drop_bonus(c)
    if dd:
        tot = round((tot + dd) * 10) / 10
    return round(tot * 10) / 10
__PY_STRATEGY_V28__

cat > "$ROOT/deep_audit/25_breadth_slope.py" <<'__PY_BREADTH_SLOPE__'
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""25_breadth_slope.py — 市场宽度 MA20/MA30 到底有没有「斜率」，斜率能不能单独当一盏灯

问题来源（用户）
  「宽度的 MA20/MA30 有没有斜率这个说法？我感觉会有。验证一下」

先回答「有没有」
  有，而且是定义级的：
      MA20_t = (adv_{t-19} + ... + adv_t) / 20
      MA20_t - MA20_{t-n} = (最近 n 天 adv 之和 - 再往前 n 天 adv 之和) / 20
  也就是说，**MA20 的一阶差分就是「新进窗的 adv 减掉滚出窗的 adv」**，
  它衡量的是宽度动量，和「宽度水平」是两个正交维度。
  本脚本先给描述统计（它到底动不动、动多大、两盏灯的 MA20/MA30 斜率是否同向），
  再回答「有没有用」：
    A. 斜率对未来一天的策略毛收益有没有预测力（分位数 + 相关系数）
    B. 在【灯亮】和【灯灭】两种状态下，斜率是否还能再分一层
    C. 把斜率接成第三盏灯 / 迟滞恢复 / 分档仓位，组合口径跑全窗口
    D. 参数热力图 + 前后两段样本外，判断是平台还是尖峰

口径
  · 基础日序列 = 生产口径 E0（thr70 / Top8 / 单票 cap20% / gap(0,0.10] / ratio>1.01 / 逐年法定成本）
  · 灯的时点 = lag0（收盘算宽度，同日收盘决策），与生产 v41.7 一致
  · 年化分母用真实交易日历（trade_calendar.json），不是「有候选的日子」

输出 out/breadth_slope.json
"""
import json, math, statistics as st
from collections import defaultdict
import sys

B = '/workspace/jayce-workflow/backtest-v15/'
A = B + 'deep_audit/'
OUT = A + 'out/'
sys.path.insert(0, B)
from engine_v2 import filter_tradable, round_trip_cost
from strategy_v28 import score_v28

WINDOWS = [('2005+', '2005-01-01', '2099-12-31'),
           ('2005-2013', '2005-01-01', '2013-12-31'),
           ('2014-2019', '2014-01-01', '2019-12-31'),
           ('2015+', '2015-01-01', '2099-12-31'),
           ('2020', '2020-01-01', '2020-12-31'),
           ('2021+', '2021-01-01', '2099-12-31')]


# ================================================================ 交易日历
def load_cal():
    c = json.load(open(OUT + 'trade_calendar.json'))
    dates = c['dates'] if isinstance(c, dict) else c
    return sorted(str(d) for d in dates)


CAL = load_cal()
CAL_N = len(CAL)
CAL_I = {d: i for i, d in enumerate(CAL)}


# ================================================================ 指标
def metrics(dates, daily, n_total=None):
    """daily 为百分数序列；n_total = 区间真实交易日数（年化分母）"""
    r = [x / 100.0 for x in daily]
    if not r:
        return {}
    e = peak = 1.0
    dd = 0.0
    for x in r:
        e *= 1 + x
        peak = max(peak, e)
        dd = max(dd, 1 - e / peak)
    sd = st.pstdev(r)
    n = n_total or len(r)
    return {'n_cand_days': len(r), 'n_total': n,
            'cum': round((e - 1) * 100, 1),
            'ann': round((e ** (252.0 / n) - 1) * 100, 2),
            'mdd': round(dd * 100, 2),
            'sharpe': round(st.mean(r) / sd * math.sqrt(252), 2) if sd else 0.0}


def span_days(lo, hi):
    return sum(1 for d in CAL if lo <= d <= hi)


def win_metrics(dates, daily):
    last = dates[-1]
    out = {}
    for w, lo, hi in WINDOWS:
        sub = [v for d, v in zip(dates, daily) if lo <= d <= hi]
        if not sub:
            continue
        end = hi if hi < '2099' else last
        out[w] = metrics(sub, sub, span_days(max(lo, dates[0]), end))
    return out


# ================================================================ 基础日序列
def load_wide():
    cs = filter_tradable(json.load(open(OUT + 'candidates_hfq_wide.json')))
    for c in cs:
        c['score'] = score_v28(c)
    return cs


def G(c):
    return c.get('gap_raw', c['gap'])


def RT(c):
    return c.get('ratio_raw', c['ratio'])


def build_base(thr=70, topn=8, gap_lo=0.0, gap_hi=0.10, ratio_lo=1.01,
               start='2005-01-01'):
    """生产口径；返回日期 / 毛收益(%) / 净收益(%) / 持仓数"""
    dm = defaultdict(list)
    for c in load_wide():
        dm[c['date']].append(c)
    dates, gross, net, hold = [], [], [], []
    for dt in sorted(d for d in dm if d >= start):
        pool = [c for c in dm[dt]
                if c['score'] >= thr and gap_lo < G(c) <= gap_hi
                and RT(c) > ratio_lo - 1e-12]
        pool.sort(key=lambda c: c['score'], reverse=True)
        sel = pool[:topn]
        dates.append(dt)
        if not sel:
            gross.append(0.0)
            net.append(0.0)
            hold.append(0)
            continue
        w = min(0.20, 1.0 / len(sel))
        g = sum(c['next_ret'] * w for c in sel)
        cst = len(sel) * w * round_trip_cost(dt) * 100
        gross.append(g)
        net.append(g - cst)
        hold.append(len(sel))
    return dates, gross, net, hold


# ================================================================ 宽度与斜率
def load_breadth():
    br0 = json.load(open(B + 'market_breadth.json'))
    ADV = {d: br0[d]['ratio_up'] for d in br0 if 'ratio_up' in br0[d]}
    for row in json.load(open(B + 'regime_breadth.json')):
        ADV[row['date']] = float(row['adv'])
    AK = sorted(ADV)
    V = [float(ADV[d]) for d in AK]
    AP = {d: i for i, d in enumerate(AK)}

    def ma(k):
        out = [None] * len(V)
        s = 0.0
        for i, v in enumerate(V):
            s += v
            if i >= k:
                s -= V[i - k]
            if i >= k - 1:
                out[i] = s / k * 100.0
        return out

    MA = {20: ma(20), 30: ma(30)}

    def slope(k, n):
        """MA_k 的 n 日差分（pp），None = 历史不足"""
        m = MA[k]
        out = [None] * len(m)
        for i in range(len(m)):
            if i - n >= 0 and m[i] is not None and m[i - n] is not None:
                out[i] = m[i] - m[i - n]
        return out

    SL = {(k, n): slope(k, n) for k in (20, 30) for n in (1, 3, 5, 10, 20)}
    return AK, AP, MA, SL


# ================================================================ 灯
def prod_off(AP, MA, dt, thr=42.0):
    i = AP.get(dt)
    if i is None:
        return False
    a, b = MA[20][i], MA[30][i]
    return ((a is not None and a < thr) or (b is not None and b < thr))


def sl(AP, SL, k, n, dt):
    i = AP.get(dt)
    if i is None:
        return None
    return SL[(k, n)][i]


# ================================================================ A 描述统计
def describe(AP, MA, SL, AK):
    def q(v):
        v = sorted(v)
        if not v:
            return None
        def p(x):
            return round(v[min(len(v) - 1, int(x * (len(v) - 1)))], 3)
        return {'n': len(v), 'p05': p(.05), 'p25': p(.25), 'p50': p(.50),
                'p75': p(.75), 'p95': p(.95), 'min': round(v[0], 3),
                'max': round(v[-1], 3), 'std': round(st.pstdev(v), 3)}
    out = {'calendar': {'adv_days': len(AK), 'first': AK[0], 'last': AK[-1]},
           'level': {'ma20': q([x for x in MA[20] if x is not None]),
                     'ma30': q([x for x in MA[30] if x is not None])}}
    for (k, n), arr in SL.items():
        key = 'ma%d_d%d' % (k, n)
        v = [x for x in arr if x is not None]
        s = q(v)
        s['pct_up'] = round(100 * sum(1 for x in v if x > 0) / len(v), 1)
        s['pct_zero'] = round(100 * sum(1 for x in v if x == 0) / len(v), 1)
        out[key] = s
    # MA20 与 MA30 斜率是否同向 / 与水平的相关系数
    agree, both = 0, 0
    lv, sv, raw_sv = [], [], []
    for i in range(len(MA[20])):
        a, b = SL[(20, 5)][i], SL[(30, 5)][i]
        if a is None or b is None:
            continue
        both += 1
        agree += int((a > 0) == (b > 0))
        lv.append(MA[20][i])
        sv.append(a)
    out['ma20slope5_vs_ma30slope5_same_sign_pct'] = round(100 * agree / both, 1)
    if both > 3:
        mx, my = st.mean(lv), st.mean(sv)
        num = sum((x - mx) * (y - my) for x, y in zip(lv, sv))
        den = math.sqrt(sum((x - mx) ** 2 for x in lv) * sum((y - my) ** 2 for y in sv))
        out['corr_level_ma20_vs_slope5'] = round(num / den, 3) if den else None
    # 斜率自身的自相关（lag1）
    v = [x for x in SL[(20, 5)] if x is not None]
    if len(v) > 10:
        m1, m2 = v[:-1], v[1:]
        mx, my = st.mean(m1), st.mean(m2)
        num = sum((a - mx) * (b - my) for a, b in zip(m1, m2))
        den = math.sqrt(sum((a - mx) ** 2 for a in m1) * sum((b - my) ** 2 for b in m2))
        out['ma20slope5_autocorr1'] = round(num / den, 3) if den else None
    return out


# ================================================================ B 状态 × 斜率
def cell(dates, gross, mask):
    v = [g for d, g in zip(dates, gross) if mask(d)]
    return {'days': len(v), 'mean_bp': round(st.mean(v) * 100, 2) if v else None,
            'win_pct': round(100 * sum(1 for x in v if x > 0) / len(v), 1) if v else None}


def state_slope(dates, gross, AP, MA, SL, k=20, n=5):
    rows = defaultdict(list)
    for d, g in zip(dates, gross):
        off = prod_off(AP, MA, d)
        s = sl(AP, SL, k, n, d)
        if s is None:
            continue
        key = ('off' if off else 'on') + ('_sl+' if s > 0 else ('_sl0' if s == 0 else '_sl-'))
        rows[key].append(g)
    out = {key: {'days': len(v), 'mean_bp': round(st.mean(v) * 100, 2),
                 'win_pct': round(100 * sum(1 for x in v if x > 0) / len(v), 1)}
           for key, v in sorted(rows.items())}
    # 在「灯灭」里，斜率转正是否意味着可以提前恢复
    offp = rows.get('off_sl+', [])
    offm = rows.get('off_sl-', [])
    onp = rows.get('on_sl+', [])
    onm = rows.get('on_sl-', [])
    def diff(a, b):
        if len(a) < 20 or len(b) < 20:
            return None
        ma, mb = st.mean(a), st.mean(b)
        sa = st.pstdev(a) / math.sqrt(len(a))
        sb = st.pstdev(b) / math.sqrt(len(b))
        se = math.sqrt(sa * sa + sb * sb)
        return {'diff_bp': round((ma - mb) * 100, 2),
                't': round((ma - mb) / se, 2) if se else None}
    out['_tests'] = {'off_sl+_minus_off_sl-': diff(offp, offm),
                     'on_sl+_minus_on_sl-': diff(onp, onm)}
    return out


def ic(dates, gross, AP, SL, k=20, n=5):
    """斜率 vs 次日毛收益的 Pearson / Spearman（只在有持仓的日子）"""
    xs, ys = [], []
    for d, g in zip(dates, gross):
        s = sl(AP, SL, k, n, d)
        if s is None or g == 0.0:
            continue
        xs.append(s)
        ys.append(g)
    if len(xs) < 50:
        return None

    def corr(a, b):
        ma, mb = st.mean(a), st.mean(b)
        num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
        den = math.sqrt(sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b))
        return num / den if den else None

    def rank(v):
        idx = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        i = 0
        while i < len(idx):
            j = i
            while j + 1 < len(idx) and v[idx[j + 1]] == v[idx[i]]:
                j += 1
            avg = (i + j) / 2.0 + 1
            for t in range(i, j + 1):
                r[idx[t]] = avg
            i = j + 1
        return r

    return {'n': len(xs), 'pearson': round(corr(xs, ys), 3),
            'spearman': round(corr(rank(xs), rank(ys)), 3)}


# ================================================================ C 组合口径
def variant(dates, net, AP, MA, SL, kind, k=20, n=5, thr=42.0, grad_lo=0.5):
    fac = []
    state = 1
    for d in dates:
        i = AP.get(d)
        if i is None:
            fac.append(1.0)
            continue
        a, b = MA[20][i], MA[30][i]
        bad = ((a is not None and a < thr) or (b is not None and b < thr))
        s = SL[(k, n)][i]
        if kind == 'prod':
            fac.append(0.0 if bad else 1.0)
        elif kind == 'third_light':          # 灯亮但要再加斜率条件
            fac.append(0.0 if (bad or s is None or s <= 0) else 1.0)
        elif kind == 'hysteresis':           # 跌破后必须斜率转正才恢复
            if bad:
                state = 0
            elif state == 0:
                if s is not None and s > 0:
                    state = 1
            fac.append(float(state))
        elif kind == 'slope_only':           # 只用斜率，不用 42% 阈值
            fac.append(0.0 if (s is None or s <= 0) else 1.0)
        elif kind == 'graded':               # 灯亮但斜率向下 → 半仓
            if bad:
                fac.append(0.0)
            elif s is None or s > 0:
                fac.append(1.0)
            else:
                fac.append(grad_lo)
        elif kind == 'lever':                # 灯亮且斜率向上 → 加满；否则半仓
            if bad:
                fac.append(0.0)
            elif s is not None and s > 0:
                fac.append(1.0)
            else:
                fac.append(0.5)
        else:
            raise ValueError(kind)
    d2 = [r * f for r, f in zip(net, fac)]
    return d2, fac


def switches(fac):
    """灯状态切换次数（用来度量 whipsaw）"""
    return sum(1 for i in range(1, len(fac)) if (fac[i] > 0) != (fac[i - 1] > 0))


def paired_t(a, b):
    d = [x - y for x, y in zip(a, b)]
    if len(d) < 30:
        return None
    sd = st.pstdev(d)
    if not sd:
        return None
    return round(st.mean(d) / (sd / math.sqrt(len(d))), 2)


# ================================================================ main
def main():
    rep = {}
    dates, gross, net, hold = build_base()
    print('基础序列', len(dates), dates[0], dates[-1], flush=True)
    rep['base'] = {'cand_days': len(dates), 'calendar_days': CAL_N,
                   'first': dates[0], 'last': dates[-1],
                   'prod': win_metrics(dates, net)}

    AK, AP, MA, SL = load_breadth()
    rep['A_describe'] = describe(AP, MA, SL, AK)
    print('描述统计完成', flush=True)

    # ---------- B 状态 × 斜率 ----------
    rep['B_state_slope'] = {('ma%d_d%d' % (k, n)): state_slope(dates, gross, AP, MA, SL, k, n)
                            for k, n in ((20, 1), (20, 5), (20, 10), (30, 5))}
    print('B 完成', flush=True)

    # ---------- A2 IC ----------
    rep['A2_ic'] = {('ma%d_d%d' % (k, n)): ic(dates, gross, AP, SL, k, n)
                    for k, n in ((20, 1), (20, 3), (20, 5), (20, 10), (30, 5))}

    # ---------- C 组合口径 ----------
    rep['C_variants'] = {}
    prod_d, _ = variant(dates, net, AP, MA, SL, 'prod')
    rep['C_variants']['prod'] = {'windows': win_metrics(dates, prod_d),
                                 'switches': switches([0.0 if prod_off(AP, MA, d) else 1.0 for d in dates])}
    print('prod', rep['C_variants']['prod']['windows']['2005+'], flush=True)

    grid = [('third_light', k, n) for k in (20, 30) for n in (1, 3, 5, 10, 20)] + \
           [('hysteresis', k, n) for k in (20, 30) for n in (1, 3, 5, 10, 20)] + \
           [('graded', 20, n) for n in (1, 3, 5, 10)] + \
           [('lever', 20, 5)] + [('slope_only', 20, n) for n in (1, 3, 5, 10, 20)]
    for kind, k, n in grid:
        d2, fac = variant(dates, net, AP, MA, SL, kind, k, n)
        tag = '%s_ma%d_d%d' % (kind, k, n)
        w = win_metrics(dates, d2)
        rep['C_variants'][tag] = {'windows': w, 'switches': switches(fac),
                                  'zero_days': sum(1 for f in fac if f == 0.0),
                                  'avg_factor': round(st.mean(fac), 3),
                                  't_vs_prod': paired_t(d2, prod_d)}
        print(tag, w['2005+'], flush=True)

    # ---------- D 稳健性：前后两段 ----------
    rep['D_split'] = {}
    half = '2016-01-01'
    d_cases = {'prod': None,
               'third_light_ma20_d5': ('third_light', 20, 5),
               'hysteresis_ma20_d5': ('hysteresis', 20, 5),
               'third_light_ma20_d10': ('third_light', 20, 10),
               'hysteresis_ma20_d10': ('hysteresis', 20, 10)}
    for tag, spec in d_cases.items():
        if spec is None:
            dd = prod_d
        else:
            dd, _ = variant(dates, net, AP, MA, SL, *spec)
        a = [v for d, v in zip(dates, dd) if d < half]
        b = [v for d, v in zip(dates, dd) if d >= half]
        rep['D_split'][tag] = {
            'H1': metrics(a, a, span_days(dates[0], '2015-12-31')),
            'H2': metrics(b, b, span_days('2016-01-01', dates[-1]))}

    # ---------- E 逐年 ----------
    rep['E_yearly'] = {}
    chosen = {'prod': prod_d}
    for tag, spec in {'third_light_ma20_d5': ('third_light', 20, 5),
                      'hysteresis_ma20_d5': ('hysteresis', 20, 5)}.items():
        chosen[tag], _ = variant(dates, net, AP, MA, SL, *spec)
    for y in range(2005, 2027):
        lo, hi = '%d-01-01' % y, '%d-12-31' % y
        rep['E_yearly'][str(y)] = {}
        for tag, dd in chosen.items():
            v = [x for d, x in zip(dates, dd) if lo <= d <= hi]
            if not v:
                continue
            e = 1.0
            for x in v:
                e *= 1 + x / 100.0
            rep['E_yearly'][str(y)][tag] = {'cum': round((e - 1) * 100, 1),
                                            'n': len(v)}

    json.dump(rep, open(OUT + 'breadth_slope.json', 'w'), ensure_ascii=False, indent=1)
    print('\n=== 结论速览 ===')
    print(json.dumps({k: rep[k] for k in ('base', 'A2_ic', 'B_state_slope')},
                     ensure_ascii=False, indent=1))
    print(json.dumps({k: v['windows']['2005+'] for k, v in rep['C_variants'].items()},
                     ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
__PY_BREADTH_SLOPE__

cat > "$ROOT/deep_audit/HANDOFF_25.md" <<'__MD_HANDOFF__'
# HANDOFF：宽度 MA20/MA30 斜率验证（任务交接单）

## 一句话目标
用户问：宽度的 MA20/MA30 有没有「斜率」这回事？斜率能不能当第三盏灯？——要求**实测数字**，不要概念解释。

## 立刻执行（第一步，只跑这一条）
```bash
cd /workspace/jayce-workflow/backtest-v15/deep_audit && python3 25_breadth_slope.py
```
成功标志：生成 `out/breadth_slope.json`，同时 `out/breadth_slope.log` 是完整输出。

若报 Python 错误，按 traceback 修；脚本已修过一次 `D_split`/`E_yearly` 的 `int(tag)` bug。

## 脚本口径（不要改）
- 基础日序列 = 生产口径 E0（thr70 / Top8 / 单票 cap20% / gap(0,0.10] / ratio>1.01 / 逐年法定成本）
- 灯的时点 lag0，与生产 v41.7 一致（宽度 MA20 或 MA30 任一 <42% → 空仓）
- 年化分母 = 真实交易日历 `out/trade_calendar.json`（5,294 天），不是「有候选的日子」
- 数据：`market_breadth.json`（ratio_up）+ `regime_breadth.json` 覆盖尾部（adv）；研究池 `out/candidates_hfq_wide.json`

## 跑完后必须给用户的数字（按此顺序出表）
1. **有没有**：MA20/MA30 斜率 d1/d3/d5/d10/d20 的分位数、正值占比、MA20 与 MA30 斜率同向比例、斜率与水平的相关系数、斜率自相关 lag1
2. **有没有用**：斜率对次日毛收益的 Pearson/Spearman IC；灯亮/灯灭 × 斜率正/负/零 六格的日均 bp 与胜率；`off_sl+ − off_sl-` 的差值与 t 值
3. **能不能加灯**：prod / third_light / hysteresis / slope_only / graded / lever 六口径 × (MA20×MA30) × (n=1/3/5/10/20) 网格，2005+ 的年化 / 最大回撤 / Sharpe，与 prod 对比
4. **是平台还是尖峰**：网格相邻参数是否平滑；2016 前后两段样本外是否同向；逐年表

## 已知基线（用于对比，真分母口径）
prod 2005+：年化约 15.34%（旧分母 16.51%）、回撤 43.49%、Sharpe 0.93；空仓 416 天，避掉 −24.26% 的基准收益。

## 结论落地
- 写进 `CONCLUSION_HFQ.md` 新增 7.15 节
- `RESEARCH_INDEX.md` 第十四节补一条
- 若斜率无效，明确写「无效」，不要含糊

## 必须一起带走的文件（10 个，缺一不可）
新任务里必须原样落盘到下面的路径（脚本里路径是硬编码的 `/workspace/jayce-workflow/backtest-v15/`）：

```
/workspace/jayce-workflow/backtest-v15/
├── engine_v2.py                (filter_tradable / round_trip_cost)
├── strategy_v28.py             (score_v28)
├── strategy_final.py           (strategy_v28 的依赖)
├── r9_strategy.py              (strategy_final / strategy_v28 的依赖)
├── market_breadth.json         1,379 KB  ratio_up 主序列 2005→
├── regime_breadth.json         7 KB      尾部 adv 覆盖
└── deep_audit/
    ├── 25_breadth_slope.py     本脚本
    ├── HANDOFF_25.md           本文件
    └── out/
        ├── candidates_hfq_wide.json   研究池（最大件，几十 MB 量级）
        └── trade_calendar.json        120 KB  年化真分母 5,294 天
```

可选（用于校验/落地，不是跑脚本必需）：
- `out/e0_daily_hfq.json`（144 KB，基线日序列，可校验 prod 2005+ 年化 15.34% 是否复现）
- `CONCLUSION_HFQ.md`、`RESEARCH_INDEX.md`（结论落地位置）
- `rebuild.sh`（如需重建研究池）

不要下载：`hfq/`（GB 级）、`hfq/stock_adj/`、`out/*.log`、`_archive/`。

依赖全部是 Python 标准库（json / math / statistics / collections），不需要 pandas。

## 环境说明
上一会话的沙箱 toolhost 挂了（`Host toolhost manager not initialized`），Shell 全不可用，故交接至此。
先确认数据还在：`ls /workspace/jayce-workflow/backtest-v15/deep_audit/out | head`。
若 `/workspace` 为空，数据需重建：`hfq/` 由 `10_fetch_raw.py` + `11_fetch_events.py` + `12_build_hfq.py` 生成，
研究池由 `13e` 步骤重建（见 `rebuild.sh`），`market_breadth.json` / `regime_breadth.json` 在 `backtest-v15/` 根目录。
__MD_HANDOFF__

echo "== 已还原的代码/文档 =="
for f in "$ROOT/engine_v2.py" "$ROOT/r9_strategy.py" "$ROOT/strategy_final.py" \
         "$ROOT/strategy_v28.py" "$ROOT/deep_audit/25_breadth_slope.py" \
         "$ROOT/deep_audit/HANDOFF_25.md"; do
  echo "OK  $f"
done

echo "== 数据文件检查（本包不含，需手动放置）=="
for f in "$ROOT/market_breadth.json" "$ROOT/regime_breadth.json" \
         "$ROOT/deep_audit/out/trade_calendar.json" \
         "$ROOT/deep_audit/out/candidates_hfq_wide.json"; do
  if [ -f "$f" ]; then echo "OK    $f"; else echo "缺失  $f"; fi
done

echo
echo "下一步：cd $ROOT/deep_audit && python3 25_breadth_slope.py"
