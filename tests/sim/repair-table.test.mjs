// The repair table names every service in full.
//
// Names were cut to ten characters to fit three equal columns. That cut 17 of
// the 26 English names, so a player with a damaged Load Balancer read "LOAD
// BALAN", and in French and Portuguese it left different services reading the
// same: "Passerelle API" and "Passerelle d'inférence" were both "PASSERELLE".
// The name column now takes what the two number columns leave and wraps when
// that is not enough. happy-dom has no layout, so the widths were measured in a
// browser and only the CSS contract is pinned here.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resetGame } from "../../game.js";
import { i18n } from "../../src/i18n.js";
import { updateRepairCostTable } from "../../src/core/economy.js";
import { CONFIG, STATE } from "../helpers/sim-world.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const css = readFileSync(resolve(root, "style.css"), "utf8");

const rows = () => [...document.querySelectorAll("#repair-cost-rows > div")];

function render(types) {
    STATE.services = types.map((type) => ({
        id: type,
        type,
        health: 100,
        config: CONFIG.services[type],
    }));
    updateRepairCostTable();
}

beforeEach(() => {
    i18n.setLocale("en");
    resetGame("survival");
});

afterEach(() => {
    STATE.services = [];
    i18n.setLocale("en");
    if (STATE.animationId) {
        globalThis.cancelAnimationFrame(STATE.animationId);
        STATE.animationId = null;
    }
});

describe("the repair table names every service in full", () => {
    it.each(["en", "de", "fr", "ru"])("in %s", (locale) => {
        i18n.setLocale(locale);
        const types = Object.keys(CONFIG.services);

        render(types);

        expect(rows().map((r) => r.firstElementChild.textContent)).toEqual(
            types.map((t) => i18n.t(t))
        );
    });

    it.each(["fr", "pt-BR"])("services sharing their first ten letters stay different in %s", (locale) => {
        i18n.setLocale(locale);
        const types = Object.keys(CONFIG.services);
        const cut = (t) => i18n.t(t).substring(0, 10).toUpperCase();
        const twins = types.filter(
            (t) => types.some((o) => cut(o) === cut(t) && i18n.t(o) !== i18n.t(t))
        );
        expect(twins.length, "this locale has names that collide when cut").toBeGreaterThan(0);

        render(twins);

        const shown = rows().map((r) => r.firstElementChild.textContent);
        expect(new Set(shown).size).toBe(new Set(twins.map((t) => i18n.t(t))).size);
    });
});

describe("the columns", () => {
    it("the header and every row share one grid, so they line up", () => {
        render(["alb", "db"]);

        const header = document.querySelector("#repair-cost-table > .repair-grid");
        expect(header, "header row").not.toBeNull();
        expect(header.children.length).toBe(3);
        for (const row of rows()) {
            expect(row.classList.contains("repair-grid")).toBe(true);
            expect(row.children.length).toBe(3);
        }
    });

    it("the name column takes the spare width and long words can break", () => {
        const rule = css.match(/\.repair-grid\s*\{[^}]*\}/)?.[0];
        expect(rule, ".repair-grid in style.css").toBeTruthy();
        expect(rule).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+\S+\s+\S+;/);
        expect(css).toMatch(/\.repair-grid\s*>\s*\*\s*\{[^}]*overflow-wrap:\s*anywhere/);
    });
});
