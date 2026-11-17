# Jupiter fixtures

`jupiter-order.json` is a trimmed live keyless `/swap/v2/order` preview response (USDC → JUP, 10 USDC, 50 bps); route plan and USD metadata are omitted. `jupiter-execute-failed.json` is the recorded HTTP 400 response to an invalid, non-transaction payload. No funds or live signatures were used.

`jupiter-execute-success.json` is a synthetic success fixture matching the current Jupiter V2 documentation, not a live funded execution. Build tests enrich the recorded preview with synthetic wallet/payer addresses and transaction bytes and use a fake FeeSponsor. They do not validate onchain instructions; that belongs to the concrete sponsor's tests.
