import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as wait } from "node:timers/promises";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chromium } from "playwright-core";

const testDir = await mkdtemp(join(tmpdir(), "obsidian-inplace-test-"));
const profile = join(testDir, "profile");
const vault = join(testDir, "vault");
const settings = join(vault, ".obsidian");
const plugin = join(settings, "plugins", "obsidian-inplace");
const id = randomBytes(8).toString("hex");
const sample = "甲\n\n乙\n\n\n\n丙\n\n## 标题\n\n正文";
const listSample = "- 给薄荷浇水\n- 给罗勒换花盆\n\n\n\n阳台上的花草。\n\n傍晚记得关窗。";
const headingIntro = "准备完毕：";
const gapIntro = "整理盆栽";
const companionIds = process.env.OBSIDIAN_COMPANIONS ? ["unified-typography", "paragraph-enter"] : [];
if (process.env.OBSIDIAN_NOTION_BLOCK && companionIds.length) companionIds.push("notion-block");
const pluginIds = ["obsidian-inplace", ...companionIds];
let electron, browser;
let electronLog = "";
try {
  await mkdir(profile);
  await mkdir(plugin, { recursive: true });
  for (const id of companionIds) {
    const directory = join(settings, "plugins", id);
    await mkdir(directory, { recursive: true });
    for (const file of ["main.js", "manifest.json", "styles.css"]) {
      await copyFile(join(process.env.OBSIDIAN_COMPANIONS, id, file), join(directory, file));
    }
  }
  if (process.env.OBSIDIAN_RUNTIME_ASAR) {
    await copyFile(process.env.OBSIDIAN_RUNTIME_ASAR, join(profile, basename(process.env.OBSIDIAN_RUNTIME_ASAR)));
  }
  await Promise.all([
    writeFile(join(profile, "obsidian.json"), JSON.stringify({
      vaults: { [id]: { path: vault, ts: Date.now(), open: true } },
    })),
    writeFile(join(settings, "app.json"), "{}"),
    writeFile(join(settings, "community-plugins.json"), JSON.stringify(pluginIds)),
    writeFile(join(vault, "Sample.md"), sample),
    writeFile(join(vault, "List.md"), listSample),
    writeFile(join(vault, "Delete.md"), "甲\n\n\n\n乙"),
    writeFile(join(vault, "DeleteFull.md"), "甲\n\n  \n\n乙"),
    writeFile(join(vault, "DeleteFullRun.md"), "甲" + "\n".repeat(8) + "乙"),
    writeFile(join(vault, "Blocks.md"), "---\nkey: value\n\nother: 2\n---\n\n前文\n\n```\n甲\n\n乙\n```\n\n后文"),
    writeFile(join(vault, "Enter.md"), "原段落"),
    writeFile(join(vault, "Tail.md"), "终点" + "\n".repeat(4)),
    writeFile(join(vault, "ListTail.md"), "- 第一项\n- "),
    writeFile(join(vault, "OrderedTail.md"), "1. 第一项\n2. "),
    writeFile(join(vault, "TaskTail.md"), "- [x] 第一项\n- [ ] "),
    writeFile(join(vault, "NestedTail.md"), "- 父项\n  - 子项\n  - "),
    writeFile(join(vault, "Leading.md"), "\n\n开头"),
    writeFile(join(vault, "LooseList.md"), "- 第一项\n\n- 第二项\n\n正文\n"),
    writeFile(join(vault, "HeadingInside.md"), "## 上级\n#### 下级\n之后"),
    ...Array.from({ length: 6 }, (_, index) =>
      writeFile(join(vault, `H${index + 1}.md`), "#".repeat(index + 1) + " 标题")),
    writeFile(join(vault, "Heading.md"), headingIntro + "\n\n\n\n## 阳台花园的养护计划\n\n\n\n接下来的正文"),
    ...Array.from({ length: 10 }, (_, n) => n + 1).flatMap(blanks =>
      [true, false].map(heading => writeFile(join(vault, `Gap${blanks}-${heading ? "heading" : "prose"}.md`),
        "养护清单\n\n" + gapIntro + "\n".repeat(blanks + 1) + (heading ? "## 浇水" : "浇水") + "\n\n正文"))),
    writeFile(join(vault, "Breaks.md"), "甲乙"),
    writeFile(join(vault, "Wrapped.md"), "这是一行会根据窗口宽度自动折行的正文。".repeat(24) + "\n\n下一段"),
    ...["main.js", "manifest.json", "styles.css"].map(file => copyFile(file, join(plugin, file))),
  ]);
  const portProbe = createServer().listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const { port } = portProbe.address();
  await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
  electron = spawn(
    process.env.OBSIDIAN_PATH || "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  electron.stderr.on("data", chunk => { electronLog += chunk.toString(); });
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  while (!browser && Date.now() < deadline && electron.exitCode === null && !electron.signalCode) {
    try {
      const response = await fetch(endpoint + "/json/version", { signal: AbortSignal.timeout(1000) });
      if (response.ok) browser = await chromium.connectOverCDP(endpoint, { timeout: 2500 });
    } catch { /* Wait for Electron's debugger to start. */ }
    if (!browser) await wait(250);
  }
  if (!browser) throw new Error(`Could not connect to isolated Obsidian instance.
${electronLog}`);
  const context = browser.contexts()[0];
  const window = context.pages().find(page => page.url().includes("obsidian"))
    ?? context.pages()[0] ?? await context.waitForEvent("page", { timeout: 10000 });
  window.setDefaultTimeout(8000);
  await window.waitForFunction(dir => window.app?.vault.adapter.getBasePath?.() === dir, vault, { timeout: 15000 });
  await window.waitForFunction(() => window.app?.workspace?.layoutReady && window.app?.plugins?.enabledPlugins);
  const diagnostics = [];
  window.on("pageerror", error => diagnostics.push(error.stack ?? error.message));
  window.on("console", message => {
    if (message.type() === "error") diagnostics.push(message.text());
  });
  await window.evaluate(async ids => {
    const { plugins } = window.app;
    if (typeof plugins.setEnable === "function") await plugins.setEnable(true);
    for (const id of ids) {
      if (!plugins.plugins[id]) await plugins.enablePluginAndSave(id);
      if (!plugins.plugins[id]) throw new Error(`Plugin did not load: ${id}`);
    }
  }, pluginIds);
  for (let count = 0; count < 3 && await window.locator(".modal-container:visible").count(); count++) {
    await window.keyboard.press("Escape");
  }
  const open = (file, source = false) => window.evaluate(async ({ file, source }) => {
    const { workspace } = window.app;
    const leaf = workspace.getLeaf(false);
    await leaf.setViewState({ type: "markdown", state: { file, mode: "source", source }, active: true });
    workspace.setActiveLeaf(leaf, { focus: true });
    leaf.view.editor.cm.focus();
  }, { file, source });

  const view = window.locator(".markdown-source-view.is-live-preview");
  const gaps = view.locator(".inplace-native-gap");
  const cursor = pos => window.evaluate(anchor => {
    const cm = window.app.workspace.activeLeaf.view.editor.cm;
    cm.dispatch({ selection: { anchor } });
    cm.focus();
  }, pos);
  const selection = () => window.evaluate(() => {
    const { state } = window.app.workspace.activeLeaf.view.editor.cm;
    const { anchor, head, from, to } = state.selection.main;
    return { anchor, head, text: state.sliceDoc(from, to) };
  });
  const settleGeometry = () => window.evaluate(() =>
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  if (process.env.OBSIDIAN_THEME_CSS) await window.addStyleTag({ path: process.env.OBSIDIAN_THEME_CSS });

  await (async () => {
    const editorText = () => window.evaluate(() => app.workspace.activeLeaf.view.editor.getValue());
    await open("DeleteFull.md");
    const editableBlanks = view.locator('[data-inplace-gap="full"]');
    const full = await editableBlanks.first().boundingBox();
    assert.ok(full, "Whitespace-only full row is rendered");
    await window.mouse.click(full.x + 20, full.y + full.height / 2);
    await window.keyboard.press("Backspace");
    assert.equal(await editorText(), "甲\n\n乙", "One Backspace removes a full blank and both adjacent breaks");
    assert.equal((await selection()).head, 1, "With only the separator left, the caret returns to the previous text");
    assert.equal(await editableBlanks.count(), 0);
    await window.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    assert.equal(await editorText(), "甲\n\n  \n\n乙", "One undo restores both breaks");
    await open("DeleteFull.md", true);
    await cursor(3);
    await window.keyboard.press("Backspace");
    assert.equal(await editorText(), "甲\n  \n\n乙", "Source-mode Backspace removes only one break");

    await open("DeleteFullRun.md");
    const fullInRun = await editableBlanks.nth(1).boundingBox();
    await window.mouse.click(fullInRun.x + 20, fullInRun.y + fullInRun.height / 2);
    for (const breaks of [6, 4, 2]) {
      await window.keyboard.press("Backspace");
      assert.equal(await editorText(), "甲" + "\n".repeat(breaks) + "乙");
      assert.equal(await editableBlanks.count(), Math.max(0, breaks - 3));
    }
    assert.equal((await selection()).head, 1);
    await window.keyboard.press("Backspace");
    assert.equal(await editorText(), "\n\n乙", "Backspace in real text keeps the usual single-character behavior");
  })();

  if (!process.argv.includes("--backspace-only")) {
    const contents = () => window.evaluate(() => app.workspace.activeLeaf.view.editor.getValue());
    const line = () => window.evaluate(() => {
      const { state } = app.workspace.activeLeaf.view.editor.cm;
      return state.doc.lineAt(state.selection.main.head).number;
    });
    const draft = view.locator(".inplace-native-draft");
    const half = view.locator('[data-inplace-gap="half"]');

    // Reopen a document with pre-existing trailing whitespace and no draft.
    await open("Tail.md");
    assert.equal(await gaps.count(), 4);
    assert.equal(await half.count(), 2);
    await cursor("终点".length);
    for (const expected of [3, 4, 4]) {
      await window.keyboard.press("ArrowDown");
      assert.equal(await line(), expected, "Down can enter complete trailing blanks but skips the EOF half");
    }
    const lastHalf = await half.last().boundingBox();
    await window.mouse.click(lastHalf.x + 20, lastHalf.y + lastHalf.height * 0.8);
    assert.equal(await line(), 4, "The bottom half at EOF routes back to the last editable row");
    await window.keyboard.press("Backspace");
    assert.equal(await contents(), "终点\n\n");
    assert.equal(await draft.count(), 0);
    assert.equal(await line(), 1);
    await window.keyboard.press("ArrowDown");
    assert.equal(await line(), 1);
    await window.keyboard.press("ArrowRight");
    assert.equal(await line(), 1, "Right will not move onto the terminal half either");
    await window.keyboard.press("Enter");
    assert.equal(await contents(), "终点\n\n\n\n");
    assert.equal(await draft.count(), 1);
    await window.keyboard.press("ArrowUp");
    assert.equal(await draft.count(), 0);
    assert.equal(await gaps.count(), 4);

    // A list can hold native items and folded outer separators in one view.
    await open("ListTail.md");
    await cursor((await contents()).length);
    await window.keyboard.press("Enter");
    assert.equal(await contents(), "- 第一项\n\n", "Enter exits a top-level empty list item into a real paragraph");
    assert.equal(await draft.count(), 1);
    assert.equal(await half.count(), 1);
    await window.keyboard.insertText("清单后的正文");
    assert.equal(await contents(), "- 第一项\n\n清单后的正文");
    assert.equal(await half.count(), 1);
    await cursor("- 第一项".length);
    await window.keyboard.press("ArrowDown");
    assert.equal(await line(), 3);

    for (const [file, item] of [["OrderedTail.md", "1. 第一项"], ["TaskTail.md", "- [x] 第一项"]]) {
      await open(file);
      await cursor((await contents()).length);
      await window.keyboard.press("Enter");
      assert.equal(await contents(), item + "\n\n", file);
      assert.equal(await half.count(), 1);
      assert.equal(await draft.count(), 1);
    }
    await open("NestedTail.md");
    await cursor((await contents()).length);
    await window.keyboard.press("Enter");
    assert.match(await contents(), /^- 父项\n  - 子项\n/, "Nested list maintains its ancestor and child");
    assert.equal(await gaps.count(), 0, "Nested list continues through the native path");

    await open("LooseList.md");
    assert.equal(await half.count(), 3, "Loose list separators, post-list gaps and the final blank use one layout");
    await cursor(0);
    for (const expected of [3, 5, 5]) {
      await window.keyboard.press("ArrowDown");
      assert.equal(await line(), expected);
    }

    const postList = await half.nth(1).boundingBox();
    await window.mouse.click(postList.x + 20, postList.y + postList.height * 0.75);
    assert.equal(await line(), 5);
    await window.mouse.click(postList.x + 20, postList.y + postList.height * 0.25);
    assert.equal(await line(), 3);

    await open("Leading.md");
    assert.equal(await half.count(), 2);
    const headHalf = await half.first().boundingBox();
    await window.mouse.click(headHalf.x + 20, headHalf.y + headHalf.height * 0.2);
    assert.equal(await line(), 3, "The first half at the start resolves to following text");
    await cursor(2);
    await window.keyboard.press("ArrowUp");
    assert.equal(await line(), 3);
    await window.keyboard.press("ArrowLeft");
    assert.equal(await line(), 3);

    for (let level = 1; level <= 6; level++) {
      await open(`H${level}.md`);
      const before = await contents();
      await cursor(before.length);
      await window.keyboard.press("Enter");
      assert.equal(await contents(), before + "\n\n", `Enter at heading level ${level}`);
      assert.equal(await view.locator(".inplace-native-heading-gap").count(), 1);
      assert.equal(await draft.count(), 1);
      await window.keyboard.press("Backspace");
      assert.equal(await contents(), before, "Backspace reverses a terminal paragraph break as a pair");
      assert.equal((await selection()).head, before.length);
      await window.keyboard.press("Shift+Enter");
      assert.equal(await contents(), before + "\n", "Shift+Enter at a heading still inserts only one break");
      await window.keyboard.press("Backspace");
      assert.equal(await contents(), before);
    }

    await open("HeadingInside.md");
    await cursor("## 上级".length);
    await window.keyboard.press("Enter");
    assert.equal(await contents(), "## 上级\n\n\n#### 下级\n之后");
    await window.keyboard.insertText("新正文");
    assert.equal(await contents(), "## 上级\n\n新正文\n#### 下级\n之后");
    assert.equal(await view.locator(".inplace-native-heading-gap").count(), 1);
    await window.keyboard.press("ArrowUp");
    assert.equal(await line(), 1);
    console.log("List, EOF and H1–H6 boundary tests passed.");
  }

  const backspaceOnly = process.argv.includes("--backspace-only");
  if (backspaceOnly) console.log("Backspace regression tests passed.");
  if (!backspaceOnly && !process.argv.includes("--boundaries-only")) {
    await open("Sample.md");
    await gaps.first().waitFor();

    const heights = await gaps.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
    const ordinaryLine = await view.locator(".cm-line").first().boundingBox();
    const expectedGap = companionIds.length ? 12 : ordinaryLine.height / 2;
    const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1, JSON.stringify({ actual, expected }));
    near(heights[0], expectedGap);
    for (const [actual, expected] of heights.slice(1, 4).map((value, index) =>
      [value, [expectedGap, ordinaryLine.height, expectedGap][index]])) near(actual, expected);
    assert.ok(heights.slice(4).every(height => height > 1 && Math.abs(height - heights[0]) > 1), "Heading gaps differ");
    console.log("Native Live Preview gap heights:", heights);

    await cursor(0);
    await window.keyboard.press("ArrowDown");
    assert.equal((await selection()).head, 3);
    await window.keyboard.press("ArrowUp");
    assert.equal((await selection()).head, 0);
    await window.keyboard.press("Shift+ArrowDown");
    assert.deepEqual(await selection(), { anchor: 0, head: 3, text: "甲\n\n" });

    const gap = await gaps.first().boundingBox();
    await window.mouse.click(gap.x + 20, gap.y + gap.height / 2);
    assert.notEqual((await selection()).head, 2);
    await cursor(1);
    await settleGeometry();
    const dragGap = await gaps.first().boundingBox();
    const coords = await window.evaluate(() => {
      const rect = window.app.workspace.activeLeaf.view.editor.cm.coordsAtPos(1);
      return { x: rect.right + 3, y: (rect.top + rect.bottom) / 2 };
    });
    await window.mouse.move(coords.x, coords.y);
    await window.mouse.down();
    await window.mouse.move(dragGap.x + 20, dragGap.y + dragGap.height / 2, { steps: 6 });
    await window.mouse.up();
    assert.deepEqual(await selection(), { anchor: 1, head: 2, text: "\n" });
    assert.equal(await window.evaluate(() => {
      const clipboardData = new DataTransfer();
      window.app.workspace.activeLeaf.view.editor.cm.contentDOM.dispatchEvent(new ClipboardEvent("copy", {
        clipboardData, bubbles: true, cancelable: true,
      }));
      return clipboardData.getData("text/plain");
    }), "\n");

    await cursor(3);
    await window.keyboard.press("ArrowDown");
    assert.equal((await selection()).head, 6, "ArrowDown enters the visible blank row in a four-newline gap");
    await window.keyboard.press("ArrowDown");
    assert.equal((await selection()).head, 8, "The trailing half is skipped");
    await window.keyboard.press("ArrowUp");
    assert.equal((await selection()).head, 6, "ArrowUp can also enter the same visible row");
    await window.keyboard.press("ArrowUp");
    assert.equal((await selection()).head, 3);
    if (companionIds.length) {
      await window.evaluate(() => {
        const style = document.getElementById("unified-typography-dynamic-styles");
        style.textContent = style.textContent.replace("--p-spacing: 12px", "--p-spacing: 18px");
      });
      await window.waitForFunction(() =>
        Math.abs(document.querySelector(".inplace-native-gap").getBoundingClientRect().height - 18) < 0.1);
    }

    const coordsAt = pos => window.evaluate(pos => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      const rect = cm.coordsAtPos(pos);
      return { x: rect.left, y: (rect.top + rect.bottom) / 2 };
    }, pos);
    const drag = async (from, to) => {
      await window.mouse.move(from.x, from.y);
      await window.mouse.down();
      await window.mouse.move(to.x, to.y, { steps: 8 });
      await window.mouse.up();
    };
    const gapHeights = () => gaps.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
    const selectedRows = view.locator(".inplace-native-gap-selected");

    // Cover a list followed by four newlines and body text.
    await open("List.md");
    await gaps.first().waitFor();
    const listHeights = await gapHeights();
    const beforeText = listSample.indexOf("阳台");
    const afterList = listSample.indexOf("\n\n");
    const listEnd = await coordsAt(afterList);
    const paragraphStart = await coordsAt(beforeText);
    const afterEnd = { x: listEnd.x + 3, y: listEnd.y };
    const beforeStart = { x: paragraphStart.x + 1, y: paragraphStart.y };
    for (const [from, to] of [[afterEnd, beforeStart], [beforeStart, afterEnd]]) {
      await drag(from, to);
      assert.equal((await selection()).text, "\n\n\n\n");
      assert.deepEqual(await gapHeights(), listHeights, "Selecting does not reflow the spacing");
      assert.equal(await selectedRows.count(), 3, "The selected band spans all three rendered blank rows");
      const sizes = await selectedRows.evaluateAll(nodes => nodes.map(node => {
        const style = getComputedStyle(node);
        return [style.backgroundSize, getComputedStyle(node, "::selection").backgroundColor];
      }));
      assert.ok(sizes.every(([size, native]) => size.endsWith("100%") && native === "rgba(0, 0, 0, 0)"));
      if (process.env.INPLACE_SCREENSHOT && from === afterEnd) {
        await view.locator(".cm-content").screenshot({ path: process.env.INPLACE_SCREENSHOT, scale: "css" });
      }
      await cursor(beforeText);
      assert.equal(await selectedRows.count(), 0);
    }
    const firstListGap = await gaps.first().boundingBox();
    await drag(afterEnd, { x: firstListGap.x + 20, y: firstListGap.y + firstListGap.height / 2 });
    assert.equal((await selection()).text, "\n");
    assert.equal(await selectedRows.count(), 1, "Dragging onto just the first half selects one break");
    await window.keyboard.press("Backspace");
    assert.equal((await selection()).text, "", "Backspace consumes the selected break");
    assert.equal(await view.locator(".inplace-native-draft").count(), 0);

    await open("Delete.md");
    await cursor(4);
    await window.keyboard.press("Backspace");
    assert.equal(await window.evaluate(() => app.workspace.activeLeaf.view.editor.getValue()), "甲\n\n\n乙");
    assert.equal(await view.locator(".inplace-native-draft").count(), 0, "Backspace does not create an editing row");
    const afterBackspace = await gapHeights();
    await window.keyboard.press("ArrowDown");
    assert.deepEqual(await gapHeights(), afterBackspace, "Moving away cannot change a row just edited by Backspace");
    await window.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    assert.equal(await window.evaluate(() => app.workspace.activeLeaf.view.editor.getValue()), "甲\n\n\n\n乙");
    assert.equal(await view.locator(".inplace-native-draft").count(), 0);
    assert.equal((await gapHeights()).length, 3);

    // Repeated deletion reduces the number of actual source breaks once per key.
    await cursor(4);
    for (const [remaining, layouts] of [[3, 2], [2, 1], [1, 0]]) {
      await window.keyboard.press("Backspace");
      assert.equal(await window.evaluate(() => app.workspace.activeLeaf.view.editor.getValue()),
        "甲" + "\n".repeat(remaining) + "乙");
      assert.equal(await view.locator(".inplace-native-draft").count(), 0);
      assert.equal((await gapHeights()).length, layouts);
    }

    await open("Sample.md", true);
    assert.equal(await window.locator(".inplace-native-gap").count(), 0);
    await cursor(0);
    await window.keyboard.press("ArrowDown");
    assert.equal((await selection()).head, 2);
    assert.equal(await readFile(join(vault, "Sample.md"), "utf8"), sample);

    await open("Blocks.md");
    await view.locator(".HyperMD-codeblock").first().waitFor();
    assert.equal(await view.locator(".HyperMD-codeblock.inplace-native-gap, .HyperMD-frontmatter.inplace-native-gap").count(), 0);
    if (companionIds.length) assert.ok(await window.locator("#unified-typography-dynamic-styles").count());

    await open("Heading.md");
    const lineNumber = () => window.evaluate(() => {
      const { state } = app.workspace.activeLeaf.view.editor.cm;
      return state.doc.lineAt(state.selection.main.head).number;
    });
    await gaps.first().waitFor();
    await cursor(headingIntro.length);
    for (const expected of [3, 5, 7, 9]) {
      await window.keyboard.press("ArrowDown");
      assert.equal(await lineNumber(), expected, "Editable gap rows on both sides of a heading");
    }
    for (const expected of [7, 5, 3, 1]) {
      await window.keyboard.press("Shift+ArrowUp");
      assert.equal(await lineNumber(), expected);
    }
    assert.ok((await selection()).text.includes("\n\n\n\n"));

    for (const isHeading of [true, false]) {
      let previousHeight = 0;
      for (let blanks = 1; blanks <= 10; blanks++) {
        const file = `Gap${blanks}-${isHeading ? "heading" : "prose"}.md`;
        const input = await readFile(join(vault, file), "utf8");
        const following = blanks + 4;
        const stops = Array.from({ length: Math.max(0, blanks - 2) }, (_, index) => 5 + index);
        const caseName = `${blanks} blank lines before ${isHeading ? "heading" : "prose"}`;
        await open(file);
        const gapRows = await view.locator(".cm-content").evaluate((content, count) => {
          const rows = Array.from(content.querySelectorAll(":scope > .cm-line"));
          return rows.slice(3, 3 + count).map(node => ({
            type: node.getAttribute("data-inplace-gap"),
            height: node.getBoundingClientRect().height,
          }));
        }, blanks);
        const halfCount = Math.min(blanks, 2);
        assert.equal(gapRows.filter(row => row.type === "half").length, halfCount, caseName);
        assert.equal(gapRows.filter(row => row.type === "full").length, stops.length, caseName);
        assert.equal(gapRows[0].type, "half");
        assert.equal(gapRows.at(-1).type, "half");
        const total = gapRows.reduce((height, row) => height + row.height, 0);
        assert.ok(total > previousHeight, caseName);
        previousHeight = total;

        const endPos = input.indexOf(gapIntro) + gapIntro.length;
        await cursor(endPos);
        for (const expected of [...stops, following]) {
          await window.keyboard.press("ArrowDown");
          assert.equal(await lineNumber(), expected, `ArrowDown: ${caseName}`);
        }
        for (const expected of [...stops].reverse().concat(3)) {
          await window.keyboard.press("ArrowUp");
          assert.equal(await lineNumber(), expected, `ArrowUp: ${caseName}`);
        }

        const fullRows = view.locator('[data-inplace-gap="full"]');
        const reference = await view.locator(".cm-line").first().boundingBox();
        for (let index = 0; index < stops.length; index++) {
          const row = await fullRows.nth(index).boundingBox();
          near(row.height, reference.height);
          const fractions = blanks === 3 || blanks === 4 ? [0.16, 0.5, 0.84] : [0.5];
          for (const fraction of fractions) {
            await window.mouse.click(row.x + 20, row.y + row.height * fraction);
            assert.equal(await lineNumber(), stops[index], `Click inside full blank row: ${caseName}`);
          }
        }

        const halves = view.locator('[data-inplace-gap="half"]');
        const half = await halves.nth(1).boundingBox();
        const lowerBox = blanks === 2 ? await halves.nth(2).boundingBox() : half;
        const clickStates = blanks === 2
          ? [[half, 0.25, 3], [half, 0.75, 3], [lowerBox, 0.25, following], [lowerBox, 0.75, following]]
          : [[half, 0.25, 3], [half, 0.75, stops[0] ?? following]];
        for (const [box, fraction, expected] of clickStates) {
          await window.mouse.click(box.x + 20, box.y + box.height * fraction);
          assert.equal(await lineNumber(), expected, `Click either side of a separator: ${caseName}`);
        }
        const endpoints = async () => {
          await settleGeometry();
          const start = await coordsAt(endPos);
          const box = await halves.nth(1).boundingBox();
          return [{ x: start.x + 3, y: start.y }, { x: box.x + 20, y: box.y + box.height / 2 }];
        };
        await cursor(endPos);
        await drag(...await endpoints());
        assert.equal((await selection()).text, "\n", `Dragging onto a separator: ${caseName}`);
        if (blanks === 3 || blanks === 4) {
          await cursor(endPos);
          await drag(...(await endpoints()).reverse());
          assert.equal((await selection()).text, "\n", `Dragging from a separator: ${caseName}`);
        }
        assert.equal(await readFile(join(vault, file), "utf8"), input);
      }
    }
    console.log("Validated layout, keyboard and mouse for 1–10 source blank lines before headings and prose.");

    await open("Wrapped.md");
    await gaps.first().waitFor();
    await cursor(0);
    await window.keyboard.press("ArrowDown");
    assert.equal(await lineNumber(), 1, "An automatically wrapped visual line is not skipped");
    assert.ok((await selection()).head > 0);

    await open("Enter.md");
    await cursor("原段落".length);
    await window.keyboard.press("Enter");
    assert.equal(await window.evaluate(() => app.workspace.activeLeaf.view.editor.getValue()), "原段落\n\n");
    assert.equal(await view.locator(".inplace-native-draft").count(), 1);
    assert.equal(await gaps.count(), 1, "The new blank draft and the collapsed separator coexist");
    await window.keyboard.press("Backspace");
    assert.equal(await view.locator(".inplace-native-draft").count(), 0, "Deleting the newly inserted return closes its editing row");
    await cursor("原段落".length);
    await window.keyboard.press("Enter");
    await window.keyboard.insertText("下一段");
    assert.equal(await view.locator(".inplace-native-draft").count(), 0);
    await gaps.first().waitFor();

    await open("Breaks.md");
    await cursor(1);
    await window.keyboard.press("Shift+Enter");
    const text = () => window.evaluate(() => app.workspace.activeLeaf.view.editor.getValue());
    assert.equal(await text(), "甲\n乙");
    assert.equal(await gaps.count(), 0, "Shift+Enter is a regular text line");
    await cursor(0);
    await window.keyboard.press("ArrowDown");
    assert.equal(await lineNumber(), 2, "The soft-break line remains keyboard reachable");
    await cursor(1);
    await window.keyboard.press("Enter");
    assert.equal(await text(), "甲\n\n乙", "Enter promotes an existing soft break to a paragraph separator");
    assert.equal(await gaps.count(), 1);

    await open("List.md");
    const firstItemEnd = listSample.indexOf("\n");
    await cursor(firstItemEnd);
    await window.keyboard.press("Enter");
    assert.ok((await text()).includes("浇水\n- \n- 给罗勒"), "Native list continuation remains available");

    // Reconfigure an already mounted editor instead of only loading the
    // extension before any Markdown tabs exist.
    await open("Sample.md");
    await window.evaluate(async () => {
      const { plugins, workspace } = window.app;
      const cm = workspace.activeLeaf.view.editor.cm;
      cm.dispatch({ selection: { anchor: 0, head: 3 } });
      await plugins.disablePluginAndSave("obsidian-inplace");
      await plugins.enablePluginAndSave("obsidian-inplace");
      if (!plugins.plugins["obsidian-inplace"]) {
        throw new Error("Hot enable failed with a Markdown editor already open");
      }
    });
    assert.deepEqual(diagnostics.filter(line => /inplace|Field is not present|Unrecognized extension|CodeMirror plugin crashed/i.test(line)), []);
    await view.locator(".inplace-native-gap-selected").waitFor();
    assert.equal(await view.locator(".inplace-native-gap-selected").count(), 1);
    assert.deepEqual(await selection(), { anchor: 0, head: 3, text: "甲\n\n" });
    console.log(`Passed native Obsidian integration${companionIds.length ? " with " + companionIds.join(", ") : ""}.`);
  }
} finally {
  await browser?.close();
  if (electron && electron.exitCode === null && !electron.signalCode) {
    const exit = once(electron, "exit");
    electron.kill();
    await Promise.race([exit, wait(2000)]);
  }
  await rm(testDir, { recursive: true, force: true });
}
