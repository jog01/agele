import { describe, expect, it } from "bun:test";
import {
  AccountRole,
  address,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  getAddressEncoder,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  verifySignature,
} from "@solana/kit";
import { PROGRAMS } from "../src/services/sponsor/programs";
import { SWAP_MINTS_V01 as MINTS } from "../src/services/sponsor/swap-mints";
import { ValidatedFeeSponsor } from "../src/services/sponsor/validated-fee-sponsor";
import { SponsorValidator } from "../src/services/sponsor/validator";
import { encode, ix, meta, numeric, sponsorSetup, token } from "./sponsor-helpers";

describe("FeeSponsor policy §7", () => {
  it("registers a realistic order-shaped v0 route, verifies the user, signs once and produces a valid payer signature", async () => {
    const s = await sponsorSetup();
    expect(await s.sponsor.register(s.encoded(), s.context)).toEqual({ expiresAt: 1_030_000 });
    const signed = await s.sponsor.cosign(await s.signUser(), {
      userId: "user",
      requestId: s.context.requestId,
    });
    const transaction = getTransactionDecoder().decode(Buffer.from(signed, "base64"));
    expect(
      await verifySignature(
        await getPublicKeyFromAddress(s.payer),
        transaction.signatures[s.payer]!,
        transaction.messageBytes,
      ),
    ).toBe(true);
    expect(
      await verifySignature(
        await getPublicKeyFromAddress(s.wallet),
        transaction.signatures[s.wallet]!,
        transaction.messageBytes,
      ),
    ).toBe(true);
    expect(s.rpc.simulations).toBe(2);
    await expect(
      s.sponsor.cosign(await s.signUser(), { userId: "user", requestId: s.context.requestId }),
    ).rejects.toMatchObject({ reason: "record_used" });
    expect(s.store.charges).toHaveLength(1);
    expect(JSON.stringify([...s.store.records.values()])).not.toContain(signed);
  });
  const attacks: [string, string, (s: Awaited<ReturnType<typeof sponsorSetup>>) => ReturnType<typeof ix>][] =
    [
      [
        "fee-payer System transfer",
        "instruction_not_allowed",
        (s) => {
          const d = new Uint8Array(12);
          new DataView(d.buffer).setUint32(0, 2, true);
          new DataView(d.buffer).setBigUint64(4, 1n, true);
          return ix(
            PROGRAMS.system,
            [meta(s.payer, AccountRole.WRITABLE_SIGNER), meta(s.wallet, AccountRole.WRITABLE)],
            d,
          );
        },
      ],
      [
        "fee-payer token authority",
        "fee_payer_role",
        (s) =>
          ix(
            PROGRAMS.token,
            [
              meta(s.source, AccountRole.WRITABLE),
              meta(s.destination, AccountRole.WRITABLE),
              meta(s.payer, AccountRole.READONLY_SIGNER),
            ],
            numeric(3, 1n),
          ),
      ],
      [
        "extra fee-payer account to Jupiter",
        "fee_payer_role",
        (s) => ({ ...s.route, accounts: [...s.route.accounts!, meta(s.payer, AccountRole.WRITABLE_SIGNER)] }),
      ],
      [
        "persistent ATA close to user",
        "instruction_not_allowed",
        (s) =>
          ix(
            PROGRAMS.token,
            [
              meta(s.destination, AccountRole.WRITABLE),
              meta(s.wallet, AccountRole.WRITABLE),
              meta(s.wallet, AccountRole.READONLY_SIGNER),
            ],
            new Uint8Array([9]),
          ),
      ],
      ["unknown program", "program_not_allowed", (s) => ix(s.extra, [])],
      [
        "nonce",
        "nonce",
        (s) => {
          const d = new Uint8Array(4);
          d[0] = 4;
          return ix(
            PROGRAMS.system,
            [meta(s.extra, AccountRole.WRITABLE), meta(s.wallet, AccountRole.READONLY_SIGNER)],
            d,
          );
        },
      ],
      [
        "fee payer in Memo",
        "fee_payer_role",
        (s) => ix(PROGRAMS.memo, [meta(s.payer, AccountRole.WRITABLE_SIGNER)]),
      ],
      [
        "third signer",
        "signature_cap",
        (s) => ix(PROGRAMS.memo, [meta(s.extra, AccountRole.READONLY_SIGNER)]),
      ],
    ];
  for (const [name, reason, build] of attacks)
    it(`rejects ${name} before issuing/signing`, async () => {
      const s = await sponsorSetup();
      await expect(
        s.sponsor.register(s.encoded([build(s), ...s.compute, s.route]), s.context),
      ).rejects.toMatchObject({ reason });
      expect(s.store.records.size).toBe(0);
      expect(s.store.charges).toHaveLength(0);
      expect(s.rpc.simulations).toBe(0);
    });
  it("rejects fee-payer ATA rent farming followed by close to user", async () => {
    const s = await sponsorSetup();
    s.rpc.state.delete(s.destination);
    const create = ix(
      PROGRAMS.ata,
      [
        meta(s.payer, AccountRole.WRITABLE_SIGNER),
        meta(s.destination, AccountRole.WRITABLE),
        meta(s.wallet),
        meta(MINTS.JUP),
        meta(PROGRAMS.system),
        meta(PROGRAMS.token),
      ],
      new Uint8Array([1]),
    );
    const close = ix(
      PROGRAMS.token,
      [
        meta(s.destination, AccountRole.WRITABLE),
        meta(s.wallet, AccountRole.WRITABLE),
        meta(s.wallet, AccountRole.READONLY_SIGNER),
      ],
      new Uint8Array([9]),
    );
    await expect(
      s.sponsor.register(s.encoded([...s.compute, create, s.route, close]), s.context),
    ).rejects.toMatchObject({ reason: "instruction_not_allowed" });
    expect(s.rpc.simulations).toBe(0);
  });
  for (const [space, owner] of [
    [166n, PROGRAMS.token],
    [165n, PROGRAMS.system],
  ] as const)
    it(`rejects CreateAccount ${space}/${owner}`, async () => {
      const s = await sponsorSetup(),
        data = new Uint8Array(52),
        view = new DataView(data.buffer);
      view.setBigUint64(4, 2_039_280n, true);
      view.setBigUint64(12, space, true);
      data.set(getAddressEncoder().encode(address(owner)), 20);
      await expect(
        s.sponsor.register(
          s.encoded([
            ...s.compute,
            ix(
              PROGRAMS.system,
              [meta(s.payer, AccountRole.WRITABLE_SIGNER), meta(s.extra, AccountRole.WRITABLE)],
              data,
            ),
            s.route,
          ]),
          s.context,
        ),
      ).rejects.toMatchObject({ reason: "instruction_not_allowed" });
      expect(s.rpc.simulations).toBe(0);
    });
  for (const mode of [
    "price",
    "total",
    "duplicate-limit",
    "duplicate-price",
    "missing-limit",
    "limit-cap",
  ] as const)
    it(`rejects compute/fee ${mode}`, async () => {
      const s = await sponsorSetup();
      const compute =
        mode === "price"
          ? [s.compute[0]!, ix(PROGRAMS.compute, [], numeric(3, 2_000_001n))]
          : mode === "total"
            ? [s.compute[0]!, ix(PROGRAMS.compute, [], numeric(3, 200_000n))]
            : mode === "limit-cap"
              ? [ix(PROGRAMS.compute, [], numeric(2, 1_400_001n, 5))]
              : mode === "missing-limit"
                ? [s.compute[1]!]
                : [...s.compute, s.compute[mode === "duplicate-limit" ? 0 : 1]!];
      const sponsor =
        mode === "total" ? new ValidatedFeeSponsor({ ...s.options, maxLamports: 10_000n }) : s.sponsor;
      await expect(sponsor.register(s.encoded([...compute, s.route]), s.context)).rejects.toMatchObject({
        reason: "fee_cap",
      });
      expect(s.rpc.simulations).toBe(0);
    });
  for (const extension of [14, 12, 1, 4, 6, 9])
    it(`rejects Token-2022 extension ${extension}`, async () => {
      const s = await sponsorSetup(),
        mint = s.rpc.state.get(MINTS.JUP)!;
      mint.owner = PROGRAMS.token2022;
      mint.data = new Uint8Array(171);
      mint.data[165] = 1;
      new DataView(mint.data.buffer).setUint16(166, extension, true);
      new DataView(mint.data.buffer).setUint16(168, 1, true);
      await expect(s.sponsor.register(s.encoded(), s.context)).rejects.toMatchObject({
        reason: "token_extension",
      });
      expect(s.rpc.simulations).toBe(0);
    });
  it("resolves ALT accounts and rejects an ALT-loaded unknown program", async () => {
    const s = await sponsorSetup(),
      lookup = MINTS.BONK,
      unknown = address(MINTS.PYTH);
    const message = getCompiledTransactionMessageDecoder().decode(s.transaction().messageBytes);
    if (message.version !== 0) throw new Error("v0 fixture required");
    const data = new Uint8Array(88);
    data[0] = 1;
    new DataView(data.buffer).setBigUint64(4, 18446744073709551615n, true);
    data.set(getAddressEncoder().encode(unknown), 56);
    s.rpc.state.set(lookup, { owner: PROGRAMS.lookup, lamports: 1n, data, executable: false });
    const messageBytes = getCompiledTransactionMessageEncoder().encode({
      ...message,
      addressTableLookups: [
        { lookupTableAddress: address(lookup), writableIndexes: [], readonlyIndexes: [0] },
      ],
      instructions: [...message.instructions, { programAddressIndex: message.staticAccounts.length }],
    });
    const transaction = s.transaction();
    const malicious = encode({
      ...transaction,
      messageBytes: messageBytes as typeof transaction.messageBytes,
    });
    await expect(s.sponsor.register(malicious, s.context)).rejects.toMatchObject({
      reason: "program_not_allowed",
    });
    expect(s.rpc.simulations).toBe(0);
  });
  it("accepts a legitimate ALT and fails closed for missing, corrupt or fee-payer-loaded tables", async () => {
    const s = await sponsorSetup(),
      table = MINTS.BONK;
    const compressed = compressTransactionMessageUsingAddressLookupTables(s.message(), {
      [address(table)]: [address(s.source), address(s.destination)],
    });
    const data = new Uint8Array(120);
    data[0] = 1;
    new DataView(data.buffer).setBigUint64(4, 18446744073709551615n, true);
    data.set(getAddressEncoder().encode(s.source), 56);
    data.set(getAddressEncoder().encode(s.destination), 88);
    s.rpc.state.set(table, { owner: PROGRAMS.lookup, lamports: 1n, data, executable: false });
    expect(
      (await s.validator.validate(encode(compileTransaction(compressed)), s.context)).addresses,
    ).toContain(s.source);
    s.rpc.state.get(table)!.data.set(getAddressEncoder().encode(s.payer), 56);
    await expect(
      s.validator.validate(encode(compileTransaction(compressed)), s.context),
    ).rejects.toMatchObject({ reason: "fee_payer_role" });
    s.rpc.state.delete(table);
    await expect(
      s.validator.validate(encode(compileTransaction(compressed)), s.context),
    ).rejects.toMatchObject({ reason: "lookup_table" });
  });
  for (const mode of [
    "changed-byte",
    "unsigned",
    "invalid-signature",
    "wrong-owner",
    "expired",
    "blockheight",
    "concurrent",
  ] as const)
    it(`enforces issued record ${mode}`, async () => {
      const s = await sponsorSetup();
      await s.sponsor.register(s.encoded(), s.context);
      let signed = await s.signUser();
      let userId = "user";
      if (mode === "changed-byte") {
        const tx = s.transaction(),
          bytes = new Uint8Array(tx.messageBytes);
        bytes[bytes.length - 1]! ^= 1;
        signed = encode({ ...tx, messageBytes: bytes as unknown as typeof tx.messageBytes });
      }
      if (mode === "unsigned") signed = s.encoded();
      if (mode === "invalid-signature") {
        const tx = getTransactionDecoder().decode(Buffer.from(signed, "base64"));
        const signature = new Uint8Array(tx.signatures[s.wallet]!);
        signature[0]! ^= 1;
        signed = encode({
          ...tx,
          signatures: {
            ...tx.signatures,
            [s.wallet]: signature as NonNullable<(typeof tx.signatures)[typeof s.wallet]>,
          },
        });
      }
      if (mode === "wrong-owner") userId = "other";
      if (mode === "expired") s.setNow(1_030_001);
      if (mode === "blockheight") s.rpc.height = 201;
      const ctx = { userId, requestId: s.context.requestId };
      if (mode === "concurrent") {
        const results = await Promise.allSettled([
          s.sponsor.cosign(signed, ctx),
          s.sponsor.cosign(signed, ctx),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(results.find((r) => r.status === "rejected")).toMatchObject({
          reason: { reason: "record_used" },
        });
      } else {
        await expect(s.sponsor.cosign(signed, ctx)).rejects.toMatchObject({
          reason:
            mode === "wrong-owner"
              ? "record_missing"
              : ["expired", "blockheight"].includes(mode)
                ? "record_expired"
                : "message_mismatch",
        });
        expect(s.store.charges).toHaveLength(0);
      }
    });
  for (const mode of ["error", "payer", "input", "output", "other-token", "sol"] as const)
    it(`rejects simulation ${mode} without signing`, async () => {
      const s = await sponsorSetup();
      await s.sponsor.register(s.encoded(), s.context);
      const original = s.rpc.mutate;
      if (mode === "other-token") s.rpc.state.set(s.extra, token(MINTS.BONK, s.wallet, 100n));
      s.rpc.mutate = (accounts, addresses) => {
        original(accounts, addresses);
        if (mode === "payer") accounts[addresses.indexOf(s.payer)]!.lamports -= 1n;
        if (mode === "input")
          new DataView(accounts[addresses.indexOf(s.source)]!.data.buffer).setBigUint64(64, 0n, true);
        if (mode === "output")
          new DataView(accounts[addresses.indexOf(s.destination)]!.data.buffer).setBigUint64(64, 0n, true);
        if (mode === "other-token")
          new DataView(accounts[addresses.indexOf(s.extra)]!.data.buffer).setBigUint64(64, 0n, true);
        if (mode === "sol") accounts[addresses.indexOf(s.wallet)]!.lamports -= 1n;
      };
      if (mode === "error") s.rpc.error = { InstructionError: [2, "Custom"] };
      await expect(
        s.sponsor.cosign(await s.signUser(), { userId: "user", requestId: s.context.requestId }),
      ).rejects.toMatchObject({ reason: "simulation" });
      expect(s.store.records.get(s.context.requestId)!.state).toBe("signing");
    });
  it("rejects withdrawal, JupiterZ, malformed and oversized transactions", async () => {
    const s = await sponsorSetup();
    await expect(s.sponsor.register(s.encoded(), { ...s.context, kind: "withdraw" })).rejects.toMatchObject({
      reason: "instruction_not_allowed",
    });
    await expect(
      s.sponsor.register(s.encoded(), { ...s.context, swap: { ...s.context.swap!, router: "jupiterz" } }),
    ).rejects.toMatchObject({ reason: "instruction_not_allowed" });
    for (const bytes of ["!", Buffer.alloc(1233).toString("base64"), "AQ=="])
      await expect(s.sponsor.register(bytes, s.context)).rejects.toMatchObject({ reason: "malformed" });
  });
  it("checks current blockhash, mint allowlist, payer ownership and mint cache TTL", async () => {
    const s = await sponsorSetup();
    s.rpc.valid = false;
    await expect(s.validator.validate(s.encoded(), s.context)).rejects.toMatchObject({ reason: "blockhash" });
    s.rpc.valid = true;
    await expect(
      s.validator.validate(s.encoded(), { ...s.context, swap: { ...s.context.swap!, inputMint: s.extra } }),
    ).rejects.toMatchObject({ reason: "mint_not_allowed" });
    s.rpc.state.set(s.extra, token(MINTS.JUP, s.payer, 1n));
    await expect(s.validator.validate(s.encoded(), s.context)).rejects.toMatchObject({
      reason: "fee_payer_role",
    });
    const mint = s.rpc.state.get(MINTS.JUP)!;
    mint.owner = PROGRAMS.system;
    const validator = new SponsorValidator(s.rpc, s.payer, undefined, () => 20_000);
    await expect(validator.validate(s.encoded(), s.context)).rejects.toMatchObject({
      reason: "token_extension",
    });
  });
  it("loads JSON/base58 64-byte secrets and refuses mismatches or malformed secrets", async () => {
    const s = await sponsorSetup();
    await expect(
      new ValidatedFeeSponsor({ ...s.options, secret: JSON.stringify([...s.secretBytes]) }).ready(),
    ).resolves.toBeUndefined();
    await expect(
      new ValidatedFeeSponsor({ ...s.options, secret: getBase58Decoder().decode(s.secretBytes) }).ready(),
    ).resolves.toBeUndefined();
    for (const secret of ["[]", "[256]", "x", JSON.stringify(Array(64).fill(-1))])
      await expect(new ValidatedFeeSponsor({ ...s.options, secret }).ready()).rejects.toThrow(
        "Fee-payer signer initialization failed",
      );
    await expect(
      new ValidatedFeeSponsor({
        ...s.options,
        secret: getBase58Decoder().decode(s.secretBytes),
        feePayer: s.wallet,
      }).ready(),
    ).rejects.toThrow("Fee-payer signer initialization failed");
  });
  it("accepts legacy swaps and validates every pinned program address", async () => {
    const s = await sponsorSetup();
    for (const program of Object.values(PROGRAMS)) expect(String(address(program))).toBe(program);
    const transaction = compileTransaction({ ...s.message(), version: "legacy" });
    await s.sponsor.register(encode(transaction), s.context);
    const signed = await s.sponsor.cosign(await s.signUser(transaction), {
      userId: "user",
      requestId: s.context.requestId,
    });
    expect(getTransactionDecoder().decode(Buffer.from(signed, "base64")).signatures[s.payer]).not.toBeNull();
  });
  it("rechecks expiry after a slow simulation, and rejects missing records", async () => {
    const s = await sponsorSetup();
    await expect(
      s.sponsor.cosign(s.encoded(), { userId: "user", requestId: "missing" }),
    ).rejects.toMatchObject({ reason: "record_missing" });
    await s.sponsor.register(s.encoded(), s.context);
    const mutate = s.rpc.mutate;
    s.rpc.mutate = (accounts, addresses) => {
      mutate(accounts, addresses);
      s.setNow(1_030_000);
    };
    await expect(
      s.sponsor.cosign(await s.signUser(), { userId: "user", requestId: s.context.requestId }),
    ).rejects.toMatchObject({ reason: "record_expired" });
  });
  it("refreshes mint extensions after the short cache TTL", async () => {
    const s = await sponsorSetup();
    let now = 0;
    const validator = new SponsorValidator(s.rpc, s.payer, undefined, () => now);
    await validator.validate(s.encoded(), s.context);
    s.rpc.state.get(MINTS.JUP)!.owner = PROGRAMS.system;
    await expect(validator.validate(s.encoded(), s.context)).resolves.toBeDefined();
    now = 10_000;
    await expect(validator.validate(s.encoded(), s.context)).rejects.toMatchObject({
      reason: "token_extension",
    });
  });
  for (const kind of [0, 4, 5, 6, 7, 8, 10, 11])
    it(`rejects banned token instruction ${kind}`, async () => {
      const s = await sponsorSetup();
      await expect(
        s.sponsor.register(
          s.encoded([
            ...s.compute,
            ix(PROGRAMS.token, [meta(s.wallet, AccountRole.READONLY_SIGNER)], new Uint8Array([kind])),
            s.route,
          ]),
          s.context,
        ),
      ).rejects.toMatchObject({ reason: "instruction_not_allowed" });
      expect(s.rpc.simulations).toBe(0);
    });
});
