#!/usr/bin/env node
/* ============================================================================
 *  best-tempmail GitHub Action
 *
 *  Creates a disposable inbox, waits for the email, and hands back the
 *  verification code and the link to click as step outputs.
 *
 *  NO DEPENDENCIES, ON PURPOSE.
 *
 *  The usual way to write an Action is @actions/core bundled by ncc into a
 *  committed dist/ folder. That means a build step, and a dist/ that silently
 *  goes stale the moment someone edits the source without rebuilding, which
 *  then runs old code while the diff looks correct. None of it buys anything
 *  here: Node 20 on the runner has fetch built in, inputs arrive as INPUT_*
 *  environment variables, and outputs are appended to a file. So this is one
 *  file with nothing to install, nothing to build, and nothing to go stale.
 * ==========================================================================*/

"use strict";

const fs = require("node:fs");

/* ----------------------------------------------------------------- plumbing */

/** Actions passes `foo-bar` as INPUT_FOO-BAR, uppercased, spaces to _. */
function input(name, dflt = "") {
  const key = `INPUT_${name.toUpperCase().replace(/ /g, "_")}`;
  const raw = process.env[key];
  return raw === undefined || raw === null ? dflt : String(raw).trim();
}

function bool(name, dflt) {
  const v = input(name, dflt ? "true" : "false").toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/** Outputs go to the $GITHUB_OUTPUT file, not stdout. The heredoc form is
 *  required: a value containing a newline would otherwise corrupt the file and
 *  every later output in the same step. */
function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  const text = value === undefined || value === null ? "" : String(value);
  if (!file) {
    console.log(`(no GITHUB_OUTPUT) ${name}=${text}`);
    return;
  }
  const delim = `ghadelim_${Math.random().toString(36).slice(2)}`;
  fs.appendFileSync(file, `${name}<<${delim}\n${text}\n${delim}\n`, "utf8");
}

const log = (msg) => console.log(msg);
const notice = (msg) => console.log(`::notice::${msg}`);
const warn = (msg) => console.log(`::warning::${msg}`);

function fail(msg) {
  console.log(`::error::${msg}`);
  process.exit(1);
}

/** Keep the key out of the log even if an error echoes a URL or header. */
function mask(secret) {
  if (secret) console.log(`::add-mask::${secret}`);
}

/* --------------------------------------------------------------------- http */

const BASE = input("base-url", "https://api.best-tempmail.com/v1").replace(/\/+$/, "");
const KEY = input("api-key");

async function api(method, path, body) {
  const headers = { Accept: "application/json" };
  if (KEY) headers["x-api-key"] = KEY;
  if (body) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    fail(`Could not reach ${BASE}: ${err.message}`);
  }

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json; the status and raw text below are what matter */
  }
  return { status: res.status, json, text };
}

/** Explains the status rather than printing a bare number, because an Action
 *  log is often the only thing a user sees. */
function describe(res, what) {
  const err = (res.json && (res.json.error || res.json.message)) || res.text.slice(0, 200);
  if (res.status === 401) {
    return `${what}: the API key was rejected (401). Check the secret is set and current.`;
  }
  if (res.status === 402) {
    return (
      `${what}: this needs a paid plan (402). ` +
      `See https://best-tempmail.com/api/pricing`
    );
  }
  if (res.status === 429) {
    return (
      `${what}: rate limited or out of quota (429). ` +
      `On the free tier that is 3 inboxes per day per IP, and a CI runner's IP ` +
      `is shared with every other job on it, so use an API key.`
    );
  }
  return `${what}: HTTP ${res.status}. ${err}`;
}

/* ---------------------------------------------------------------- operations */

async function create() {
  const body = {};
  const domain = input("domain");
  const lifetime = input("lifetime-minutes");
  if (domain) body.domain = domain;
  if (lifetime) {
    if (!/^\d+$/.test(lifetime)) fail(`lifetime-minutes must be a whole number, got "${lifetime}"`);
    body.lifetime_minutes = Number(lifetime);
  }

  const res = await api("POST", "/inboxes", Object.keys(body).length ? body : undefined);
  if (res.status !== 200 && res.status !== 201) fail(describe(res, "Could not create an inbox"));

  const address = res.json && res.json.address;
  if (!address) fail(`Inbox created but no address came back: ${res.text.slice(0, 200)}`);

  setOutput("address", address);
  setOutput("expires-at", (res.json && res.json.expires_at) || "");
  log(`Created inbox ${address}`);
  if (res.json && res.json.note) warn(res.json.note);
}

/**
 * Wait for a message.
 *
 * Two strategies, because the API offers a cheap one that cannot filter:
 *
 *  - No filter: GET /wait long-polls and returns as soon as mail lands. One
 *    request for the whole wait.
 *  - With a filter: poll the message listing with ?subject= / ?from=, because
 *    /wait would return on the first message to arrive whether or not it is
 *    the one being waited for. In a CI run that matters: a welcome email can
 *    beat the verification email by a second.
 */
async function waitForMail() {
  const address = input("address");
  if (!address) fail("operation: wait needs an address. Pass the output of the create step.");

  const timeout = Number(input("timeout", "60"));
  if (!Number.isFinite(timeout) || timeout < 1) fail(`timeout must be a positive number of seconds`);

  const subjectFilter = input("subject-contains").toLowerCase();
  const fromFilter = input("from-contains").toLowerCase();
  const filtered = Boolean(subjectFilter || fromFilter);

  const deadline = Date.now() + timeout * 1000;
  const enc = encodeURIComponent(address);
  let message = null;

  if (filtered) {
    log(
      `Waiting up to ${timeout}s for a message to ${address}` +
        (subjectFilter ? `, subject containing "${subjectFilter}"` : "") +
        (fromFilter ? `, from containing "${fromFilter}"` : "")
    );
    const qs = [];
    if (subjectFilter) qs.push(`subject=${encodeURIComponent(subjectFilter)}`);
    if (fromFilter) qs.push(`from=${encodeURIComponent(fromFilter)}`);
    const query = qs.length ? `?${qs.join("&")}` : "";

    while (Date.now() < deadline && !message) {
      const res = await api("GET", `/inboxes/${enc}/messages${query}`);
      if (res.status !== 200) fail(describe(res, "Could not list messages"));
      const list = (res.json && res.json.messages) || [];
      if (list.length) message = list[0];
      else await sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
    }
  } else {
    log(`Waiting up to ${timeout}s for any message to ${address}`);

    /* Check what is ALREADY there before long-polling.
     *
     * /wait signals mail ARRIVING. A message that landed before this step
     * started is invisible to it. In CI the natural order is: create the
     * inbox, trigger the signup, then wait, and the email frequently wins
     * that race, so the step would sit there until it timed out while the
     * message was in the inbox the whole time.
     *
     * Verified against the live API on 17 Nov 2026: /wait returns new mail in
     * about one second, and does not return mail that arrived earlier. The
     * filtered branch above never had this problem because it polls the
     * listing. 21 mocked tests missed it, because the mock returned a message
     * from /wait whenever asked and so assumed exactly what needed proving. */
    const existing = await api("GET", `/inboxes/${enc}/messages?limit=1`);
    if (existing.status !== 200) fail(describe(existing, "Could not list messages"));
    const already = (existing.json && existing.json.messages) || [];
    if (already.length) {
      message = already[0];
      log("A message was already waiting in the inbox");
    }

    /* The API caps a single wait at 55s, so loop until the deadline rather
     * than asking for more than it will give. */
    while (Date.now() < deadline && !message) {
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      const slice = Math.max(1, Math.min(50, remaining));
      const res = await api("GET", `/inboxes/${enc}/wait?timeout=${slice}`);
      if (res.status !== 200) fail(describe(res, "Could not wait for a message"));
      if (res.json && res.json.timed_out === true) continue;
      message =
        (res.json && res.json.message) ||
        (res.json && Array.isArray(res.json.messages) && res.json.messages[0]) ||
        null;
      if (!message && res.json && res.json.id) message = res.json;
    }
  }

  if (!message) {
    setOutput("found", "false");
    setOutput("message-id", "");
    setOutput("subject", "");
    setOutput("from", "");
    setOutput("otp", "");
    setOutput("action-url", "");
    const msg = `No matching message arrived within ${timeout}s.`;
    if (bool("fail-if-no-mail", true)) fail(msg);
    warn(`${msg} Continuing because fail-if-no-mail is false.`);
    return;
  }

  const id = message.id;
  setOutput("found", "true");
  setOutput("message-id", id || "");
  setOutput("subject", message.subject || "");
  setOutput("from", message.from || "");
  log(`Got "${message.subject || "(no subject)"}" from ${message.from || "(unknown)"}`);

  /* The code and the link are separate paid endpoints. A free key gets 402
   * here, which is not a failure of the step: the message still arrived and
   * the caller may only have wanted that. Warn once and leave them empty. */
  let paidRefused = false;

  const otpRes = await api("GET", `/inboxes/${enc}/messages/${id}/otp`);
  if (otpRes.status === 200) {
    const code = (otpRes.json && (otpRes.json.otp || otpRes.json.code)) || "";
    setOutput("otp", code);
    if (code) log(`Found a verification code`);
    else log(`No verification code in this message`);
  } else if (otpRes.status === 402) {
    paidRefused = true;
    setOutput("otp", "");
  } else {
    setOutput("otp", "");
    warn(describe(otpRes, "Could not extract an OTP"));
  }

  const linkRes = await api("GET", `/inboxes/${enc}/messages/${id}/links`);
  if (linkRes.status === 200) {
    const url = (linkRes.json && linkRes.json.action_url) || "";
    setOutput("action-url", url);
    if (url) log(`Found a call to action (confidence: ${linkRes.json.confidence})`);
    else log(`No clear call to action in this message`);
  } else if (linkRes.status === 402) {
    paidRefused = true;
    setOutput("action-url", "");
  } else {
    setOutput("action-url", "");
    warn(describe(linkRes, "Could not extract links"));
  }

  if (paidRefused) {
    warn(
      "The otp and action-url outputs need a paid plan, so they are empty. " +
        "The message itself arrived and message-id, subject and from are set. " +
        "See https://best-tempmail.com/api/pricing"
    );
  }

  /* The code is deliberately NOT masked. It is a throwaway value for a
   * throwaway inbox, and masking it would replace it with *** in exactly the
   * logs someone reads to work out why their test failed. */
}

async function remove() {
  const address = input("address");
  if (!address) fail("operation: delete needs an address.");
  const res = await api("DELETE", `/inboxes/${encodeURIComponent(address)}`);
  if (res.status !== 200 && res.status !== 204 && res.status !== 404) {
    fail(describe(res, "Could not delete the inbox"));
  }
  log(res.status === 404 ? `Inbox ${address} was already gone` : `Deleted ${address}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------------- main */

(async function main() {
  mask(KEY);
  if (!KEY) {
    warn(
      "No api-key given, so the free tier applies: 3 inboxes per day per IP, " +
        "and no otp or action-url outputs. A CI runner's IP is shared, so that " +
        "quota is often already gone. Pass ${{ secrets.BEST_TEMPMAIL_KEY }}."
    );
  }

  const op = input("operation", "create").toLowerCase();
  if (op === "create") await create();
  else if (op === "wait") await waitForMail();
  else if (op === "delete") await remove();
  else fail(`Unknown operation "${op}". Use create, wait, or delete.`);
})().catch((err) => fail(err && err.stack ? err.stack : String(err)));
