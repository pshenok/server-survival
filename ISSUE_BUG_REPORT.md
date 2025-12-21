# [Bug Report] 11 Critical/High Severity Bugs - Traffic Shifts, Random Events, Save/Load Broken

## Summary

I performed a comprehensive code audit and found **11 bugs**, including **5 critical game-breaking issues** that completely disable major game features.

## Environment
- **Version:** v2.1
- **Browser:** All browsers affected (logic bugs, not browser-specific)

---

## 🔴 Critical Bugs (Game-Breaking)

### Bug 1: Config Key Mismatch - `trafficShifts` vs `trafficShift`

**Files:** `src/config.js:247` vs `game.js:248,253,278`

**Issue:** Config defines `trafficShifts` (plural), but game code references `CONFIG.survival.trafficShift` (singular).

**Impact:** Traffic shift feature is completely broken - never activates.

```javascript
// src/config.js:247
trafficShifts: {  // <-- plural
    enabled: true,
    ...
}

// game.js:248
if (!CONFIG.survival.trafficShift?.enabled) return;  // <-- singular (undefined!)
```

---

### Bug 2: Array Name Mismatch - `patterns` vs `shifts`

**Files:** `src/config.js:252` vs `game.js:279`

**Issue:** Config uses `patterns` array, but code references `config.shifts`.

**Impact:** Crashes when traffic shift tries to start.

```javascript
// src/config.js:252
patterns: [  // <-- named "patterns"
    { name: "API Heavy", distribution: {...} },
]

// game.js:279
const shifts = config.shifts;  // <-- undefined!
```

---

### Bug 3: Missing `checkInterval` in Random Events Config

**Files:** `game.js:340` vs `src/config.js:301-335`

**Issue:** Code uses `config.checkInterval`, but config only defines `minInterval` and `maxInterval`.

**Impact:** Random events NEVER trigger.

```javascript
// game.js:340
if (STATE.intervention.randomEventTimer >= config.checkInterval) {
    // Never executes - checkInterval is undefined
}
```

---

### Bug 4: Missing `autoRepairRate` in Degradation Config

**Files:** `src/entities/Service.js:213,217` vs `src/config.js:236-244`

**Issue:** Code references `degradeConfig.autoRepairRate`, but it doesn't exist.

**Impact:** Idle auto-heal is completely broken.

---

### Bug 5: `internetConnections` Restore Bug

**Files:** `game.js:2887` vs `game.js:3090-3091`

**Issue:** Saves as array of IDs (strings), but restore tries to access `.from`/`.to`.

**Impact:** Loading saved games fails to restore internet connections.

```javascript
// Save (correct)
internetConnections: [...STATE.internetNode.connections]  // ["svc_abc", "svc_def"]

// Restore (BUG!)
internetConnections.forEach((connData) => {
    createConnection(connData.from, connData.to);  // connData is string, not object!
});
```

---

## 🟠 High Severity Bugs

### Bug 6: Memory Leak in `deleteObject()`

**File:** `game.js:1608`

Connection meshes removed but geometry/materials not disposed.

---

### Bug 7: Service Upgrades Not Tracked in Finances

**File:** `src/entities/Service.js:127-128`

Upgrade costs not tracked in `STATE.finances`.

---

### Bug 8: `loadGameState` Doesn't Restore Intervention State

**File:** `game.js:2949-3056`

After loading, intervention mechanics don't work.

---

## 🟡 Medium/Low Severity Bugs

### Bug 9: Inconsistent Repair Threshold
Click repair at `health < 80` but critical indicator at `40`.

### Bug 11: Audio Context State Not Checked
`playTone()` doesn't verify context is `running`.

---

## Reproduction Steps

1. Start a Survival game
2. Wait for "Traffic Shift" or "Random Event" - **they never trigger** (Bugs 1, 2, 3)
3. Let services sit idle when damaged - **they don't heal** (Bug 4)
4. Save game, then load it - **internet connections missing** (Bug 5)

## Suggested Priority

1. Fix Bugs 1, 2, 3 (enables major features)
2. Fix Bug 5 (enables save/load)
3. Fix remaining bugs

---

I have a PR ready with all fixes if you'd like to review it!

