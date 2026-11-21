// A dialog taller than the screen scrolls instead of being cut off.
//
// The main menu, Save and Share overlays centred their card with plain flex
// centring and no overflow, so a card taller than the screen was cut at both
// ends with no way to reach either. Measured in headless Chromium before the
// fix: at 1280x720 the main menu's title sat 54px above the top and its last
// button 54px below the bottom; on a phone held sideways (844x390) "Upload Game"
// and "Manual / FAQ" were out of reach, and Save and Share were cut too. The
// menu grew two buttons after v3.0.0 (Trophies, Replay tutorial).
//
// happy-dom has no layout, so the CSS contract is pinned here and the geometry
// was checked in a headless browser at five sizes.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const css = readFileSync(resolve(root, "style.css"), "utf8");
const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
};

describe("centred dialogs scroll when they do not fit", () => {
    it.each(["main-menu-modal", "save-modal", "share-modal"])("%s", (id) => {
        expect(document.getElementById(id).classList.contains("dialog-overlay")).toBe(true);
    });

    it("the overlay scrolls, and the card centres with auto margins, which give way at the top", () => {
        expect(rule(".dialog-overlay")).toMatch(/overflow-y:\s*auto/);
        expect(rule(".dialog-overlay > *")).toMatch(/margin:\s*auto/);
    });

    it("the debrief scrolls like the briefing does", () => {
        for (const id of ["campaign-briefing-modal", "campaign-debrief-modal"]) {
            expect(document.getElementById(id).classList.contains("overflow-y-auto"), id).toBe(true);
        }
    });

    it("no full-screen overlay centres a card without a way to scroll", () => {
        const overlays = [...document.querySelectorAll('[id$="-modal"]')].filter(
            (el) => el.classList.contains("inset-0") && el.classList.contains("items-center")
        );
        for (const el of overlays) {
            const scrolls = el.classList.contains("dialog-overlay") || el.classList.contains("overflow-y-auto");
            const inner = el.firstElementChild?.classList.contains("overflow-y-auto");
            expect(scrolls || inner, el.id).toBe(true);
        }
    });
});
