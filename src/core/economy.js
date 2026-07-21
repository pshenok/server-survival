// Economy & upkeep cluster (#155 PR 5): repair-cost/finances panels, the
// auto-repair toggle + healing tick, and its upkeep cost. Code moved
// verbatim from game.js.

import { CONFIG } from "../config.js";
import { STATE } from "../state.js";
import { i18n } from "../i18n.js";
import { addInterventionWarning } from "./events.js";

function updateRepairCostTable() {
    const table = document.getElementById("repair-cost-table");
    const rows = document.getElementById("repair-cost-rows");

    if (!table || !rows) return;

    if (STATE.services.length === 0) {
        table.classList.add("hidden");
        return;
    }

    table.classList.remove("hidden");

    const repairPercent = CONFIG.survival.degradation?.repairCostPercent || 0.15;
    const autoRepairPercent =
        CONFIG.survival.degradation?.autoRepairCostPercent || 0.1;

    rows.innerHTML = STATE.services
        .map((s) => {
            const repairCost = Math.ceil(s.config.cost * repairPercent);
            const autoRepairCost = (s.config.cost * autoRepairPercent).toFixed(1);
            const healthColor =
                s.health < 40
                    ? "text-red-400"
                    : s.health < 70
                        ? "text-yellow-400"
                        : "text-green-400";

            return `
            <div class="grid grid-cols-3 gap-1 text-gray-300">
                <span class="${healthColor}">${i18n.t(s.type).substring(0, 10).toUpperCase()}</span>
                <span class="text-center text-yellow-400">$${repairCost}</span>
                <span class="text-right text-orange-400" title="${i18n.t('repair_formula_hint', { cost: '$' + s.config.cost })}">$${autoRepairCost}</span>
            </div>
        `;
        })
        .join("");
}

function updateFinancesDisplay() {
    if (!STATE.finances) return;

    const f = STATE.finances;

    // Income by request type - labels, colors, and per-request rates
    const incomeTypes = [
        {
            key: "STATIC",
            label: i18n.t('income_static'),
            color: "text-blue-400",
            rate: CONFIG.trafficTypes.STATIC.reward,
        },
        {
            key: "READ",
            label: i18n.t('income_read'),
            color: "text-green-400",
            rate: CONFIG.trafficTypes.READ.reward,
        },
        {
            key: "WRITE",
            label: i18n.t('income_write'),
            color: "text-yellow-400",
            rate: CONFIG.trafficTypes.WRITE.reward,
        },
        {
            key: "UPLOAD",
            label: i18n.t('income_upload'),
            color: "text-purple-400",
            rate: CONFIG.trafficTypes.UPLOAD.reward,
        },
        {
            key: "SEARCH",
            label: i18n.t('income_search'),
            color: "text-cyan-400",
            rate: CONFIG.trafficTypes.SEARCH.reward,
        },
        { key: "blocked", label: i18n.t('income_blocked'), color: "text-red-400", rate: 0.5 },
    ];

    // Update income details with per-request rate and count
    const incomeDetails = document.getElementById("income-details");
    if (incomeDetails) {
        let incomeHtml =
            `<div class="grid grid-cols-4 gap-1 text-gray-500 mb-1 text-[10px]"><span>${i18n.t('type')}</span><span class="text-center">${i18n.t('count')}</span><span class="text-center">${i18n.t('per_request')}</span><span class="text-right">${i18n.t('total')}</span></div>`;
        let hasIncome = false;
        incomeTypes.forEach((t) => {
            const value = f.income.byType[t.key] || 0;
            const count = f.income.countByType[t.key] || 0;
            if (value > 0 || count > 0) {
                hasIncome = true;
                incomeHtml += `<div class="grid grid-cols-4 gap-1"><span class="${t.color
                    }">${t.label
                    }</span><span class="text-center text-gray-500">${count}</span><span class="text-center text-gray-400">$${t.rate.toFixed(
                        2
                    )}</span><span class="text-right text-gray-300">$${Math.floor(
                        value
                    )}</span></div>`;
            }
        });
        if (!hasIncome) {
            incomeHtml = `<div class="text-gray-600 italic">${i18n.t('no_income')}</div>`;
        }
        incomeDetails.innerHTML = incomeHtml;
    }

    // Update income total
    const incomeTotal = document.getElementById("income-total");
    if (incomeTotal)
        incomeTotal.textContent = `$${Math.floor(f.income.total || 0)}`;

    // Expense categories - services with costs
    const serviceTypes = [
        {
            key: "waf",
            label: i18n.t('firewall'),
            color: "text-red-400",
            cost: CONFIG.services.waf.cost,
        },
        {
            key: "alb",
            label: i18n.t('load_balancer'),
            color: "text-blue-400",
            cost: CONFIG.services.alb.cost,
        },
        {
            key: "compute",
            label: i18n.t('compute'),
            color: "text-green-400",
            cost: CONFIG.services.compute.cost,
        },
        {
            key: "db",
            label: i18n.t('relational_db'),
            color: "text-yellow-400",
            cost: CONFIG.services.db.cost,
        },
        {
            key: "s3",
            label: i18n.t('file_storage'),
            color: "text-purple-400",
            cost: CONFIG.services.s3.cost,
        },
        {
            key: "cache",
            label: i18n.t('memory_cache'),
            color: "text-orange-400",
            cost: CONFIG.services.cache.cost,
        },
        {
            key: "sqs",
            label: i18n.t('message_queue'),
            color: "text-cyan-400",
            cost: CONFIG.services.sqs.cost,
        },
        {
            key: "search",
            label: i18n.t('search_engine'),
            color: "text-cyan-400",
            cost: CONFIG.services.search.cost,
        },
        {
            key: "replica",
            label: i18n.t('read_replica'),
            color: "text-pink-400",
            cost: CONFIG.services.replica.cost,
        },
        {
            key: "serverless",
            label: i18n.t('serverless'),
            color: "text-amber-400",
            cost: CONFIG.services.serverless.cost,
        },
        {
            key: "apigw",
            label: i18n.t('apigw'),
            color: "text-fuchsia-400",
            cost: CONFIG.services.apigw.cost,
        },
        {
            key: "nosql",
            label: i18n.t('nosql'),
            color: "text-violet-400",
            cost: CONFIG.services.nosql.cost,
        },
        {
            key: "cdn",
            label: i18n.t('cdn'),
            color: "text-green-400",
            cost: CONFIG.services.cdn.cost,
        },
    ];

    const repairPercent = CONFIG.survival.degradation?.repairCostPercent || 0.15;

    // Update expense details with service cost, repair cost and count
    const expenseDetails = document.getElementById("expense-details");
    if (expenseDetails) {
        let expenseHtml = "";

        // Breakdown by service type (includes purchase + upkeep + repairs)
        let hasServiceExpenses = false;
        serviceTypes.forEach((t) => {
            const value = f.expenses.byService[t.key] || 0;
            const count = f.expenses.countByService[t.key] || 0;
            const repairCost = Math.ceil(t.cost * repairPercent);
            if (value > 0 || count > 0) {
                hasServiceExpenses = true;
                expenseHtml += `<div class="grid grid-cols-5 gap-1"><span class="${t.color
                    }">${t.label
                    }</span><span class="text-center text-gray-500">${count}</span><span class="text-center text-gray-400">$${t.cost
                    }</span><span class="text-center text-yellow-400">$${repairCost}</span><span class="text-right text-gray-300">$${Math.floor(
                        value
                    )}</span></div>`;
            }
        });

        // Add header if we have service expenses
        if (hasServiceExpenses) {
            expenseHtml =
                `<div class="grid grid-cols-5 gap-1 text-gray-500 mb-1 text-[10px]"><span>${i18n.t('service')}</span><span class="text-center">#</span><span class="text-center">${i18n.t('buy_cost')}</span><span class="text-center">${i18n.t('repair')}</span><span class="text-right">${i18n.t('total')}</span></div>` +
                expenseHtml;
        }

        // Auto-repair overhead (if enabled)
        if (f.expenses.autoRepair > 0) {
            expenseHtml += `<div class="flex justify-between mt-1 pt-1 border-t border-gray-700"><span class="text-orange-400">${i18n.t('auto_repair')}</span><span class="text-gray-300">$${Math.floor(
                f.expenses.autoRepair
            )}</span></div>`;
        }

        // Mitigation costs
        if (f.expenses.mitigation > 0) {
            expenseHtml += `<div class="flex justify-between mt-1 border-t border-gray-800"><span class="text-blue-300">DDoS Mitigation</span><span class="text-red-300">-$${Math.floor(
                f.expenses.mitigation
            )}</span></div>`;
        }

        // Breach penalties
        if (f.expenses.breach > 0) {
            expenseHtml += `<div class="flex justify-between"><span class="text-red-500 font-bold">Security Breach</span><span class="text-red-500 font-bold">-$${Math.floor(
                f.expenses.breach
            )}</span></div>`;
        }

        if (!expenseHtml) {
            expenseHtml = `<div class="text-gray-600 italic">${i18n.t('no_expenses')}</div>`;
        }
        expenseDetails.innerHTML = expenseHtml;
    }

    // Calculate totals
    const totalExpenses =
        f.expenses.services +
        f.expenses.upkeep +
        f.expenses.repairs +
        f.expenses.autoRepair +
        (f.expenses.mitigation || 0) +
        (f.expenses.breach || 0);
    const expenseTotal = document.getElementById("expense-total");
    if (expenseTotal) expenseTotal.textContent = `$${Math.floor(totalExpenses)}`;

    // Update net profit
    const totalIncome = f.income.total;
    const netProfit = totalIncome - totalExpenses;
    const netProfitEl = document.getElementById("net-profit");
    if (netProfitEl) {
        netProfitEl.textContent = `${netProfit >= 0 ? "+" : ""}$${Math.floor(
            netProfit
        )}`;
        netProfitEl.className = `text-right font-bold ${netProfit >= 0 ? "text-green-400" : "text-red-400"
            }`;
    }
}

function toggleAutoRepair() {
    STATE.autoRepairEnabled = !STATE.autoRepairEnabled;
    const btn = document.getElementById("auto-repair-toggle");
    if (btn) {
        if (STATE.autoRepairEnabled) {
            btn.textContent = i18n.t('upkeep_on');
            btn.classList.remove("text-gray-400");
            btn.classList.add("text-green-400");
            addInterventionWarning(i18n.t('auto_repair_hint'), "info", 2000);
        } else {
            btn.textContent = i18n.t('upkeep_off');
            btn.classList.remove("text-green-400");
            btn.classList.add("text-gray-400");
            addInterventionWarning(i18n.t('event_ended'), "info", 2000);
        }
    }
    updateRepairCostTable();
}

function processAutoRepair(dt) {
    if (!STATE.autoRepairEnabled || STATE.gameMode !== "survival") return;

    const config = CONFIG.survival.degradation;
    if (!config?.enabled) return;

    STATE.services.forEach((service) => {
        if (service.health < 100) {
            // Gradually heal - 5 health per second when auto-repair is on
            service.health = Math.min(100, service.health + 5 * dt);
            service.updateHealthVisual();
        }
    });
}

function getAutoRepairUpkeep() {
    if (!STATE.autoRepairEnabled) return 0;

    const percent = CONFIG.survival.degradation?.autoRepairCostPercent || 0.1;
    // 10% of total service cost per second
    const totalServiceCost = STATE.services.reduce(
        (sum, s) => sum + s.config.cost,
        0
    );
    return (totalServiceCost * percent) / 60; // Per second
}

export {
    getAutoRepairUpkeep,
    processAutoRepair,
    toggleAutoRepair,
    updateFinancesDisplay,
    updateRepairCostTable,
};
