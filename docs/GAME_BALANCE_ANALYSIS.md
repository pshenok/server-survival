# Game Balance Mathematical Model

This document provides a mathematical analysis of Server Survival's game balance, addressing issue #17.

## Table of Contents
1. [Game Parameters Summary](#game-parameters-summary)
2. [Sustainability Threshold Analysis](#1-sustainability-threshold-analysis)
3. [Economic Viability Analysis](#2-economic-viability-analysis)
4. [Optimal Ratios Analysis](#3-optimal-ratios-analysis)
5. [Upgrade Timing Analysis](#4-upgrade-timing-analysis)
6. [Failure Cascade Analysis](#5-failure-cascade-analysis)
7. [Recommendations](#recommendations)

---

## Game Parameters Summary

### Starting Conditions
- **Starting Budget:** $340
- **Base RPS:** 0.6 req/s
- **RPS Growth Formula:** `RPS = 0.6 + ln(1 + t/30) × 1.8`

### Traffic Distribution
| Type | Percentage | Destination | Reward | Processing Weight |
|------|------------|-------------|--------|-------------------|
| STATIC | 30% | S3 | $0.80 | 0.5 |
| READ | 20% | DB | $1.20 | 1.0 |
| WRITE | 15% | DB | $1.80 | 1.5 |
| UPLOAD | 5% | S3 | $2.00 | 2.0 |
| SEARCH | 10% | DB | $1.20 | 2.5 |
| MALICIOUS | 20% | Blocked | $0.00 | 1.0 |

**Legitimate Traffic:** 80% (S3: 35%, DB: 45%)

### Service Costs & Capacities
| Service | Cost | Upkeep/s | Capacity | Processing Time (ms) |
|---------|------|----------|----------|---------------------|
| WAF | $40 | $4/min | 100 | 20 |
| ALB | $50 | $6/min | 50 | 50 |
| Compute T1 | $60 | $12/min | 4 | 600 |
| Compute T2 | +$100 | $12/min | 10 | 600 |
| Compute T3 | +$160 | $12/min | 18 | 600 |
| S3 | $25 | $5/min | 100 | 200 |
| DB T1 | $150 | $24/min | 8 | 300 |
| DB T2 | +$200 | $24/min | 20 | 300 |
| DB T3 | +$350 | $24/min | 35 | 300 |
| Cache T1 | $60 | $8/min | 30 | 50 |
| SQS | $35 | $2/min | 10 (queue: 200) | 100 |

### Upkeep Scaling
- Multiplier scales from 1.0× to 2.0× over 600 seconds (10 minutes)
- Formula: `multiplier = 1.0 + (2.0 - 1.0) × min(t/600, 1.0)`

### Failure Formula
```
failChance(load) = 0              if load ≤ 0.5
                 = 2 × (load - 0.5)  if load > 0.5
```

---

## 1. Sustainability Threshold Analysis

### Question: At what RPS does minimal architecture become overloaded?

**Minimal Architecture:** WAF → ALB → Compute (T1) → S3/DB

#### Throughput Calculations

**Compute Node (T1):**
- Capacity: 4 concurrent requests
- Processing time: 600ms
- Max throughput: `4 / 0.6s = 6.67 req/s`
- But only 80% of traffic is legitimate: effective capacity for legitimate = `6.67 × 0.8 = 5.33 req/s`

**Database (T1):**
- Capacity: 8 concurrent requests
- Processing time: 300ms
- Max throughput: `8 / 0.3s = 26.67 req/s`
- DB handles 45% of traffic: can handle up to `26.67 / 0.45 = 59.3 RPS` total

**S3:**
- Capacity: 100 concurrent requests
- Processing time: 200ms
- Max throughput: `100 / 0.2s = 500 req/s`
- S3 handles 35% of traffic: can handle up to `500 / 0.35 = 1428 RPS` total

**WAF:**
- Capacity: 100, Processing time: 20ms
- Max throughput: `100 / 0.02s = 5000 req/s` (not a bottleneck)

**ALB:**
- Capacity: 50, Processing time: 50ms
- Max throughput: `50 / 0.05s = 1000 req/s` (not a bottleneck)

### Bottleneck Analysis

**The Compute node is the primary bottleneck at 6.67 req/s theoretical max.**

However, the failure formula kicks in at 50% load:
- At 50% load (3.33 req/s), failure chance = 0%
- At 75% load (5 req/s), failure chance = 50%
- At 100% load (6.67 req/s), failure chance = 100%

**Safe operating RPS for single Compute T1:** ~3.3 req/s (50% capacity)
**Marginal operating RPS:** ~4-5 req/s (increasing failures)

### Time to Reach Critical RPS

Using the RPS formula: `RPS = 0.6 + ln(1 + t/30) × 1.8`

| RPS | Time | Status |
|-----|------|--------|
| 1.0 | 0:07 | Safe |
| 2.0 | 0:32 | Safe |
| 3.0 | 1:22 | Safe |
| 3.3 | 1:41 | 50% load (failure starts) |
| 4.0 | 3:04 | ~25% failure rate |
| 5.0 | 6:26 | ~50% failure rate |
| 6.0 | 12:55 | ~75% failure rate |

**Conclusion:** With minimal infrastructure, the system becomes unsustainable around **3-4 RPS** (reached at ~2-3 minutes). Players MUST expand before this point.

---

## 2. Economic Viability Analysis

### Question: What's the minimum infrastructure to become cash-flow positive?

#### Income Calculation

**Average reward per legitimate request:**
```
Avg Reward = (0.30 × $0.80) + (0.20 × $1.20) + (0.15 × $1.80) + (0.05 × $2.00) + (0.10 × $1.20)
           = $0.24 + $0.24 + $0.27 + $0.10 + $0.12
           = $0.97 per legitimate request
```

Since 80% of traffic is legitimate:
**Expected income = RPS × 0.8 × $0.97 = RPS × $0.776/s**

#### Minimum Viable Architecture Cost

**Essential services:**
- WAF: $40 (to block malicious traffic)
- Compute T1: $60 (to process requests)
- S3: $25 (for STATIC/UPLOAD - 35% of traffic)
- DB T1: $150 (for READ/WRITE/SEARCH - 45% of traffic)

**Total minimum cost:** $275
**Starting budget:** $340
**Remaining:** $65

**Minimum upkeep (at game start, 1.0× multiplier):**
```
WAF: $4/min + Compute: $12/min + S3: $5/min + DB: $24/min = $45/min = $0.75/s
```

#### Break-even Analysis

**Break-even RPS (at 1.0× upkeep):**
```
Income = Upkeep
RPS × $0.776/s = $0.75/s
RPS = 0.97 req/s
```

At game start (0.6 RPS):
- Income: $0.466/s
- Upkeep: $0.75/s
- **Net: -$0.284/s (losing money!)**

Time to reach break-even (0.97 RPS):
- Approximately **5-6 seconds** into the game

#### With Upkeep Scaling

At 10 minutes (2.0× multiplier):
- Upkeep: $1.50/s
- Break-even RPS: 1.93 req/s
- Actual RPS at 10 min: ~6.5 req/s
- Income at 6.5 RPS: $5.04/s
- **Net at 10 min: +$3.54/s (profitable!)**

### Cash Flow Projection (Minimum Architecture)

| Time | RPS | Income/s | Upkeep/s | Net/s | Cumulative |
|------|-----|----------|----------|-------|------------|
| 0:00 | 0.6 | $0.47 | $0.75 | -$0.28 | $65 |
| 0:30 | 1.8 | $1.40 | $0.79 | +$0.61 | $57 |
| 1:00 | 2.4 | $1.86 | $0.83 | +$1.03 | $74 |
| 2:00 | 3.3 | $2.56 | $0.90 | +$1.66 | $153 |
| 3:00 | 4.0 | $3.10 | $0.98 | +$2.12 | $267 |
| 5:00 | 4.9 | $3.80 | $1.13 | +$2.67 | $493 |

**Conclusion:** The game IS economically viable. After the first ~30 seconds, income exceeds upkeep. However, this doesn't account for the need to EXPAND infrastructure to handle increasing RPS.

### Expansion Budget Requirements

When RPS hits 3.3 (at ~1:41), a second Compute is needed:
- Cost: $60
- By 1:41, approximate funds: ~$100-120
- **Affordable? YES**

When RPS hits 6.67 (theoretical 2× compute capacity), third Compute or upgrade needed:
- Compute T2 upgrade: $100 (better value)
- By ~6 minutes, approximate funds: ~$400+
- **Affordable? YES**

---

## 3. Optimal Ratios Analysis

### Question: What is the correct ratio of EC2:S3:RDS?

#### Traffic Load Distribution

Per 100 requests:
- **S3 bound:** 30 STATIC + 5 UPLOAD = 35 requests
- **DB bound:** 20 READ + 15 WRITE + 10 SEARCH = 45 requests
- **WAF blocked:** 20 MALICIOUS

#### Processing Weight Analysis

Weighted load (using processingWeight):
- S3: (30 × 0.5) + (5 × 2.0) = 15 + 10 = 25 weighted units
- DB: (20 × 1.0) + (15 × 1.5) + (10 × 2.5) = 20 + 22.5 + 25 = 67.5 weighted units

**DB receives 2.7× more weighted load than S3**

#### Throughput Requirements at Various RPS

| RPS | S3 req/s | DB req/s | Compute req/s |
|-----|----------|----------|---------------|
| 3 | 1.05 | 1.35 | 2.4 |
| 5 | 1.75 | 2.25 | 4.0 |
| 7 | 2.45 | 3.15 | 5.6 |
| 10 | 3.50 | 4.50 | 8.0 |

#### Capacity Analysis

**S3 (single node):**
- Max: 500 req/s (S3-bound only)
- Can handle: 500 / 0.35 = 1428 total RPS
- **One S3 is sufficient for any realistic RPS**

**DB T1 (single node):**
- Max: 26.67 req/s (DB-bound only)
- Can handle: 26.67 / 0.45 = 59 total RPS
- At 7 RPS (3.15 DB req/s): ~12% utilization
- **One DB T1 is sufficient until very high RPS**

**Compute T1:**
- Max: 6.67 req/s
- At 3.3 RPS: 50% load (safe max)
- **Need to scale Compute most frequently**

### Optimal Ratio Recommendation

For RPS 0-3.3: **1 Compute : 1 S3 : 1 DB** (minimum viable)
For RPS 3.3-6.7: **2 Compute : 1 S3 : 1 DB**
For RPS 6.7-10: **3 Compute : 1 S3 : 1 DB** or **1 Compute T2 + 1 T1 : 1 S3 : 1 DB**
For RPS 10+: **2 Compute T2 : 1 S3 : 1 DB** or upgrade DB

**The intuition of 2:1:1 is correct for mid-game (3-7 RPS).**

---

## 4. Upgrade Timing Analysis

### Question: When to upgrade vs. buy new?

#### Compute: Upgrade vs. New Node

| Option | Cost | Total Capacity | Cost per Capacity |
|--------|------|----------------|-------------------|
| 2× Compute T1 | $120 | 8 | $15/slot |
| 1× Compute T2 | $160 | 10 | $16/slot |
| 3× Compute T1 | $180 | 12 | $15/slot |
| 1× Compute T3 | $320 | 18 | $17.78/slot |
| 1× T2 + 1× T1 | $220 | 14 | $15.71/slot |

**Upkeep Consideration:**
- 2× Compute T1: $24/min
- 1× Compute T2: $12/min (SAME as T1!)

**Recommendation:**
- **Upgrade to T2 is MORE COST-EFFECTIVE** because:
  1. Same upkeep as T1 ($12/min)
  2. Better capacity per dollar when considering upkeep savings
  3. Saves a slot for ALB connections

**Optimal Path:** T1 → T2 ($100) → T3 ($160) = $320 total for 18 capacity
**Alternative:** 4× T1 = $240 for 16 capacity BUT $48/min upkeep vs $12/min

**Upgrade T2 when:** You have $100+ and need to go beyond 3.3 RPS
**Upgrade T3 when:** You have $160+ and need to go beyond 6.7 RPS

#### Database: Upgrade vs. New Node

| Option | Cost | Total Capacity | Upkeep |
|--------|------|----------------|--------|
| 2× DB T1 | $300 | 16 | $48/min |
| 1× DB T2 | $350 | 20 | $24/min |
| 1× DB T3 | $700 | 35 | $24/min |

**Recommendation:**
- **Always upgrade DB** - upkeep savings are massive
- A second DB doubles your upkeep; an upgrade doesn't

---

## 5. Failure Cascade Analysis

### Question: At what load does a node become useless?

#### Failure Rate Analysis

```
Load    | Fail Chance | Success Rate | Effective Throughput
--------|-------------|--------------|---------------------
0-50%   | 0%          | 100%         | 100% of processed
60%     | 20%         | 80%          | 80% of processed
70%     | 40%         | 60%          | 60% of processed
80%     | 60%         | 40%          | 40% of processed
90%     | 80%         | 20%          | 20% of processed
100%    | 100%        | 0%           | 0% of processed
```

#### Effective Capacity Curve

The effective throughput (actual successful requests) peaks at around **66% load**:

```
Effective = Load × (1 - FailChance)
          = Load × (1 - 2×(Load - 0.5))    for Load > 0.5
          = Load × (2 - 2×Load)
          = 2×Load - 2×Load²

d(Effective)/d(Load) = 2 - 4×Load = 0
Load = 0.5 → Maximum effective throughput at 50% load
```

**Wait - this means operating at exactly 50% is optimal!**

At 50% load:
- Effective throughput = 50% capacity × 100% success = **50% of max**

At 75% load:
- Effective throughput = 75% capacity × 50% success = **37.5% of max**

At 100% load:
- Effective throughput = 100% capacity × 0% success = **0% of max**

### Critical Finding: The 50% Threshold

**The current failure formula is VERY punishing:**
- Operating above 50% load is mathematically inefficient
- A node at 75% load performs WORSE than a node at 50% load
- Nodes become "effectively useless" above ~70-75% load

### Is This Too Punishing?

**Arguments for current system:**
- Forces players to plan ahead
- Creates tension and challenge
- Rewards proactive scaling

**Arguments against:**
- 50% threshold means you only use half your capacity safely
- Steep curve is unforgiving
- Players may feel infrastructure is "wasted"

**Suggested Alternative (softer curve):**
```javascript
// Current: Linear from 50%
failChance = 2 × (load - 0.5)  // 50% at 75%, 100% at 100%

// Alternative: Exponential from 60%
failChance = Math.pow((load - 0.6) / 0.4, 2)  // Gentler, starts at 60%

// Alternative: Logarithmic 
failChance = load > 0.7 ? Math.log(1 + (load-0.7)*10) / 3 : 0
```

---

## Recommendations

### Parameter Changes

1. **Failure Threshold (Medium Priority)**
   - Current: Starts at 50% load
   - Suggested: Start at 60% load
   - Rationale: Allows better utilization of purchased capacity

2. **RPS Growth Rate (High Priority)**
   - Current: Logarithmic (`ln(1 + t/30) × 1.8`)
   - Issue: Too slow for experienced players (14.7 RPS overnight)
   - Suggested: Add difficulty modes
     - Easy: Current formula
     - Normal: `ln(1 + t/20) × 2.2`
     - Hard: Linear or exponential growth

3. **Starting Budget (OK)**
   - Current: $340
   - Analysis: Adequate for minimum viable architecture ($275) with $65 buffer
   - No change needed

4. **Upkeep Scaling (OK)**
   - Current: 1.0× to 2.0× over 10 minutes
   - Analysis: Creates meaningful late-game pressure
   - No change needed

### Answer Summary

| Question | Answer |
|----------|--------|
| 1. Sustainability Threshold | ~3.3 RPS for single Compute T1 (reached at ~1:41) |
| 2. Economic Viability | YES - cash-flow positive after ~30 seconds |
| 3. Optimal Ratios | 2:1:1 (Compute:S3:DB) for mid-game; Compute scales first |
| 4. Upgrade Timing | Always upgrade (especially DB) - upkeep savings are massive |
| 5. Failure Cascade | Nodes become ineffective above 50% load; this IS punishing |

### Is the Game Beatable?

**YES** - with proper play:
1. Build WAF → Compute → S3 → DB immediately
2. Upgrade Compute to T2 around 2-3 minutes
3. Keep Compute below 50% load
4. Upgrade DB only when needed (it's expensive but scales well)
5. The game becomes a "solved" steady state after ~15-20 minutes if infrastructure keeps pace

### Is Death Inevitable?

**NO** - but growth slows dramatically:
- At 10 minutes: ~6.5 RPS
- At 30 minutes: ~9 RPS  
- At 1 hour: ~11 RPS
- At overnight (8h): ~15 RPS

With proper infrastructure (3× Compute T3 or 6× T2, 1× DB T2), this is sustainable indefinitely.

---

## Appendix: RPS Milestone Table

| RPS | Time (MM:SS) | Compute Needed | Notes |
|-----|--------------|----------------|-------|
| 1.0 | 00:07 | 1× T1 | Safe |
| 2.0 | 00:32 | 1× T1 | Safe |
| 3.0 | 01:22 | 1× T1 | Near limit |
| 3.3 | 01:41 | 2× T1 or T2 | Scale NOW |
| 4.0 | 03:04 | 2× T1 or T2 | |
| 5.0 | 06:26 | 2× T1 or T2 | |
| 6.0 | 12:55 | 3× T1 or T2+T1 | |
| 6.7 | 17:00 | T3 or 2× T2 | |
| 7.0 | 25:19 | T3 or 2× T2 | |
| 8.0 | 49:10 | T3+T1 or 2× T2 | |
| 10.0 | 3:05:32 | 2× T3 or 3× T2 | Late game |

---

*Document created for Issue #17 - Calculate game balance mathematical model*
