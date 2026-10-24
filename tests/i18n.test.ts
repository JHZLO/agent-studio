import test from "node:test";
import assert from "node:assert/strict";
import { t, html, attrs, locale, setLanguage } from "../apps/web/i18n.js";
import korean from "../apps/web/locales/ko.js";
import { settingsSchema } from "../packages/contracts/index.ts";
import { initialState } from "../packages/contracts/defaults.js";

test("Language settings preserve old workspaces and reject unsupported locales", () => {
  const settings = initialState(); delete (settings as any).language;
  assert.equal(settingsSchema.parse(settings).language, "en");
  assert.equal(settingsSchema.parse({ ...settings, language: "ko" }).language, "ko");
  assert.equal(settingsSchema.safeParse({ ...settings, language: "xx" }).success, false);
});

test("Literal translation preserves user content, form values and escaped attributes", () => {
  setLanguage("ko");
  assert.equal(locale(), "ko-KR");
  assert.equal(html`<button>New task</button><strong>${"New task"}</strong>`, "<button>새 작업</button><strong>New task</strong>");
  assert.equal(html`<option value="running">Running</option>`, '<option value="running">실행 중</option>');
  assert.equal(attrs`data-id="New task" aria-label="Open project ${"New task"}"`, 'data-id="New task" aria-label="New task 프로젝트 열기"');
  assert.equal(html`<p title="Open project ${"A &quot;B&quot;"}">${"<code>New task</code>"}</p>`, '<p title="A &quot;B&quot; 프로젝트 열기"><code>New task</code></p>');
  assert.equal(t`Step ${2} of ${4} / ${"Plan"}`, "2 / 4단계 - Plan");
  assert.equal(t("Unrecognized provider diagnostic"), "Unrecognized provider diagnostic");
  assert.equal(t("constructor"), "constructor");
  setLanguage("en");
  assert.equal(html`<button>New task</button><strong>${"새 작업"}</strong>`, "<button>New task</button><strong>새 작업</strong>");
  assert.equal(t`Step ${2} of ${4} / ${"Plan"}`, "Step 2 of 4 / Plan");
});

test("Korean messages retain all interpolation arguments", () => {
  const slots = (text: string) => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
  for (const [source, translated] of Object.entries(korean)) {
    assert.deepEqual(slots(translated), slots(source), source);
    assert(!translated.includes(String.fromCharCode(183)), source);
  }
});
