import { strict as assert } from "node:assert";
import { test } from "node:test";
import { gapRows } from "../src/gaps";

test("each blank source row is either a separator or exactly one editable row", () => {
  assert.deepEqual(gapRows(1), []);
  for (let blanks = 1; blanks <= 10; blanks++) {
    const rows = gapRows(blanks + 1);
    assert.equal(rows.length, blanks);
    assert.equal(rows[0], "half");
    assert.equal(rows.at(-1), "half");
    assert.equal(rows.filter(row => row === "half").length, Math.min(blanks, 2));
    assert.equal(rows.filter(row => row === "full").length, Math.max(0, blanks - 2));
  }
});
