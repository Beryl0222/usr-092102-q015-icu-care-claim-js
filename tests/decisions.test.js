import assert from "node:assert/strict";
import test from "node:test";

import * as dec from "../src/decisions.js";
import { loadClaim } from "../src/model.js";
import { ACTORS, T, buildStandardCase, classifyDadExcluded } from "./helpers.js";

test("裁决引用冻结快照；快照哈希可用重放复算校验一致", () => {
  const { store, claimId } = buildStandardCase();
  classifyDadExcluded(store, claimId);

  dec.freezeCalculation(store, claimId, { snapshot_id: "snap-1" }, T("04-15"));
  const verify = dec.verifyFrozenSnapshot(store, claimId, "snap-1");
  assert.equal(verify.consistent, true);

  dec.issueDecision(
    store,
    claimId,
    ACTORS.adjudicator,
    { decision_id: "dec-1", snapshot_id: "snap-1", outcome: "PARTIALLY_APPROVED", rationale: ["ICU 期专业护理凭票认定；病房期生活照护按事故时标准认定"] },
    T("04-16"),
  );
  const state = loadClaim(store, claimId);
  assert.equal(state.decision.outcome, "PARTIALLY_APPROVED");
  assert.equal(state.decision.revision_of, null);
});

test("同一案件不得二次裁决，更正必须走复核", () => {
  const { store, claimId } = buildStandardCase();
  dec.freezeCalculation(store, claimId, { snapshot_id: "snap-1" }, T("04-15"));
  dec.issueDecision(store, claimId, ACTORS.adjudicator, { decision_id: "dec-1", snapshot_id: "snap-1", outcome: "APPROVED" }, T("04-16"));
  assert.throws(
    () => dec.issueDecision(store, claimId, ACTORS.adjudicator, { decision_id: "dec-2", snapshot_id: "snap-1", outcome: "REJECTED" }, T("04-17")),
    /更正请走复核/,
  );
});

test("非复核角色不得开启复核", () => {
  const { store, claimId } = buildStandardCase();
  dec.freezeCalculation(store, claimId, { snapshot_id: "snap-1" }, T("04-15"));
  dec.issueDecision(store, claimId, ACTORS.adjudicator, { decision_id: "dec-1", snapshot_id: "snap-1", outcome: "APPROVED" }, T("04-16"));
  assert.throws(
    () => dec.openReview(store, claimId, ACTORS.adjudicator, { review_id: "rv1", reason: "不服" }, T("05-01")),
    /仅 REVIEWER/,
  );
});

test("复核冻结当时快照；二审后更正裁决，原快照与原裁决永久保留且仍可重放", () => {
  const { store, claimId } = buildStandardCase();
  classifyDadExcluded(store, claimId);
  dec.freezeCalculation(store, claimId, { snapshot_id: "snap-1" }, T("04-15"));
  dec.issueDecision(store, claimId, ACTORS.adjudicator, { decision_id: "dec-1", snapshot_id: "snap-1", outcome: "PARTIALLY_APPROVED" }, T("04-16"));
  const originalTotal = loadClaim(store, claimId).snapshots[0].calculation.total;

  // 开启复核：自动冻结复核基准快照
  dec.openReview(store, claimId, ACTORS.reviewer, { review_id: "rv-1", reason: "受害方认为病房期护理人数应为两人" }, T("05-10"));

  // 二审裁判（后继结果只追加，不直接改判）
  dec.recordFollowupResult(
    store,
    claimId,
    ACTORS.reviewer,
    {
      result_id: "fr-1",
      review_id: "rv-1",
      followup_kind: "SECOND_INSTANCE",
      issuer: "某市中级人民法院",
      issued_on: "2026-08-01",
      changes: ["认定普通病房期需两人护理，须有鉴定支持"],
    },
    T("08-05"),
  );

  // 更正裁决必须引用后继结果
  assert.throws(
    () =>
      dec.reviseDecision(store, claimId, ACTORS.adjudicator, {
        decision_id: "dec-2", review_id: "rv-1", followup_result_ids: [], outcome: "APPROVED",
      }),
    /必须引用二审裁判或新鉴定结果/,
  );

  dec.reviseDecision(
    store,
    claimId,
    ACTORS.adjudicator,
    {
      decision_id: "dec-2",
      review_id: "rv-1",
      followup_result_ids: ["fr-1"],
      outcome: "APPROVED",
      rationale: ["依二审判决更正"],
    },
    T("08-10"),
  );

  const state = loadClaim(store, claimId);
  // 裁决链完整：两条裁决，后者 revision_of 指向前者
  assert.equal(state.decisions.length, 2);
  assert.equal(state.decision.decision_id, "dec-2");
  assert.equal(state.decision.revision_of, "dec-1");
  // 原快照未被修改
  const snap1 = state.snapshots.find((s) => s.snapshot_id === "snap-1");
  assert.equal(snap1.calculation.total, originalTotal);
  assert.equal(dec.verifyFrozenSnapshot(store, claimId, "snap-1").consistent, true);
  // 新更正快照同样可校验
  const revisedSnap = state.snapshots.find((s) => s.snapshot_id === "snapshot-revised-dec-2");
  assert.ok(revisedSnap);
  assert.equal(dec.verifyFrozenSnapshot(store, claimId, revisedSnap.snapshot_id).consistent, true);
});

test("新鉴定结果可作为另一轮后继更正依据", () => {
  const { store, claimId } = buildStandardCase();
  dec.freezeCalculation(store, claimId, { snapshot_id: "snap-1" }, T("04-15"));
  dec.issueDecision(store, claimId, ACTORS.adjudicator, { decision_id: "dec-1", snapshot_id: "snap-1", outcome: "REJECTED" }, T("04-16"));
  dec.openReview(store, claimId, ACTORS.reviewer, { review_id: "rv-1", reason: "申请重新鉴定" }, T("05-10"));
  dec.recordFollowupResult(
    store,
    claimId,
    ACTORS.reviewer,
    { result_id: "fr-appraisal", review_id: "rv-1", followup_kind: "NEW_APPRAISAL", issuer: "重新鉴定机构", issued_on: "2026-06-01", changes: ["护理依赖成立"] },
    T("06-05"),
  );
  dec.reviseDecision(
    store,
    claimId,
    ACTORS.adjudicator,
    { decision_id: "dec-2", review_id: "rv-1", followup_result_ids: ["fr-appraisal"], outcome: "PARTIALLY_APPROVED" },
    T("06-10"),
  );
  const state = loadClaim(store, claimId);
  assert.deepEqual(state.decision.followup_result_ids, ["fr-appraisal"]);
  assert.equal(state.followups[0].followup_kind, "NEW_APPRAISAL");
});
