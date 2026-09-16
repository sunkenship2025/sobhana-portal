/**
 * Worklist search scoring — doctor + test matching, and the two copies of
 * worklistSearch.ts (frontend / backend) agreeing. Run:
 *   cd health-hub-backend && ./node_modules/.bin/tsx ../test-artifacts/worklist-search.test.ts
 */
import assert from "assert";
import * as fe from "../health-hub/src/lib/worklistSearch";
import * as be from "../health-hub-backend/src/lib/worklistSearch";

const ROW = {
  name: "Ramesh Kumar",
  phone: "9393936269",
  billNumber: "B-1042",
  doctorName: "Sharath Reddy",
  testNames: "COMPLETE BLOOD PICTURE, LFT",
};

for (const [side, lib] of [["frontend", fe], ["backend", be]] as const) {
  const score = (q: string) => lib.scoreWorklistMatch(ROW, q);

  assert.strictEqual(score("ramesh kumar"), 100, `${side}: exact patient name`);
  assert.strictEqual(score("sharath"), 15, `${side}: doctor name matches`);
  assert.strictEqual(score("blood"), 10, `${side}: test name matches`);
  assert.strictEqual(score("penicillin"), 0, `${side}: unrelated term drops row`);
  // A patient match must still outrank a doctor/test match for the same term.
  assert.ok(
    lib.scoreWorklistMatch({ name: "Sharath" }, "sharath") > score("sharath"),
    `${side}: patient outranks doctor`,
  );
  // Rows with no doctor/test fields (clinic queue) keep their old scores.
  assert.strictEqual(
    lib.scoreWorklistMatch({ name: "Ramesh Kumar", billNumber: "B-1042" }, "b-1042"),
    30,
    `${side}: bill-number scoring unchanged`,
  );

  // Ranking: the doctor's own patients survive a doctor-name search, ordered
  // after any patient whose name matches.
  const ranked = lib.searchWorklist(
    [{ name: "Anil", doctorName: "Sharath Reddy" }, { name: "Sharath Rao" }],
    "sharath",
    (r) => r,
  );
  assert.deepStrictEqual(
    ranked.map((r) => r.name),
    ["Sharath Rao", "Anil"],
    `${side}: patient-name match ranks above doctor match`,
  );
}

console.log("✅ worklist search: doctor/test matching + ranking OK on both copies");
