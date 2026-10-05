import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sourcePath } from "../src/update-files.mjs";

test("releases permit the reviewed recovery tool and reject arbitrary tools and docs", async () => {
  assert.equal(sourcePath("tools/reset-admin.mjs"), "tools/reset-admin.mjs");
  for (const path of ["tools/private-helper.mjs", "tools/private-helper.py", "docs/PRIVATE.md", "tests/fixtures/captured.html", "tests/private.py"])
    assert.throws(() => sourcePath(path));
  for (const file of ["../tools/recover-update.mjs", "../tools/check-publication.mjs"]) {
    const text = await readFile(new URL(file, import.meta.url), "utf8");
    const expression = text.match(/const allowed\s*=\s*(\/.*\/);/)[1];
    const allowed = Function(`return ${expression}`)();
    assert.ok(allowed.test("tools/reset-admin.mjs"));
    for (const path of ["tools/private-helper.mjs", "docs/PRIVATE.md", "tests/fixtures/captured.html"])
      assert.equal(allowed.test(path), false);
  }
});
