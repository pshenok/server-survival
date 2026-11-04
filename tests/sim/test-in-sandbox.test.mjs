// "Test in Sandbox" (#89 item 1): try the current build under other traffic
// without giving up the run. It opens the build in a new tab through the same
// ?arch= link and the same input gate as a shared one, and leaves this tab's
// run where it was, paused.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { STATE } from "../../src/state.js";
import { resetGame } from "../../game.js";
import { createConnection, createService } from "../../src/sim/topology.js";
import { i18n } from "../../src/i18n.js";
import {
    buildShareUrl,
    decodeArchParam,
    showShareModal,
    testInSandbox,
} from "../../src/ui/share.js";

const T = globalThis.THREE;
const modal = () => document.getElementById("share-modal");
const button = () => document.getElementById("btn-share-sandbox");
const status = () => document.getElementById("share-status").textContent;

function place(type, x, z = 0) {
    createService(type, new T.Vector3(x, 0, z));
    return STATE.services[STATE.services.length - 1];
}

const openedArch = (open) => decodeArchParam(open.mock.calls[0][0].split("?arch=")[1]);

let open;

beforeEach(() => {
    resetGame("survival");
    STATE.isRunning = true;
    STATE.money = 100000;
    open = vi.fn(() => ({}));
    vi.stubGlobal("open", open);
    window.open = open;
    i18n.setLocale("en");
});

afterEach(() => {
    vi.unstubAllGlobals();
    modal().classList.add("hidden");
    if (STATE.animationId) {
        globalThis.cancelAnimationFrame(STATE.animationId);
        STATE.animationId = null;
    }
});

describe("opening the build", () => {
    it("opens it in a new tab, upgrades and links included", () => {
        const lb = place("alb", -8);
        const compute = place("compute", 8);
        createConnection("internet", lb.id);
        createConnection(lb.id, compute.id);
        compute.upgrade();
        compute.upgrade();

        testInSandbox();

        expect(open).toHaveBeenCalledTimes(1);
        expect(open.mock.calls[0][1]).toBe("_blank");
        const arch = openedArch(open);
        expect(arch.services.map((s) => s.type)).toEqual(["alb", "compute"]);
        expect(arch.services[1].tier).toBe(3);
        expect(arch.internet).toEqual([0]);
        expect(arch.connections).toEqual([[0, 1]]);
    });

    it("leaves this run as it was, paused, and closes the dialog", () => {
        place("alb", -8);
        STATE.timeScale = 3;
        showShareModal();
        const money = STATE.money;

        testInSandbox();

        expect(STATE.timeScale).toBe(0);
        expect(STATE.gameMode).toBe("survival");
        expect(STATE.services.length).toBe(1);
        expect(STATE.money).toBe(money);
        expect(modal().classList.contains("hidden")).toBe(true);
    });

    it("a build too long to share still opens: this link never leaves the browser", () => {
        for (let i = 0; i < 58; i++) place("compute", (i % 15) * 12.25 - 80, Math.floor(i / 15) * 12.25 - 20);
        const db = place("db", 0, 80);
        STATE.services.slice(0, 58).forEach((s) => createConnection(s.id, db.id));
        expect(buildShareUrl(), "this build must be over the share limit").toBeNull();

        testInSandbox();

        expect(open).toHaveBeenCalledTimes(1);
        expect(openedArch(open).services).toHaveLength(59);
    });
});

describe("when it cannot open", () => {
    it("a build the new tab would reject says so and stays here", () => {
        for (let i = 0; i < 61; i++) place("waf", (i % 15) * 4 - 28, Math.floor(i / 15) * 4 - 20);
        STATE.timeScale = 1;
        showShareModal();

        testInSandbox();

        expect(open).not.toHaveBeenCalled();
        expect(status()).toBe(i18n.t("share_too_large"));
        expect(STATE.timeScale).toBe(1);
        expect(modal().classList.contains("hidden")).toBe(false);
    });

    it("a blocked tab says so, and the run keeps going", () => {
        place("alb", -8);
        open.mockReturnValue(null);
        STATE.timeScale = 1;
        showShareModal();

        testInSandbox();

        expect(status()).toBe(i18n.t("share_tab_blocked"));
        expect(STATE.timeScale).toBe(1);
        expect(modal().classList.contains("hidden")).toBe(false);
    });
});

describe("the button", () => {
    it.each(["survival", "campaign"])("is offered in %s", (mode) => {
        resetGame(mode);
        showShareModal();

        expect(button().classList.contains("hidden")).toBe(false);
    });

    it("is not offered in the sandbox, which is where it leads", () => {
        resetGame("sandbox");
        showShareModal();

        expect(button().classList.contains("hidden")).toBe(true);
    });

    it("comes back after a sandbox run", () => {
        resetGame("sandbox");
        showShareModal();
        resetGame("survival");
        showShareModal();

        expect(button().classList.contains("hidden")).toBe(false);
    });

    it("is labelled and runs the feature", () => {
        expect(button().getAttribute("data-i18n")).toBe("share_test_sandbox");
        expect(button().getAttribute("onclick")).toBe("testInSandbox()");
        expect(typeof window.testInSandbox).toBe("function");
    });

    it("a long status wraps instead of running under the buttons", () => {
        showShareModal();
        expect(document.getElementById("share-status").className).not.toMatch(/\bh-5\b/);
    });
});

describe("two tabs do not play music over each other", () => {
    const setHidden = (hidden) => {
        Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
        document.dispatchEvent(new globalThis.Event("visibilitychange"));
    };
    let bgm, saved;

    beforeEach(() => {
        saved = { bgm: STATE.sound.currentBgm, muted: STATE.sound.musicMuted };
        bgm = { pause: vi.fn(), play: vi.fn(() => Promise.resolve()) };
        STATE.sound.currentBgm = bgm;
    });

    afterEach(() => {
        delete document.hidden;
        STATE.sound.currentBgm = saved.bgm;
        STATE.sound.musicMuted = saved.muted;
    });

    it("music stops while the tab is hidden and comes back with it", () => {
        STATE.sound.musicMuted = false;

        setHidden(true);
        expect(bgm.pause).toHaveBeenCalledTimes(1);

        setHidden(false);
        expect(bgm.play).toHaveBeenCalledTimes(1);
    });

    it("coming back does not start music the player has muted", () => {
        STATE.sound.musicMuted = true;

        setHidden(true);
        setHidden(false);

        expect(bgm.play).not.toHaveBeenCalled();
    });
});

describe("the strings exist in every locale", () => {
    it.each(["en", "de", "fr", "hi", "it", "ko", "nep", "pt-BR", "ru", "uk", "zh"])("%s", (locale) => {
        i18n.setLocale(locale);

        for (const key of ["share_test_sandbox", "share_tab_blocked"]) {
            expect(i18n.t(key)).not.toBe(key);
        }
    });
});
