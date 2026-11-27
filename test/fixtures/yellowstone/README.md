# Recorded Yellowstone decoder fixtures

These are genuine finalized transaction records from the public
`https://api.mainnet-beta.solana.com` JSON-RPC on 2026-11-27. The
`rpc` field contains the unmodified `getTransaction` result or the
`getBlock` transaction entry with the enclosing slot and block time
added. The `transactionIndex` field is the position in the block or the
index reported by `getSignaturesForAddress`.

Fetch a record by signature using `getTransaction` with
`encoding: "json"`, `maxSupportedTransactionVersion: 1`, and
`commitment: "finalized"`. To cross-check its index, fetch `getBlock`
with the same parameters and look up the signature in the transactions
array. The test adapter converts the recorded Solana RPC fields into the
matching protobuf fields; the HTTP/2 test uses synthetic stream
coordinates around recorded transaction bodies.

| Fixture | Slot | Transaction index | Signature |
| --- | ---: | ---: | --- |
| `meteora-damm-v1` | 474658827 | 93 | `57AKKweUQeKbumDT1qncpW8ovHXde21evRaeLKhYNbKhuVsbvd2ehTk3UoGC8eb2XJGTxfPJLdt4FsiyzYypg4BK` |
| `meteora-damm-v2` | 474658674 | 25 | `2HUoRP39UR2B4LV7cRPq3r1BTkKpL85ehmA7tkQiPJKuVuH6WPZN1GBdkFvLazngAR2GfddUJ3KKHXqk7FAYqdnx` |
| `meteora-dlmm` | 474658667 | 251 | `2TzzrvwHsPmjxQucGryYBLpUQXg8YibnzhcsdDC68z3eBcZaKscEDnE2BZCGTD3iZfQGEJmeiwzPT9qiHBWnK2Cd` |
| `pump-launch` | 474658562 | 11 | `uMFkLx8Saj3Whqfu2ne48VS9irpd8jGBTAxdKZNsrZt7ryJbXcTBWzgqMDoUSgZRxUPV1HUFCmD1MzhEa4D9Uf6` |
| `pump-migrate-noop` | 474659093 | 19 | `54q4Z6iLqUkqwBhnMhK247entWoaeSb1afYJx8s2cfVfGzUo3b8PATF3aDnmaq6ckTEP3F7PX2HM4hZ54B8hBWRL` |
| `pump-migrate` | 474659087 | 143 | `meB2qEuWEcMCL2PkPhfZYbHvBfsuH8id7mq8LnSZK34uNxkbJYnAtoBMagCHc2arHPTdGnNsEZSBtbHXbT4NrNo` |
| `pump-trade` | 474658564 | 399 | `2mtMntYreDGANaKikHEim7MYvHvfsgCyKP84dNyKUx55ToDQtvRzQNyESXqFKMkEvdoiZhPY6anpRu4QFzVNJzQM` |
| `pumpswap` | 474658674 | 330 | `w6XRyP5bXfc2qmoBwWiYSqrNwkNfRCDVoiUuUujQ4yL4tAZNGxScKNc54dk7EdCBVaRK8hNWAhB98n4iN6yWop4` |
| `raydium-clmm` | 474658667 | 24 | `3ttkjQ8t18ybvwpuwbSZdcUihMYnDt4NgiofsWrYwgicJd2X8yzS2xahQCLUbbJeSbYqw4HiqcuCUPkFd8KtcXvc` |
| `raydium-cpmm` | 474658652 | 5 | `2x65NVtdjbMCrRUs43z7W7iiCj1SJCGhsGAN2t15rGqzDxeKa5gtm3BW9YexDuxgivyU41uwz6Aw9Ge2Bc5vbpGh` |
| `raydium-v4` | 474658562 | 66 | `26EwNvjiA1afCTNkd6kYbVixRrVLyipKUCcF9oykWSkDueviMUKQ9mFYjU2exGj3poLWYeeDzgUhM5p3riWskmK9` |
