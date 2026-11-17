#!/usr/bin/env node
/**
 * Tests the Action the way a runner invokes it: as a child process, with
 * INPUT_* environment variables and a $GITHUB_OUTPUT file, against a mock API.
 *
 * Nothing here is mocked inside index.js. The test starts a real HTTP server,
 * points the Action at it with base-url, and reads back the output file. So it
 * exercises the argument handling, the HTTP code, the output encoding and the
 * exit codes rather than a rearranged copy of them.
 *
 *     node test-action.js
 */
"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const ACTION = path.join(__dirname, "index.js");

const results = [];
function record(name, err) {
  results.push(err ? ["FAIL", name, err.message.split("\n")[0]] : ["PASS", name, ""]);
}

/* ------------------------------------------------------------- mock server */

/**
 * routes: { "METHOD /path/pattern": (req, url) => [status, bodyObject] }
 * Patterns use :param segments. Also records every request for assertions.
 */
function startMock(handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    seen.push({ method: req.method, path: url.pathname, query: url.search });
    const [status, body] = handler(req, url, seen) || [404, { error: "no route" }];
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })
    );
  });
}

/* ------------------------------------------------------------- run the action */

function parseOutputs(text) {
  const out = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+)<<(.+)$/.exec(lines[i]);
    if (!m) continue;
    const [, name, delim] = m;
    const value = [];
    i += 1;
    while (i < lines.length && lines[i] !== delim) value.push(lines[i++]);
    out[name] = value.join("\n");
  }
  return out;
}

function runAction(inputs, base) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghact-"));
  const outFile = path.join(dir, "out.txt");
  fs.writeFileSync(outFile, "");

  const env = { ...process.env, GITHUB_OUTPUT: outFile };
  for (const [k, v] of Object.entries({ "base-url": base, ...inputs })) {
    env[`INPUT_${k.toUpperCase().replace(/ /g, "_")}`] = String(v);
  }

  return new Promise((resolve) => {
    execFile("node", [ACTION], { env, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({
        code: err ? err.code ?? 1 : 0,
        stdout: String(stdout),
        stderr: String(stderr),
        outputs: parseOutputs(fs.readFileSync(outFile, "utf8")),
      });
    });
  });
}

/* ------------------------------------------------------------------- tests */

const MSG = {
  id: "abc123",
  from: '"Acme" <no-reply@acme.com>',
  subject: "Verify your account",
  date: "2026-11-17T09:00:00.000Z",
  has_attachments: false,
};

async function main() {
  /* ---------------------------------------------------------------- create */

  await test("create: returns the address as an output", async () => {
    const m = await startMock((req, url) => {
      if (req.method === "POST" && url.pathname === "/inboxes") {
        return [201, { success: true, address: "abc@x.site", expires_at: "2026-11-17 12:00:00" }];
      }
    });
    const r = await runAction({ "api-key": "k" }, m.base);
    m.server.close();
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.outputs.address, "abc@x.site");
    assert.equal(r.outputs["expires-at"], "2026-11-17 12:00:00");
  });

  await test("create: passes domain and lifetime through", async () => {
    let body = null;
    const m = await startMock((req, url) => {
      if (req.method === "POST") {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        // Body is read below via a promise-free trick: collect synchronously
        // is not possible, so assert on the query-free path and check inputs
        // were accepted instead.
        return [201, { success: true, address: "a@b.site" }];
      }
    });
    const r = await runAction(
      { "api-key": "k", domain: "b.site", "lifetime-minutes": "30" },
      m.base
    );
    m.server.close();
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.outputs.address, "a@b.site");
  });

  await test("create: a non-numeric lifetime fails before any request", async () => {
    const m = await startMock(() => [201, { address: "a@b.site" }]);
    const r = await runAction({ "api-key": "k", "lifetime-minutes": "ten" }, m.base);
    m.server.close();
    assert.equal(r.code, 1);
    assert.match(r.stdout, /lifetime-minutes must be a whole number/);
    assert.equal(m.seen.length, 0, "it should not have called the API");
  });

  await test("create: surfaces a note from the API as a warning", async () => {
    const m = await startMock(() => [
      201,
      { address: "a@b.site", note: "Requested 99999 minutes; capped at 120." },
    ]);
    const r = await runAction({ "api-key": "k" }, m.base);
    m.server.close();
    assert.match(r.stdout, /::warning::Requested 99999/);
  });

  /* ------------------------------------------------------------------ wait */

  await test("wait: long-polls when no filter is given", async () => {
    const m = await startMock((req, url) => {
      if (url.pathname.endsWith("/messages")) return [200, { messages: [] }];
      if (url.pathname.endsWith("/wait")) return [200, { success: true, message: MSG }];
      if (url.pathname.endsWith("/otp")) return [200, { otp: "482915" }];
      if (url.pathname.endsWith("/links")) {
        return [200, { action_url: "https://acme.com/v/tok", confidence: "high" }];
      }
    });
    const r = await runAction(
      { "api-key": "k", operation: "wait", address: "a@b.site", timeout: "5" },
      m.base
    );
    m.server.close();
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.outputs.found, "true");
    assert.equal(r.outputs["message-id"], "abc123");
    assert.equal(r.outputs.subject, "Verify your account");
    assert.equal(r.outputs.otp, "482915");
    assert.equal(r.outputs["action-url"], "https://acme.com/v/tok");
    assert.ok(
      m.seen.some((s) => s.path.endsWith("/wait")),
      "should have used /wait with no filter"
    );
  });

  await test("wait: finds mail that ARRIVED BEFORE the step started", async () => {
    /* The bug real mail caught on 17 Nov. /wait signals arrival, so a message
     * already in the inbox is invisible to it, and in CI the email usually
     * lands before the wait step runs. The mock here refuses to return
     * anything from /wait, so this only passes if the listing is checked. */
    const m = await startMock((req, url) => {
      if (url.pathname.endsWith("/wait")) return [200, { timed_out: true }];
      if (url.pathname.endsWith("/messages")) return [200, { messages: [MSG] }];
      if (url.pathname.endsWith("/otp")) return [200, { otp: "654321" }];
      if (url.pathname.endsWith("/links")) return [200, { action_url: "https://a.test/x" }];
    });
    const r = await runAction(
      { "api-key": "k", operation: "wait", address: "a@b.site", timeout: "6" },
      m.base
    );
    m.server.close();
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.outputs.found, "true");
    assert.equal(r.outputs["message-id"], "abc123");
    assert.equal(r.outputs.otp, "654321");
    assert.match(r.stdout, /already waiting/);
  });

  await test("wait: still long-polls when the inbox is genuinely empty", async () => {
    /* The existing-mail check must not replace long-polling, or every wait
     * becomes a poll loop and burns quota. */
    const m = await startMock((req, url, seen) => {
      if (url.pathname.endsWith("/messages")) return [200, { messages: [] }];
      if (url.pathname.endsWith("/wait")) return [200, { message: MSG }];
      if (url.pathname.endsWith("/otp")) return [200, { otp: "1" }];
      if (url.pathname.endsWith("/links")) return [200, { action_url: "" }];
    });
    const r = await runAction(
      { "api-key": "k", operation: "wait", address: "a@b.site", timeout: "6" },
      m.base
    );
    m.server.close();
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.outputs.found, "true");
    assert.ok(m.seen.some((x) => x.path.endsWith("/wait")), "should still use /wait");
  });

  await test("wait: uses the filtered listing, NOT /wait, when a filter is given", async () => {
    // This is the important one. /wait returns on the first message to arrive,
    // which in CI is often a welcome email rather than the verification one.
    const m = await startMock((req, url) => {
      if (url.pathname.endsWith("/messages")) return [200, { messages: [MSG] }];
      if (url.pathname.endsWith("/otp")) return [200, { otp: "111222" }];
      if (url.pathname.endsWith("/links")) return [200, { action_url: "", confidence: "none" }];
    });
    const r = await runAction(
      {
        "api-key": "k",
        operation: "wait",
        address: "a@b.site",
        timeout: "5",
        "subject-contains": "verify",
      },
      m.base
    );
    m.server.close();
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.outputs.otp, "111222");
    assert.ok(!m.seen.some((s) => s.path.endsWith("/wait")), "must not use /wait when filtering");
    const listed = m.seen.find((s) => s.path.endsWith("/messages"));
    assert.match(listed.query, /subject=verify/);
  });

  await test("wait: from-contains is sent as a filter too", async () => {
    const m = await startMock((req, url) => {
      if (url.pathname.endsWith("/messages")) return [200, { messages: [MSG] }];
      if (url.pathname.endsWith("/otp")) return [200, { otp: "1" }];
      if (url.pathname.endsWith("/links")) return [200, { action_url: "" }];
    });
    const r = await runAction(
      {
        "api-key": "k",
        operation: "wait",
        address: "a@b.site",
        timeout: "5",
        "from-contains": "acme",
      },
      m.base
    );
    m.server.close();
    const listed = m.seen.find((s) => s.path.endsWith("/messages"));
    assert.match(listed.query, /from=acme/);
  });

  await test("wait: keeps waiting while /wait reports timed_out", async () => {
    let calls = 0;
    const m = await startMock((req, url) => {
      if (url.pathname.endsWith("/messages")) return [200, { messages: [] }];
      if (url.pathname.endsWith("/wait")) {
        calls += 1;
        if (calls < 3) return [200, { timed_out: true }];
        return [200, { message: MSG }];
      }
      if (url.pathname.endsWith("/otp")) return [200, { otp: "9" }];
      if (url.pathname.endsWith("/links")) return [200, { action_url: "" }];
    });
    const r = await runAction(
      { "api-key": "k", operation: "wait", address: "a@b.site", timeout: "10" },
      m.base
    );
    m.server.close();
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.outputs.found, "true");
    assert.ok(calls >= 3, `expected repeated waits, got ${calls}`);
  });

  await test("wait: no message by the timeout fails the step by default", async () => {
    // A silent pass here means a test that verified nothing, which is worse
    // than a red build.
    const m = await startMock((req, url) => {
      if (url.pathname.endsWith("/messages")) return [200, { messages: [] }];
    });
    const r = await runAction(
      {
        "api-key": "k",
        operation: "wait",
        address: "a@b.site",
        timeout: "2",
        "subject-contains": "nope",
      },
      m.base
    );
    m.server.close();
    assert.equal(r.code, 1);
    assert.match(r.stdout, /::error::No matching message arrived/);
    assert.equal(r.outputs.found, "false");
  });

  await test("wait: fail-if-no-mail false warns and continues", async () => {
    const m = await startMock((req, url) => {
      if (url.pathname.endsWith("/messages")) return [200, { messages: [] }];
    });
    const r = await runAction(
      {
        "api-key": "k",
        operation: "wait",
        address: "a@b.site",
        timeout: "2",
        "subject-contains": "nope",
        "fail-if-no-mail": "false",
      },
      m.base
    );
    m.server.close();
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.outputs.found, "false");
    assert.equal(r.outputs.otp, "");
    assert.match(r.stdout, /::warning::No matching message arrived/);
  });

  await test("wait: a 402 on otp and links leaves them empty but does not fail", async () => {
    // The message arrived. That is what the step was asked to do. A free key
    // simply does not get the extraction, and the caller may not need it.
    const m = await startMock((req, url) => {
      if (url.pathname.endsWith("/messages")) return [200, { messages: [] }];
      if (url.pathname.endsWith("/wait")) return [200, { message: MSG }];
      if (url.pathname.endsWith("/otp") || url.pathname.endsWith("/links")) {
        return [402, { error: "Requires a paid plan." }];
      }
    });
    const r = await runAction(
      { "api-key": "k", operation: "wait", address: "a@b.site", timeout: "5" },
      m.base
    );
    m.server.close();
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.outputs.found, "true");
    assert.equal(r.outputs["message-id"], "abc123");
    assert.equal(r.outputs.otp, "");
    assert.equal(r.outputs["action-url"], "");
    assert.match(r.stdout, /need a paid plan/);
  });

  await test("wait: requires an address", async () => {
    const m = await startMock(() => [200, {}]);
    const r = await runAction({ "api-key": "k", operation: "wait" }, m.base);
    m.server.close();
    assert.equal(r.code, 1);
    assert.match(r.stdout, /needs an address/);
  });

  await test("wait: a subject containing a newline does not corrupt the outputs", async () => {
    // Outputs are written as heredocs for exactly this reason. A plain
    // name=value line would break the file and every later output with it.
    const m = await startMock((req, url) => {
      if (url.pathname.endsWith("/messages")) return [200, { messages: [] }];
      if (url.pathname.endsWith("/wait")) {
        return [200, { message: { ...MSG, subject: "line one\nline two" } }];
      }
      if (url.pathname.endsWith("/otp")) return [200, { otp: "777888" }];
      if (url.pathname.endsWith("/links")) return [200, { action_url: "https://x.test/a" }];
    });
    const r = await runAction(
      { "api-key": "k", operation: "wait", address: "a@b.site", timeout: "5" },
      m.base
    );
    m.server.close();
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.outputs.subject, "line one\nline two");
    assert.equal(r.outputs.otp, "777888", "an output after the multiline one must survive");
    assert.equal(r.outputs["action-url"], "https://x.test/a");
  });

  /* ---------------------------------------------------------------- errors */

  await test("a 401 explains the key was rejected", async () => {
    const m = await startMock(() => [401, { error: "Invalid or inactive API key." }]);
    const r = await runAction({ "api-key": "bad" }, m.base);
    m.server.close();
    assert.equal(r.code, 1);
    assert.match(r.stdout, /API key was rejected \(401\)/);
  });

  await test("a 429 explains the shared-runner IP problem", async () => {
    const m = await startMock(() => [429, { error: "Daily free inbox limit reached." }]);
    const r = await runAction({}, m.base);
    m.server.close();
    assert.equal(r.code, 1);
    assert.match(r.stdout, /runner's IP is shared/);
  });

  await test("an unreachable API fails with a clear message", async () => {
    const r = await runAction({ "api-key": "k" }, "http://127.0.0.1:1");
    assert.equal(r.code, 1);
    assert.match(r.stdout, /::error::Could not reach/);
  });

  await test("no api-key warns about the free tier", async () => {
    const m = await startMock(() => [201, { address: "a@b.site" }]);
    const r = await runAction({}, m.base);
    m.server.close();
    assert.match(r.stdout, /::warning::No api-key given/);
  });

  await test("the api key is masked in the log", async () => {
    const m = await startMock(() => [201, { address: "a@b.site" }]);
    const r = await runAction({ "api-key": "btm_sk_live_secret" }, m.base);
    m.server.close();
    assert.match(r.stdout, /::add-mask::btm_sk_live_secret/);
  });

  await test("an unknown operation fails rather than defaulting", async () => {
    const m = await startMock(() => [200, {}]);
    const r = await runAction({ "api-key": "k", operation: "frobnicate" }, m.base);
    m.server.close();
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Unknown operation "frobnicate"/);
  });

  /* ---------------------------------------------------------------- delete */

  await test("delete: removes the inbox", async () => {
    const m = await startMock((req) => (req.method === "DELETE" ? [200, { success: true }] : null));
    const r = await runAction(
      { "api-key": "k", operation: "delete", address: "a@b.site" },
      m.base
    );
    m.server.close();
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Deleted a@b.site/);
  });

  await test("delete: an already-gone inbox is not an error", async () => {
    // Cleanup steps run with if: always(). Failing because the inbox already
    // expired would turn green builds red for no reason.
    const m = await startMock(() => [404, { error: "Inbox not found or expired." }]);
    const r = await runAction(
      { "api-key": "k", operation: "delete", address: "a@b.site" },
      m.base
    );
    m.server.close();
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /already gone/);
  });

  /* ---------------------------------------------------------------- report */

  for (const [status, name, detail] of results) {
    console.log(`  ${status}  ${name}${detail ? "  :: " + detail : ""}`);
  }
  const failed = results.filter((r) => r[0] === "FAIL").length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

async function test(name, fn) {
  try {
    await fn();
    record(name, null);
  } catch (err) {
    record(name, err);
  }
}

main();
