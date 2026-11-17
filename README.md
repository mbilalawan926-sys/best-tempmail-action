# best-tempmail GitHub Action

Test a signup flow in CI. Create a disposable inbox, wait for the email, and get the
verification code and the link to click as step outputs.

No polling loops, no inbox left behind, no dependencies.

```yaml
- uses: mbilalawan926-sys/best-tempmail-action@v1
  id: inbox
  with:
    api-key: ${{ secrets.BEST_TEMPMAIL_KEY }}

- name: Sign up with the throwaway address
  run: ./scripts/signup.sh "${{ steps.inbox.outputs.address }}"

- uses: mbilalawan926-sys/best-tempmail-action@v1
  id: mail
  with:
    api-key: ${{ secrets.BEST_TEMPMAIL_KEY }}
    operation: wait
    address: ${{ steps.inbox.outputs.address }}
    subject-contains: verify

- name: Finish the signup
  run: ./scripts/confirm.sh "${{ steps.mail.outputs.otp }}" "${{ steps.mail.outputs.action-url }}"
```

## Why this instead of a few curl calls

**It waits properly.** With no filter it uses the API's long-poll endpoint, so one request
covers the whole wait rather than a sleep-and-retry loop burning quota.

**It finds mail that already arrived.** Long-polling signals mail *arriving*, so a naive wait
misses an email that landed before the step started, and in CI that is the common case: you
create the inbox, trigger the signup, and the email often wins the race. This checks the inbox
first and returns immediately if the message is already there.

**It waits for the right email.** Give it `subject-contains` or `from-contains` and it matches
on those instead of taking whatever arrives first. In CI that matters: a welcome email often
beats the verification email by a second, and a naive wait hands you the wrong one.

**It fails when nothing arrives.** By default, no email means a failed step. A test that
quietly passes because it never received anything is worse than a red build.

**It gets the code and the link out for you.** `otp` is extracted from the message, and
`action-url` is the link the email actually wants clicked rather than the first URL in the body
(which is usually the logo).

## Inputs

| Input | Default | Notes |
|---|---|---|
| `api-key` | | Your API key. Use a repository secret. See the free tier note below. |
| `operation` | `create` | `create`, `wait`, or `delete`. |
| `domain` | | `create`: put the inbox on a specific domain. |
| `lifetime-minutes` | | `create`: how long it lives, capped by your plan. |
| `address` | | `wait` and `delete`: which inbox. |
| `timeout` | `60` | `wait`: seconds before giving up. |
| `subject-contains` | | `wait`: only match a subject containing this. |
| `from-contains` | | `wait`: only match a sender containing this. |
| `fail-if-no-mail` | `true` | `wait`: fail the step when nothing arrives. |

## Outputs

| Output | From | Notes |
|---|---|---|
| `address` | `create` | The inbox address. |
| `expires-at` | `create` | When it expires. |
| `found` | `wait` | `true` or `false`. |
| `message-id` | `wait` | |
| `subject` | `wait` | |
| `from` | `wait` | |
| `otp` | `wait` | The verification code, or empty if the message had none. Paid plans. |
| `action-url` | `wait` | The link to click, or empty if there was no clear one. Paid plans. |

## The free tier, and why you want a key

Without `api-key` the free tier applies: **3 inboxes per day per IP**, and the `otp` and
`action-url` outputs are not included.

That per-IP limit is the catch on a hosted runner. GitHub's runners share addresses across
enormous numbers of jobs, so the free quota for "your" IP is usually long gone before your
workflow starts. Use a key.

## Clean up after yourself

Inboxes expire on their own, but deleting them keeps your account tidy and your quota free:

```yaml
- uses: mbilalawan926-sys/best-tempmail-action@v1
  if: always()
  with:
    api-key: ${{ secrets.BEST_TEMPMAIL_KEY }}
    operation: delete
    address: ${{ steps.inbox.outputs.address }}
```

`if: always()` so it runs even when the test above it failed. Deleting an inbox that has
already expired is not treated as an error, so this step cannot turn a green build red.

## Plus-addressing: one inbox, several signups

Mail to `user+anything@domain` arrives at `user@domain`, so a single inbox can cover a test
that registers with more than one service:

```yaml
- run: ./signup.sh "netflix" "${{ steps.inbox.outputs.address }}"   # use user+netflix@...
- uses: mbilalawan926-sys/best-tempmail-action@v1
  with:
    operation: wait
    address: ${{ steps.inbox.outputs.address }}
    from-contains: netflix
```

## Notes

The verification code is **not** masked in the log. It is a throwaway value for a throwaway
inbox, and masking it would replace it with `***` in exactly the log someone reads to work out
why a test failed.

This Action has no dependencies and no build step. It is a single `index.js` using Node 20's
built-in `fetch`, so there is no bundled `dist/` to go stale when the source changes.

## Licence

MIT.
