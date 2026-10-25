import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

test("Studio selects preserve form behavior and work inside dialogs", { timeout: 30000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const [source, styles] = await Promise.all([
    readFile(new URL("../apps/web/selects.js", import.meta.url), "utf8"),
    readFile(new URL("../apps/web/styles.css", import.meta.url), "utf8"),
  ]);
  await page.route("http://studio.test/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/selects.js") return route.fulfill({ contentType: "text/javascript", body: source });
    if (path === "/styles.css") return route.fulfill({ contentType: "text/css", body: styles });
    await route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><link rel="stylesheet" href="/styles.css"><title>Select controls</title><body>
      <button id="open">Open dialog</button><button id="refresh">Refresh options</button>
      <dialog id="dialog"><form id="fixture" style="padding:24px">
        <div class="field"><label for="provider">Provider</label><select id="provider" name="provider"><option value="codex">Codex / OpenAI</option><option value="claude">Claude Code / Anthropic</option></select></div>
        <div class="field"><label for="model">Model</label><select id="model" name="model"><option value="default">Default</option><option disabled value="disabled">Unavailable</option><option value="opus">Opus</option><option value="sonnet">Sonnet</option></select></div>
        <div class="field"><label for="locked">Unavailable connection</label><select id="locked" disabled><option>Connect first</option></select></div>
        <label class="check"><input name="tools" value="read" type="checkbox" checked>Read files</label>
        <button type="submit">Save</button><button type="button" id="outside">Outside menu</button>
        <output id="saved"></output><output id="changes">0</output>
      </form></dialog>
      <script type="module">
        import { enhanceSelects, closeSelects } from "/selects.js";
        enhanceSelects(document);
        document.querySelector("#open").onclick = () => document.querySelector("#dialog").showModal();
        document.querySelector("#fixture").onsubmit = event => { event.preventDefault(); document.querySelector("#saved").textContent = JSON.stringify(Object.fromEntries(new FormData(event.target))); };
        document.querySelector("#fixture").onchange = () => { const count = document.querySelector("#changes"); count.textContent = Number(count.textContent) + 1; };
        document.querySelector("#refresh").onclick = () => {
          closeSelects();
          document.querySelector("#model").innerHTML = '<option value="new">A newly reported model</option><option value="saved" selected>A saved model</option>';
          enhanceSelects(document);
        };
      </script></body></html>` });
  });
  await page.goto("http://studio.test/");
  await page.getByRole("button", { name: "Open dialog" }).click();
  const provider = page.getByRole("combobox", { name: "Provider", exact: true });
  const model = page.getByRole("combobox", { name: "Model", exact: true });

  await t.test("The trigger toggles its menu and opening another closes the previous one", async () => {
    await provider.click();
    await expect(provider).toHaveAttribute("aria-expanded", "true");
    await provider.click();
    await expect(provider).toHaveAttribute("aria-expanded", "false");
    await provider.click();
    await model.focus();
    await model.press("Enter");
    await expect(provider).toHaveAttribute("aria-expanded", "false");
    await expect(model).toHaveAttribute("aria-expanded", "true");
    await model.press("Escape");
  });

  await t.test("Pointer selection submits the original value and emits one change", async () => {
    await page.getByText("Provider", { exact: true }).click();
    await expect(provider).toBeFocused();
    await expect(page.getByRole("listbox", { name: "Provider" })).toBeVisible();
    await page.getByRole("option", { name: "Claude Code / Anthropic" }).click();
    await expect(provider).toHaveText("Claude Code / Anthropic");
    await expect(provider).toBeFocused();
    await expect(provider).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    assert.deepEqual(JSON.parse(await page.locator("#saved").innerText()), { provider: "claude", model: "default", tools: "read" });
    await expect(page.locator("#changes")).toHaveText("1");
  });

  await t.test("Keyboard selection skips disabled options and Escape preserves the dialog", async () => {
    await model.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowDown");
    await expect(model).toHaveAttribute("aria-activedescendant", "model-option-2");
    await page.keyboard.press("Escape");
    await expect(model).toHaveText("Default");
    await expect(page.locator("#dialog")).toBeVisible();
    await page.keyboard.press("Enter");
    await page.keyboard.press("s");
    await page.keyboard.press("Enter");
    await expect(model).toHaveText("Sonnet");
    await model.press("ArrowDown");
    await model.press("Home");
    await model.press("End");
    await model.press("ArrowUp");
    await model.press("Tab");
    await expect(model).toHaveText("Opus");
    await expect(page.getByLabel("Read files")).toBeFocused();
  });

  await t.test("Outside clicks dismiss the menu without choosing an option", async () => {
    await provider.click();
    await provider.press("Home");
    await page.getByRole("button", { name: "Outside menu" }).click();
    await expect(provider).toHaveAttribute("aria-expanded", "false");
    await expect(provider).toHaveText("Claude Code / Anthropic");
    await expect(page.getByRole("combobox", { name: "Unavailable connection" })).toBeDisabled();
  });

  await t.test("Updated options retain their selected value without duplicate controls", async () => {
    await page.locator("#dialog").evaluate((dialog: HTMLDialogElement) => dialog.close());
    await page.getByRole("button", { name: "Refresh options" }).click();
    await page.getByRole("button", { name: "Open dialog" }).click();
    await expect(page.getByRole("combobox")).toHaveCount(3);
    await expect(model).toHaveText("A saved model");
    await model.click();
    await expect(page.getByRole("option")).toHaveCount(2);
    await page.getByRole("option", { name: "A newly reported model" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    assert.equal(JSON.parse(await page.locator("#saved").innerText()).model, "new");
  });

  await t.test("Menus stay above clipped containers and inside narrow viewports", async () => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.locator("#dialog").evaluate((dialog: HTMLElement) => { dialog.style.overflow = "hidden"; });
    await model.click();
    const menu = page.getByRole("listbox", { name: "Model", exact: true });
    const bounds = await menu.boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 360 && bounds.y >= 0 && bounds.y + bounds.height <= 640);
    await page.getByRole("option", { name: "A saved model" }).click();
    await expect(model).toHaveText("A saved model");
    await model.evaluate((button: HTMLElement) => { button.style.position = "fixed"; button.style.bottom = "12px"; button.style.left = "20px"; button.style.width = "280px"; });
    await model.click();
    const above = await menu.boundingBox(), trigger = await model.boundingBox();
    assert(above && trigger && above.y + above.height < trigger.y);
    await model.press("Escape");
  });
  await t.test("Narrow triggers keep options readable near the viewport edge", async () => {
    await model.evaluate((button: HTMLElement) => { button.style.width = "80px"; button.style.left = "auto"; button.style.right = "12px"; });
    await model.click();
    const menu = page.getByRole("listbox", { name: "Model", exact: true }), bounds = await menu.boundingBox();
    assert(bounds && bounds.width >= 200 && bounds.x >= 12 && bounds.x + bounds.width <= 348);
    for (const option of await menu.getByRole("option").all()) assert((await option.boundingBox())!.height <= 64);
    await page.getByRole("option", { name: "A newly reported model", exact: true }).click();
    await expect(model).toHaveText("A newly reported model");
  });
  assert.deepEqual(errors, []);
});
