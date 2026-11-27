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

test("inspects web Chat and opt-in fleet requests in Runs", async ({ page }) => {
  await page.route("**/api/n/local/chat/models", (route) =>
    route.fulfill({ json: { models: ["web-model"] } }),
  );
  await page.route("**/api/n/local/chat/completions", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: 'data: {"choices":[{"delta":{"content":"Browser reply"}}]}\n\ndata: [DONE]\n\n',
    }),
  );
  const summary = {
    id: "5f512abf-b81a-4612-a7df-0881d0e7171d",
    at: Date.UTC(2026, 10, 26),
    path: "/v1/chat/completions",
    model: "fleet-model",
    status: 200,
    durationMs: 900,
  };
  let detailLoads = 0;
  await page.route("**/api/n/local/requests", (route) =>
    route.fulfill({ json: { enabled: true, requests: [summary] } }),
  );
  await page.route(`**/api/n/local/requests/${summary.id}`, (route) => {
    detailLoads++;
    return route.fulfill({
      json: {
        ...summary,
        firstByteMs: 80,
        cancelled: false,
        truncated: false,
        request: { messages: [{ role: "user", content: "Fleet prompt" }], temperature: 0.2 },
        response: { reply: "Fleet reply" },
      },
    });
  });
  await page.goto("/chat");
  await page.getByRole("textbox", { name: "Message" }).fill("Browser prompt");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Browser reply", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await page.getByRole("button", { name: /web-model/ }).click();
  const web = page.getByRole("region", { name: "Request details" });
  await expect(web).toContainText("Browser prompt");
  await expect(web).toContainText("Browser reply");
  await expect(page.getByRole("button", { name: /fleet-model/ })).toBeVisible();
  expect(detailLoads).toBe(0);
  await page.getByRole("button", { name: /fleet-model/ }).click();
  const fleet = page.getByRole("region", { name: "Captured requests on local" });
  await expect(fleet.getByRole("region", { name: "Request details" })).toContainText(
    "Fleet prompt",
  );
  await expect(fleet).toContainText("Fleet reply");
  await expect(fleet).toContainText("80 ms");
  expect(detailLoads).toBe(1);
});
