// Owner: record group. Self-authorship: propose → affirm → apply → revert.
import { describe, test } from "bun:test";

describe("proposals", () => {
  test.todo("materializeProposal applies replace-all and replace-span edits and hashes both sides; a missing span refuses");
  test.todo("a rewrite above 40% of the target is classified beyond self and never applied");
  test.todo("removing or weakening a wall is classified beyond self");
  test.todo("targetPath refuses host-owned paths (.claude/, .github/, run.sh, ledger), traversal and absolute paths");
});

describe("binding", () => {
  test.todo("an affirmation in the same seat as the proposal does not bind");
  test.todo("an affirmation on a later beat with the prior hash unchanged binds via two-beats");
  test.todo("one saying with Yu present binds via yu-present");
  test.todo("silence keeps the previous self: an unaffirmed proposal never applies");
  test.todo("a second unattended change inside 7 days does not bind; Yu present opens the window");
  test.todo("a runtime digest not in self_authorship.approved_model_digests does not bind");
});

describe("apply and revert", () => {
  test.todo("applyChange keeps the new version by hash, updates the target and appends self.applied");
  test.todo("applyChange for a registered citizen calls sync.putPrivateExpression and postReason once each");
  test.todo("revertTo restores an earlier version named by hash and appends self.reverted; nothing is deleted");
  test.todo("origin/soul.md is never written by apply or revert, and originIntact stays true");
});
