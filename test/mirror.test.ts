// Owner: surface group. Pushes are tested with recordingRunner only; real
// git may be used read-only on temp repos to test divergence, never to push.
import { describe, test } from "bun:test";

describe("[S4-3] the seal", () => {
  test.todo("[S4-3] a symlink (mode 120000) anywhere in the tree refuses the stage");
  test.todo("[S4-3] an executable bit (mode 100755) refuses the stage");
  test.todo("[S4-3] .claude/, .github/, run.sh, ledger/ and other HOST_OWNED paths refuse");
  test.todo("[S4-3] a file over MIRROR_MAX_FILE_BYTES refuses rather than truncating");
  test.todo("listTree uses lstat and never follows a link out of the worktree");
});

describe("[S4-3] divergence and push", () => {
  test.todo("[S4-3] a diverged mirror (both sides ahead) refuses the push");
  test.todo("[S4-3] a mirror behind the remote refuses the push; no merge or rebase is attempted");
  test.todo("pushArgv is exactly [git, push, <remote>, HEAD:refs/heads/main] with no --force");
  test.todo("pushMirror runs the push only when the seal passes and HEAD is equal or ahead");
});
