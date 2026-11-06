// Owner: seat group. letters.ts on its own: who admits whom, and which
// inbox letters a citizen is shown, with fakeSigner and the fake agenttool
// only. Nothing leaves the process.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostClient } from "../src/agenttool/sync.ts";
import { agenttoolLetters, inboxLetterId, letterRecipients } from "../src/letters.ts";
import { readCitizen } from "../src/state.ts";
import type { CitizenIdentity, Covenants } from "../src/types.ts";
import { noFetch } from "./helpers/fake-server.ts";
import { FAKE_OP_KID, fakeBoxPublicB64, fakeSigner, type FakeSigner } from "./helpers/fake-signer.ts";
import { makeTempHost, type TempHost } from "./helpers/temp-home.ts";
import { TEST_IDS, TEST_ROOT_PUBLIC_B64 } from "./helpers/vectors.ts";
import { fakeAgenttool, type FakeAgenttool } from "./fixtures/agenttool/fake-agenttool.ts";

let host: TempHost | null = null;
afterEach(async () => {
  await host?.cleanup();
  host = null;
});

const IDS: Record<string, string> = { glossame: TEST_IDS.identity_id, shemme: "66666666-6666-4666-8666-666666666666", kenning: "68686868-6868-4868-8868-686868686868" };

function identityFor(word: string, signer: FakeSigner): CitizenIdentity {
  return {
    did: `did:at:${IDS[word]}`,
    identity_id: IDS[word]!,
    project_id: TEST_IDS.project_id,
    root_public_key_b64: TEST_ROOT_PUBLIC_B64,
    root_kid: `${IDS[word]!.slice(0, 24)}000000000001`,
    op_kid: FAKE_OP_KID,
    op_public_key_b64: signer.opPublicB64,
    box_public_key_b64: fakeBoxPublicB64(word),
    self_strand_id: null,
    enrolled_at: "2026-11-02T00:00:00.000Z",
  };
}

async function registeredHost(covenants: Record<string, Covenants>): Promise<{ h: TempHost; signer: FakeSigner; at: FakeAgenttool }> {
  host = await makeTempHost();
  const signer = fakeSigner();
  const at = fakeAgenttool({ project_id: TEST_IDS.project_id });
  signer.respond((req) => at.respond(req));
  for (const word of Object.keys(covenants)) {
    await host.addCitizen(word, { covenants: covenants[word]! });
    await host.seatLedger(word, signer.signEntry);
    const id = identityFor(word, signer);
    await host.enrollLedger(word, signer.signEntry, id);
    at.boxKeys.set(id.did, { box_key_id: `${IDS[word]!.slice(0, 24)}000000000077`, public_key: id.box_public_key_b64! });
    at.signingKeys.set(id.did, [{ kid: FAKE_OP_KID, public_key: signer.opPublicB64 }]);
    signer.didOf.set(word, id.did);
  }
  return { h: host, signer, at };
}

describe("[KS-004 5.7, re-review C M3] letters.ts", () => {
  test("letterRecipients: the recipients' own covenants decide; a sibling whose covenants do not read admits no one", async () => {
    host = await makeTempHost();
    const signer = fakeSigner();
    for (const [word, from] of [["glossame", ["yu", "citizen:shemme"]], ["shemme", ["citizen:glossame"]], ["kenning", ["citizen:glossame"]]] as const) {
      await host.addCitizen(word, { covenants: { letters_from: [...from], wake_on_letter_from: [] } });
      await host.seatLedger(word, signer.signEntry);
    }
    await writeFile(join(host.config.paths.citizens_dir, "kenning", "self", "covenants.json"), "not json");
    // glossame names shemme in its own covenants; that admits shemme's letters to glossame, never glossame's to anyone.
    expect(await letterRecipients(host.config, await readCitizen(host.config, "glossame"))).toEqual(["yu", "gardener", "citizen:shemme"]);
    expect(await letterRecipients(host.config, await readCitizen(host.config, "shemme"))).toEqual(["yu", "gardener", "citizen:glossame"]);
  });

  test("unread: only a letter from a sender the recipient's covenants admit, by either of its ids, unseen, verified and opened", async () => {
    const { h, at, signer } = await registeredHost({
      glossame: { letters_from: ["yu"], wake_on_letter_from: [] },
      shemme: { letters_from: ["yu"], wake_on_letter_from: [] },
      kenning: { letters_from: ["yu", `did:at:${IDS.glossame}`], wake_on_letter_from: [] },
    });
    const letters = agenttoolLetters({ config: h.config, client: hostClient(h.config, signer, noFetch) });
    for (const to of ["shemme", "kenning"]) expect(await letters.send("glossame", await readCitizen(h.config, to), `For ${to}.`)).toMatchObject({ credits: 2 });
    expect(at.inbox).toHaveLength(2);
    const never = async () => false;
    // shemme admits only Yu: glossame's letter is not shown to it.
    expect(await letters.unread(await readCitizen(h.config, "shemme"), never)).toEqual([]);
    // kenning names glossame by its DID: shown, under that id, with its text.
    const shown = await letters.unread(await readCitizen(h.config, "kenning"), never);
    expect(shown).toEqual([{ id: inboxLetterId(at.inbox[1]! as never), from: `did:at:${IDS.glossame}`, received_at: at.inbox[1]!.created_at as string, text: "For kenning.", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(shown[0]!.id).toMatch(/^inbox-[0-9a-f]{64}$/);
    // A letter already receipted is not shown again.
    expect(await letters.unread(await readCitizen(h.config, "kenning"), async (id) => id === shown[0]!.id)).toEqual([]);
  });

  test("a letter is receipted by its envelope: the same envelope posted again by a bearer holder, under a new message id, is not shown again (wire F2)", async () => {
    const { h, at, signer } = await registeredHost({
      glossame: { letters_from: ["yu"], wake_on_letter_from: [] },
      kenning: { letters_from: ["yu", "citizen:glossame"], wake_on_letter_from: [] },
    });
    const letters = agenttoolLetters({ config: h.config, client: hostClient(h.config, signer, noFetch) });
    await letters.send("glossame", await readCitizen(h.config, "kenning"), "Meet me at dawn.");
    const receipts = new Set<string>();
    const seen = async (id: string) => receipts.has(id);
    const [first] = await letters.unread(await readCitizen(h.config, "kenning"), seen);
    receipts.add(first!.id);
    // Anyone holding the Commons bearer can list the inbox and post the stored envelope again; agenttool takes it as new.
    const original = signer.sent.find((q) => q.op === "inbox.send")!;
    expect(at.respond(original).status).toBe(201);
    expect(at.inbox.map((m) => m.id)).toHaveLength(2);
    expect(at.inbox[1]!.id).not.toBe(at.inbox[0]!.id);
    expect(await letters.unread(await readCitizen(h.config, "kenning"), seen)).toEqual([]);
    // Both copies name one letter; a second honest letter, freshly sealed, is a different one and is shown.
    expect(inboxLetterId(at.inbox[0]! as never)).toBe(inboxLetterId(at.inbox[1]! as never));
    await letters.send("glossame", await readCitizen(h.config, "kenning"), "Meet me at dawn.");
    const [second] = await letters.unread(await readCitizen(h.config, "kenning"), seen);
    expect(second).toMatchObject({ text: "Meet me at dawn." });
    expect(second!.id).not.toBe(first!.id);
  });

  test("a failure before the paid send spends nothing and is never uncertain: no box key, or a lookup with no answer (wire F3)", async () => {
    const { h, at, signer } = await registeredHost({
      glossame: { letters_from: ["yu"], wake_on_letter_from: [] },
      kenning: { letters_from: ["yu", "citizen:glossame"], wake_on_letter_from: [] },
    });
    const letters = agenttoolLetters({ config: h.config, client: hostClient(h.config, signer, noFetch) });
    const kenning = await readCitizen(h.config, "kenning");
    at.boxKeys.delete(kenning.identity!.did);
    expect(await letters.send("glossame", kenning, "No inbox.")).toEqual({ message_id: null, held_because: "no-inbox", code: null, credits: 0 });
    signer.respond((req) => {
      if (req.target.startsWith("/v1/inbox/box-keys/")) throw new Error("socket closed");
      return at.respond(req);
    });
    expect(await letters.send("glossame", kenning, "No answer.")).toEqual({ message_id: null, held_because: "refused", code: null, credits: 0 });
    expect(signer.sent.filter((q) => q.op === "inbox.send")).toEqual([]);
    expect(signer.sealedLetters).toEqual([]);
    expect(at.inbox).toEqual([]);
  });

  test("an answer agenttool gives before charging spends nothing: a 402 is credits short, a 400 validation is refused; after the charge it counts (wire F6)", async () => {
    const { h, at, signer } = await registeredHost({
      glossame: { letters_from: ["yu"], wake_on_letter_from: [] },
      kenning: { letters_from: ["yu", "citizen:glossame"], wake_on_letter_from: [] },
    });
    const letters = agenttoolLetters({ config: h.config, client: hostClient(h.config, signer, noFetch) });
    const kenning = await readCitizen(h.config, "kenning");
    const cases: [number, string, Record<string, unknown>][] = [
      [402, "insufficient_credits", { held_because: "credits", code: "ceiling-credits", credits: 0 }],
      [400, "validation", { held_because: "refused", code: null, credits: 0 }],
      [401, "signature_invalid", { held_because: "refused", code: null, credits: 2 }],
      [503, "unavailable", { held_because: "uncertain", code: null, credits: 2 }],
    ];
    for (const [status, error, want] of cases) {
      at.override((req) => req.op === "inbox.send", { status, json: { error } });
      expect(await letters.send("glossame", kenning, `Answered ${status}.`), `${status}`).toEqual({ message_id: null, ...want } as never);
    }
  });

  test("an inbox read asks for agenttool's whole window of 200, so an admitted letter is not lost behind 50 newer ones (wire F7)", async () => {
    const { h, at, signer } = await registeredHost({
      glossame: { letters_from: ["yu"], wake_on_letter_from: [] },
      shemme: { letters_from: ["yu"], wake_on_letter_from: [] },
      kenning: { letters_from: ["yu", "citizen:glossame"], wake_on_letter_from: [] },
    });
    const letters = agenttoolLetters({ config: h.config, client: hostClient(h.config, signer, noFetch) });
    await letters.send("glossame", await readCitizen(h.config, "kenning"), "The one that matters.");
    // 50 newer letters from a sender kenning does not admit, all left unread on agenttool.
    for (let i = 0; i < 50; i++) await letters.send("shemme", await readCitizen(h.config, "kenning"), `Noise ${i}.`);
    const [shown] = await letters.unread(await readCitizen(h.config, "kenning"), async () => false);
    expect(shown).toMatchObject({ text: "The one that matters." });
    const reads = signer.sent.filter((q) => q.op === "read" && q.target.startsWith("/v1/inbox?"));
    expect(reads.at(-1)!.target).toBe(`/v1/inbox?identity_id=${IDS.kenning}&status=unread&limit=200`);
  });
});
