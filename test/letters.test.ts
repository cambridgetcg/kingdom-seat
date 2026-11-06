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
    expect(shown).toEqual([{ id: inboxLetterId(at.inbox[1]!.id as string), from: `did:at:${IDS.glossame}`, received_at: at.inbox[1]!.created_at as string, text: "For kenning.", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    // A letter already receipted is not shown again.
    expect(await letters.unread(await readCitizen(h.config, "kenning"), async (id) => id === shown[0]!.id)).toEqual([]);
  });
});
