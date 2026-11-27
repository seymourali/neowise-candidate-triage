import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./server.mjs";

async function withServer(run) {
  const server = createApp();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
}

async function post(baseUrl, body, raw = false) {
  return fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });
}

test("AI failure returns manual_review and never exposes an old draft", async () => {
  await withServer(async (baseUrl) => {
    const success = await post(baseUrl, { text: "Вопрос по доставке" });
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), {
      status: "ready",
      topic: "delivery",
      draft: "Спасибо за обращение. Уточним детали заявки.",
    });

    for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
      const response = await post(baseUrl, { text: `Проверьте заявку ${marker}` });
      assert.equal(response.status, 200, marker);
      assert.deepEqual(await response.json(), {
        status: "manual_review",
        topic: null,
        draft: null,
      }, marker);
    }
  });
});

test("empty, missing, non-string and malformed input return HTTP 400", async () => {
  await withServer(async (baseUrl) => {
    const cases = [
      post(baseUrl, { text: "   " }),
      post(baseUrl, {}),
      post(baseUrl, { text: 42 }),
      post(baseUrl, "{broken-json", true),
    ];
    for (const pending of cases) {
      const response = await pending;
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { status: "invalid_input" });
    }
  });
});

test("AI timeout is bounded to approximately 300 ms", async () => {
  await withServer(async (baseUrl) => {
    const startedAt = Date.now();
    const response = await post(baseUrl, { text: "[timeout]" });
    const elapsed = Date.now() - startedAt;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "manual_review");
    assert.ok(elapsed < 700, `expected timeout under 700ms, got ${elapsed}ms`);
  });
});
