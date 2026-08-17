import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const modulesRoot =
  process.env.CODEX_NODE_MODULES ??
  "/Users/lubaiyu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const { chromium } = await import(
  pathToFileURL(path.join(modulesRoot, "playwright", "index.mjs")).href
);

const root = "/Users/lubaiyu/fju-project/prototypes";
const screenshotDir = path.join(root, "screenshots");
const prototypes = [
  { slug: "public-site", file: path.join(root, "public-site", "index.html") },
  { slug: "student-dashboard", file: path.join(root, "student-dashboard", "index.html") },
  { slug: "admin-editor", file: path.join(root, "admin-editor", "index.html") },
];

await fs.mkdir(screenshotDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});

const results = [];
const interactions = [];

for (const prototype of prototypes) {
  for (const variant of ["A", "B", "C"]) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      colorScheme: "light",
    });
    const page = await context.newPage();
    const errors = [];
    const externalRequests = [];

    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
    page.on("request", (request) => {
      const url = request.url();
      if (!url.startsWith("file:") && !url.startsWith("data:") && !url.startsWith("blob:")) {
        externalRequests.push(url);
      }
    });

    const fileUrl = `${pathToFileURL(prototype.file).href}?variant=${variant}`;
    await page.goto(fileUrl, { waitUntil: "load" });
    await page.waitForTimeout(150);

    const metrics = await page.evaluate(() => ({
      title: document.title,
      lang: document.documentElement.lang,
      bodyWidth: document.body.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      textLength: document.body.innerText.trim().length,
      switcher: Boolean(document.querySelector('[aria-label="原型切換器"]')),
      prototypeLabel: /PROTOTYPE|互動原型|原型切換器/i.test(document.body.innerText),
    }));

    await page.screenshot({
      path: path.join(screenshotDir, `${prototype.slug}-${variant}-desktop.png`),
      fullPage: true,
    });

    const pass =
      errors.length === 0 &&
      externalRequests.length === 0 &&
      metrics.lang === "zh-Hant" &&
      metrics.switcher &&
      metrics.prototypeLabel &&
      metrics.textLength > 300 &&
      metrics.bodyWidth <= metrics.viewportWidth + 4;

    results.push({
      prototype: prototype.slug,
      variant,
      viewport: "1440x1000",
      pass,
      errors,
      externalRequests,
      metrics,
    });
    await context.close();
  }

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: "light",
  });
  const page = await mobile.newPage();
  const errors = [];
  const externalRequests = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith("file:") && !url.startsWith("data:") && !url.startsWith("blob:")) {
      externalRequests.push(url);
    }
  });
  await page.goto(`${pathToFileURL(prototype.file).href}?variant=C`, { waitUntil: "load" });
  await page.waitForTimeout(150);
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(100);

  const metrics = await page.evaluate(() => ({
    variant: new URLSearchParams(window.location.search).get("variant"),
    bodyWidth: document.body.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    switcher: Boolean(document.querySelector('[aria-label="原型切換器"]')),
  }));
  await page.screenshot({
    path: path.join(screenshotDir, `${prototype.slug}-B-mobile.png`),
    fullPage: true,
  });
  const pass =
    errors.length === 0 &&
    externalRequests.length === 0 &&
    metrics.variant === "B" &&
    metrics.switcher &&
    metrics.bodyWidth <= metrics.viewportWidth + 4;
  results.push({
    prototype: prototype.slug,
    variant: "C→B keyboard",
    viewport: "390x844",
    pass,
    errors,
    externalRequests,
    metrics,
  });
  await mobile.close();
}

async function interactionPage(slug, variant = "A") {
  const prototype = prototypes.find((entry) => entry.slug === slug);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.goto(`${pathToFileURL(prototype.file).href}?variant=${variant}`, { waitUntil: "load" });
  return { context, page, errors };
}

{
  const { context, page, errors } = await interactionPage("public-site");
  await page.locator('[data-announcement-filter="競賽"]').first().click();
  await page.locator('[data-project-year="2024"]').first().click();
  await page.locator("[data-login]").first().click();
  const stateText = await page.locator("#stateText").innerText();
  const dialogOpen = await page.locator("#loginDialog").evaluate((dialog) => dialog.open);
  interactions.push({
    prototype: "public-site",
    check: "announcement filter + year filter + login preview",
    pass: errors.length === 0 && stateText.includes("競賽") && stateText.includes("2024 屆") && dialogOpen,
    errors,
    observed: { stateText, dialogOpen },
  });
  await context.close();
}

{
  const { context, page, errors } = await interactionPage("student-dashboard", "B");
  await page.locator('[data-filter="resubmit"]').first().click();
  await page.locator('[data-action="toggle-theme"]').first().click();
  await page.locator('[data-action="toggle-versions"]').first().click();
  await page.locator('[data-version="v2"]').first().click();
  const stateText = await page.locator(".state-panel").innerText();
  const theme = await page.locator("html").getAttribute("data-theme");
  interactions.push({
    prototype: "student-dashboard",
    check: "task filter + theme + shared-draft version",
    pass: errors.length === 0 && stateText.includes("需重送") && stateText.includes("V2") && theme === "dark",
    errors,
    observed: { theme, stateContainsFilter: stateText.includes("需重送"), stateContainsVersion: stateText.includes("V2") },
  });
  await context.close();
}

{
  const { context, page, errors } = await interactionPage("admin-editor");
  const beforeBlocks = await page.locator(".editor-block").count();
  await page.locator('[data-action="add-block"][data-kind="short_text"]').first().click();
  const afterBlocks = await page.locator(".editor-block").count();
  await page.locator('select[data-change="location"]').first().selectOption("submission");
  await page.locator('[data-action="preview-role"][data-role="visitor"]').first().click();
  const visitorGate = await page.locator(".visitor-gate").isVisible();
  await page.locator('[data-action="publish"]').first().click();
  const receiptText = await page.locator(".receipt-card").innerText();
  interactions.push({
    prototype: "admin-editor",
    check: "add block + change destination + visitor gate + publish receipt",
    pass:
      errors.length === 0 &&
      afterBlocks === beforeBlocks + 1 &&
      visitorGate &&
      receiptText.includes("發布完成") &&
      receiptText.includes("文件繳交"),
    errors,
    observed: { beforeBlocks, afterBlocks, visitorGate, receiptHasSubmission: receiptText.includes("文件繳交") },
  });
  await context.close();
}

await browser.close();

const report = {
  generatedAt: new Date().toISOString(),
  passed: results.every((result) => result.pass) && interactions.every((result) => result.pass),
  checks: results,
  interactions,
};
await fs.writeFile(
  path.join(screenshotDir, "validation-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.passed ? 0 : 1;
