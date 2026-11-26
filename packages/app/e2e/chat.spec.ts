import { expect, test } from "./harness/fixtures/test";

test("selects a model, streams a reply and sends conversation context", async ({ page }) => {
  await page.route("**/api/n/local/chat/models", (route) =>
    route.fulfill({ json: { models: ["fixture-model", "other-model"] } }),
  );
  const requests: unknown[] = [];
  await page.route("**/api/n/local/chat/completions", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: "text/event-stream",
      body:
        'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"world"}}]}\n\n' +
        "data: [DONE]\n\n",
    });
  });
  await page.goto("/");
  await page.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page).toHaveURL(/\/chat\?node=local$/);
  await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("other-model");
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("First question");
  await composer.press("Enter");
  await expect(page.getByText("Hello world", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await composer.fill("Follow up");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Hello world", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  expect(requests[1]).toEqual({
    model: "other-model",
    messages: [
      { role: "user", content: "First question" },
      { role: "assistant", content: "Hello world" },
      { role: "user", content: "Follow up" },
    ],
  });
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.getByText("First question", { exact: true })).toHaveCount(0);
});

test("stopping a pending reply restores the unsent draft", async ({ page }) => {
  await page.route("**/api/n/local/chat/models", (route) =>
    route.fulfill({ json: { models: ["fixture-model"] } }),
  );
  const release = Promise.withResolvers<null>();
  await page.route("**/api/n/local/chat/completions", async (route) => {
    await release.promise;
    await route.abort().catch(() => undefined);
  });
  try {
    await page.goto("/chat");
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("Keep this prompt");
    const pendingRequest = page.waitForRequest("**/api/n/local/chat/completions");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await pendingRequest;
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(composer).toHaveValue("Keep this prompt");
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    release.resolve(null);
  }
});

test("shows streamed reasoning, generation stats and formatted Markdown", async ({ page }) => {
  await page.route("**/api/n/local/chat/models", (route) =>
    route.fulfill({ json: { models: ["fixture-model"] } }),
  );
  await page.route("**/api/n/local/chat/completions", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body:
        [
          { choices: [{ delta: { reasoning_content: "Check " } }] },
          { choices: [{ delta: { reasoning: "the arithmetic." } }] },
          {
            choices: [
              {
                delta: {
                  content: [
                    "## Result",
                    "",
                    "**42**",
                    "",
                    "| Value |",
                    "| --- |",
                    "| 42 |",
                    "",
                    "```ts",
                    "const answer = 42;",
                    "```",
                    "",
                    "<img src='/fixture-untrusted'>",
                    "",
                    "[unsafe](javascript:alert%281%29)",
                  ].join("\n"),
                },
                finish_reason: "stop",
              },
            ],
            timings: { predicted_per_second: 45.5 },
          },
          {
            choices: [],
            usage: { completion_tokens: 24, completion_tokens_details: { reasoning_tokens: 8 } },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join("") + "data: [DONE]\n\n",
    }),
  );
  await page.goto("/chat");
  await page.getByRole("textbox", { name: "Message" }).fill("What is the result?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Result" })).toBeVisible();
  await expect(page.locator(".chat-reply strong")).toHaveText("42");
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.locator(".chat-reply pre code")).toHaveText("const answer = 42;");
  await expect(page.locator(".chat-reply img")).toHaveCount(0);
  await expect(page.locator(".chat-reply a[href^='javascript']")).toHaveCount(0);
  await expect(page.getByText("45.5 tok/s", { exact: true })).toBeVisible();
  await expect(page.getByText("24 tokens", { exact: true })).toBeVisible();
  const thinking = page.locator("summary").filter({ hasText: "Thinking" });
  await expect(thinking).toContainText("8 tokens");
  await expect(page.getByText("Check the arithmetic.", { exact: true })).toBeHidden();
  await thinking.click();
  await expect(page.getByText("Check the arithmetic.", { exact: true })).toBeVisible();
});

test("styles fenced blocks by language and keeps unknown code readable", async ({ page }) => {
  await page.route("**/api/n/local/chat/models", (route) =>
    route.fulfill({ json: { models: ["fixture-model"] } }),
  );
  const content = [
    "Use `answer` in this example.",
    "",
    "```ts",
    "const answer: number = 42;",
    "```",
    "",
    "```python",
    "def answer():",
    "    return 42",
    "```",
    "",
    "```custom-lang",
    "leave <output> untouched",
    "```",
    "",
    "```",
    "raw output",
    "```",
  ].join("\n");
  const body = JSON.stringify({
    choices: [{ delta: { content }, finish_reason: "stop" }],
  });
  await page.route("**/api/n/local/chat/completions", (route) =>
    route.fulfill({ contentType: "text/event-stream", body: `data: ${body}\n\ndata: [DONE]\n\n` }),
  );
  await page.goto("/chat");
  await page.getByRole("textbox", { name: "Message" }).fill("Show some examples");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  const blocks = page.locator(".chat-code-block");
  await expect(blocks.locator("figcaption")).toHaveText([
    "TypeScript",
    "Python",
    "custom-lang",
    "Text",
  ]);
  const ts = blocks.nth(0);
  const keyword = ts.locator(".hljs-keyword");
  await expect(keyword).toHaveText("const");
  const codeStyle = await ts.locator("pre").evaluate((node) => getComputedStyle(node).color);
  expect(await keyword.evaluate((node) => getComputedStyle(node).color)).not.toBe(codeStyle);
  await expect(blocks.nth(1).locator(".hljs-keyword")).toHaveText(["def", "return"]);
  await expect(blocks.nth(2).locator("code")).toHaveText("leave <output> untouched");
  await expect(blocks.nth(2).locator("code span")).toHaveCount(0);
  await expect(blocks.nth(3).locator("code")).toHaveText("raw output");
  await expect(page.locator(".chat-markdown p code")).toHaveText("answer");
});
