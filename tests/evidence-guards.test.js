import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/store.js";
import * as cmd from "../src/commands.js";
import { loadClaim } from "../src/model.js";
import { ACTORS, T } from "./helpers.js";

function open() {
  const store = new EventStore();
  cmd.openClaim(store, { claim_id: "c1", accident_date: "2026-03-10", accident_region: "310000" }, T("03-10"));
  cmd.pinRules(store, "c1", T("03-10"));
  return store;
}

test("不同主体可分别补交证据，每次提交独立保留", () => {
  const store = open();
  cmd.submitEvidence(store, "c1", { evidence_id: "e1", kind: "MEDICAL_RECORD", submitted_by: "医院", submitted_by_role: "HOSPITAL" }, T("03-12"));
  cmd.submitEvidence(store, "c1", { evidence_id: "e2", kind: "FEE_DETAIL", submitted_by: "家属", submitted_by_role: "FAMILY_MEMBER" }, T("03-13"));
  const state = loadClaim(store, "c1");
  assert.equal(state.evidence.size, 2);
  assert.equal(state.evidence.get("e1").status, "ACTIVE");
  // 事件历史不可变：两份原始提交都在
  assert.deepEqual(store.read({ claimId: "c1" }).filter((e) => e.event_type === "EVIDENCE_SUBMITTED").map((e) => e.aggregate_id), ["e1", "e2"]);
});

test("补证不能复用既有编号覆盖原提交", () => {
  const store = open();
  cmd.submitEvidence(store, "c1", { evidence_id: "e1", kind: "MEDICAL_RECORD", submitted_by: "医院", submitted_by_role: "HOSPITAL" }, T("03-12"));
  assert.throws(
    () => cmd.submitEvidence(store, "c1", { evidence_id: "e1", kind: "MEDICAL_RECORD", submitted_by: "家属", submitted_by_role: "FAMILY_MEMBER" }, T("03-13")),
    /补证请使用新编号/,
  );
});

test("重复材料只归并引用：正本保留，重复件不删除可审计", () => {
  const store = open();
  cmd.submitEvidence(store, "c1", { evidence_id: "e1", kind: "FEE_DETAIL", submitted_by: "医院", submitted_by_role: "HOSPITAL", fingerprints: ["fp-x"] }, T("03-12"));
  cmd.submitEvidence(store, "c1", { evidence_id: "e2", kind: "FEE_DETAIL", submitted_by: "家属", submitted_by_role: "FAMILY_MEMBER", fingerprints: ["fp-x"] }, T("03-13"));

  const dups = cmd.findDuplicateEvidence(store, "c1");
  assert.deepEqual(dups, [{ fingerprint: "fp-x", ids: ["e1", "e2"] }]);

  cmd.mergeEvidence(store, "c1", ACTORS.adjudicator, { canonical_id: "e1", duplicate_ids: ["e2"] }, T("03-14"));
  const state = loadClaim(store, "c1");
  assert.equal(state.evidence.get("e1").status, "ACTIVE");
  assert.equal(state.evidence.get("e2").status, "MERGED_DUPLICATE");
  assert.equal(state.evidence.get("e2").canonical_id, "e1");
  // 原始提交仍在事件流中
  assert.ok(store.eventsForAggregate("care_evidence", "e2").some((e) => e.event_type === "EVIDENCE_SUBMITTED"));
});

test("不同种类材料不得归并", () => {
  const store = open();
  cmd.submitEvidence(store, "c1", { evidence_id: "e1", kind: "FEE_DETAIL", submitted_by: "a", submitted_by_role: "HOSPITAL", fingerprints: ["fp"] }, T("03-12"));
  cmd.submitEvidence(store, "c1", { evidence_id: "e2", kind: "MEDICAL_RECORD", submitted_by: "b", submitted_by_role: "HOSPITAL", fingerprints: ["fp"] }, T("03-12"));
  assert.throws(
    () => cmd.mergeEvidence(store, "c1", ACTORS.adjudicator, { canonical_id: "e1", duplicate_ids: ["e2"] }),
    /不同种类材料不得归并/,
  );
});

/* ------------------------- 护理判断三分守卫 ------------------------- */

function setupCareItem(store) {
  cmd.submitEvidence(store, "c1", { evidence_id: "m1", kind: "MEDICAL_RECORD", submitted_by: "医院", submitted_by_role: "HOSPITAL" }, T("03-11"));
  cmd.submitEvidence(store, "c1", { evidence_id: "f1", kind: "FEE_DETAIL", submitted_by: "医院", submitted_by_role: "HOSPITAL" }, T("03-11"));
  cmd.recordHospitalization(store, "c1", { phase_id: "ph1", ward: "ICU", period: { start: "2026-03-10", end: "2026-03-20" }, evidence_refs: ["m1"] }, T("03-11"));
  cmd.recordMedicalCareItem(store, "c1", { item_id: "mi1", name: "特级护理费", period: { start: "2026-03-10", end: "2026-03-20" }, amount: 1000, fee_evidence_refs: ["f1"] }, T("03-11"));
}

test("非授权角色不得作出护理性质判断", () => {
  const store = open();
  setupCareItem(store);
  assert.throws(
    () =>
      cmd.classifyCare(
        store,
        "c1",
        { actor_id: "ins-1", role: "INSURER_STAFF" },
        { classification_id: "x1", target_type: "MEDICAL_CARE_ITEM", target_id: "mi1", care_class: "MEDICAL_CARE", reason_codes: ["FACT_FEE_ITEM_PAID"] },
      ),
    /仅理赔裁决人员/,
  );
});

test("仅凭 ICU 关键词不得自动通过", () => {
  const store = open();
  setupCareItem(store);
  assert.throws(
    () =>
      cmd.classifyCare(store, "c1", ACTORS.adjudicator, {
        classification_id: "x1",
        target_type: "MEDICAL_CARE_ITEM",
        target_id: "mi1",
        care_class: "MEDICAL_CARE",
        reason_codes: ["KEYWORD_ICU_ONLY"],
      }),
    /不得仅凭/,
  );
});

test("仅凭“门外守候”关键词不得整段拒绝", () => {
  const store = open();
  cmd.submitEvidence(store, "c1", { evidence_id: "n1", kind: "REQUEST_NOTICE", submitted_by: "保", submitted_by_role: "INSURER_STAFF" }, T("03-11"));
  cmd.recordFamilyActivity(store, "c1", { activity_id: "a1", family_member_id: "dad", activity_type: "STANDBY", period: { start: "2026-03-10", end: "2026-03-20" }, evidence_refs: ["n1"] }, T("03-11"));
  assert.throws(
    () =>
      cmd.classifyCare(store, "c1", ACTORS.adjudicator, {
        classification_id: "x2",
        target_type: "FAMILY_ACTIVITY",
        target_id: "a1",
        care_class: "EXCLUDED",
        reason_codes: ["KEYWORD_WAIT_OUTSIDE_ONLY"],
      }),
    /不得仅凭/,
  );
});

test("例外理由必须引用载明该例外的机构意见", () => {
  const store = open();
  cmd.submitEvidence(store, "c1", { evidence_id: "m1", kind: "MEDICAL_RECORD", submitted_by: "医院", submitted_by_role: "HOSPITAL" }, T("03-11"));
  cmd.submitEvidence(store, "c1", { evidence_id: "n1", kind: "NURSING_RECORD", submitted_by: "医院", submitted_by_role: "HOSPITAL" }, T("03-11"));
  cmd.submitEvidence(store, "c1", { evidence_id: "r1", kind: "IDENTITY_RELATION", submitted_by: "家属", submitted_by_role: "FAMILY_MEMBER" }, T("03-11"));
  cmd.recordLivingCareNeed(store, "c1", { need_id: "ln1", caregiver_id: "mom", period: { start: "2026-03-10", end: "2026-03-20" }, income_basis: "LOCAL_LABOR_STANDARD", evidence_refs: ["n1"] }, T("03-11"));
  // 未引用任何意见
  assert.throws(
    () =>
      cmd.classifyCare(store, "c1", ACTORS.adjudicator, {
        classification_id: "x3", target_type: "LIVING_CARE_NEED", target_id: "ln1",
        care_class: "LIVING_CARE", reason_codes: ["FACT_DOCTOR_ORDER_CARE", "OPINION_MULTI_CAREGIVER"],
      }),
    /必须在 opinion_refs 中引用/,
  );
  // 意见未载明该例外
  cmd.recordExpertOpinion(store, "c1", { opinion_id: "op1", opinion_kind: "APPRAISAL", issuer: "鉴定中心", issued_on: "2026-04-01", exceptions: [] }, T("04-02"));
  assert.throws(
    () =>
      cmd.classifyCare(store, "c1", ACTORS.adjudicator, {
        classification_id: "x4", target_type: "LIVING_CARE_NEED", target_id: "ln1",
        care_class: "LIVING_CARE", reason_codes: ["FACT_DOCTOR_ORDER_CARE", "OPINION_MULTI_CAREGIVER"],
        opinion_refs: [{ opinion_id: "op1", reason_code: "OPINION_MULTI_CAREGIVER" }],
      }),
    /未载明例外 MULTI_CAREGIVER/,
  );
});
