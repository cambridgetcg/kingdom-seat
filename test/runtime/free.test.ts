// Owner: runtime group. A fake Ollama on the fake server; no model is pulled or run.
import { describe, test } from "bun:test";

describe("models.lock", () => {
  test.todo("the repo's models.lock refuses with model-unpinned (UNSET-PIN-ON-LEASE-HOST)");
  test.todo("a digest that is not 64 lowercase hex refuses");
  test.todo("loadModelsLock refuses a symlink, unknown keys and a wrong format");
});

describe("before the call", () => {
  test.todo("assertLoopback refuses localhost, ::1, https, other hosts and userinfo; accepts http://127.0.0.1:<port>");
  test.todo("checkTags refuses a missing row, a different digest, a different runner, and any row with remote_host or remote_model");
  test.todo("a cloud stub renamed to qwen2.5:7b (remote_host set) is refused");
});

describe("the call and after", () => {
  test.todo("modelRef is sha256:<digest>:local on a v2 store and <name>:local otherwise");
  test.todo("chatBody has stream false, no tools, the schema as format, num_predict and num_ctx from the lock, keep_alive 0, think false");
  test.todo("a reply carrying remote_host or remote_model is refused (cloud-reply)");
  test.todo("done_reason length is reported, never silently accepted as complete");
  test.todo("no fallback: any refusal means no second request to a different model");
  test.todo("the deadline aborts the request; spend is recorded as $0 local-zero");
});
