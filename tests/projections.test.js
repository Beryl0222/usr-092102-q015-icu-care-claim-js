import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/store.js";
import * as cmd from "../src/commands.js";
import * as dec from "../src/decisions.js";
import { evidenceChecklist, insurerView, projectionFor, reviewerAuditTrail, victimView, VIEWER_ROLES } from "../src/projections.js";
import { loadClaim } from "../src/model.js";
import { ACTORS, T, buildStandardCase, classifyDadExcluded } from "./helpers.js";

test("缺证清单：空案件列出事故时版本的全部要件，补齐后逐项消除", () => {
  const store = new EventStore();
  cmd.openClaim(store, { claim_id: "c0", accident_date: "2026-03-10", accident_region: "310000" }, T("03-10"));
  cmd.pinRules(store, "c0", T("03-10"));
  let list = evidenceChecklist(loadClaim(store, "c0"));
  assert.deepEqual(list.missing.map((m) => m.code).sort(), [
    "REQ_CARE_DEPENDENCY",
    "REQ_HOSPITALIZATION",
    "REQ_NOTICE",
    "REQ_RELATION",
  ]);
  cmd.submitEvidence(store, "c0", { evidence_id: "m", kind: "MEDICAL_RECORD", submitted_by: "医院", submitted_by_role: "HOSPITAL" }, T("03-11"));
  list = evidenceChecklist(loadClaim(store, "c0"));
  assert.ok(!list.missing.some((m) => m.code === "REQ_HOSPITALIZATION"));
  assert.ok(list.satisfied.some((s) => s.code === "REQ_HOSPITALIZATION" && s.evidence_ids.includes("m")));
});

test("受害方视图：看到认定时段、逐日日期、金额形成与缺口，看不到医疗原文", () => {
  const { store, claimId } = buildStandardCase();
  classifyDadExcluded(store, claimId);
  dec.freezeCalculation(store, claimId, { snapshot_id: "snap-1" }, T("04-15"));
  dec.issueDecision(store, claimId, ACTORS.adjudicator, { decision_id: "dec-1", snapshot_id: "snap-1", outcome: "PARTIALLY_APPROVED" }, T("04-16"));

  const v = victimView(store, claimId);
  assert.equal(v.rule_version, "RULES-2026");
  assert.deepEqual(v.evidence_status.missing, []);

  const mom = v.recognized.living_care.find((l) => l.target_id === "ln-mom");
  assert.equal(mom.recognized_days, 20);
  assert.deepEqual(mom.recognized_dates[0], "2026-03-21");
  assert.deepEqual(mom.recognized_dates.at(-1), "2026-04-09");
  assert.equal(mom.daily_rate, 210);
  assert.equal(mom.amount, 4200);
  assert.equal(v.amount_formation.medical_total, 3300);
  assert.equal(v.amount_formation.total, 7500);
  assert.equal(v.decision.outcome, "PARTIALLY_APPROVED");

  // 医疗项目原文名称不向受害方展开
  const med = v.recognized.medical_care[0];
  assert.equal(med.item, "医院专业护理收费项目");
  assert.equal(med.amount, 3300);
  assert.deepEqual(med.recognized_periods, [{ start: "2026-03-10", end: "2026-03-20" }]);

  // 被排除的父亲行为可见结论与原因
  const standby = v.recognized.living_care.find((l) => l.target_id === "fa-dad-standby");
  assert.equal(standby.status, "EXCLUDED");
});

test("受害方视图在收入证明缺失时明确显示缺什么且金额挂起", () => {
  const store = new EventStore();
  cmd.openClaim(store, { claim_id: "inc", accident_date: "2026-03-10", accident_region: "310000" }, T("03-10"));
  cmd.pinRules(store, "inc", T("03-10"));
  cmd.submitEvidence(store, "inc", { evidence_id: "nr", kind: "NURSING_RECORD", submitted_by: "医院", submitted_by_role: "HOSPITAL" }, T("03-11"));
  cmd.recordLivingCareNeed(store, "inc", { need_id: "ln", caregiver_id: "mom", period: { start: "2026-03-21", end: "2026-03-30" }, income_basis: "ACTUAL_INCOME", daily_income: 400, evidence_refs: ["nr"] }, T("03-31"));
  cmd.classifyCare(store, "inc", ACTORS.adjudicator, {
    classification_id: "cc", target_type: "LIVING_CARE_NEED", target_id: "ln",
    care_class: "LIVING_CARE", reason_codes: ["FACT_FAMILY_CARE_ATTESTED"], evidence_refs: ["nr"],
  }, T("04-01"));

  const v = victimView(store, "inc");
  assert.ok(v.evidence_status.missing.some((m) => m.code === "REQ_CAREGIVER_INCOME"));
  const line = v.recognized.living_care[0];
  assert.equal(line.status, "WITHHELD");
  assert.equal(line.amount, 0);
  assert.match(line.issue, /收入证明/);
});

test("对方保险人员：可见通知材料与总额，医疗详情、家属收入被遮蔽", () => {
  const { store, claimId } = buildStandardCase();
  const v = insurerView(store, claimId, { role: VIEWER_ROLES.INSURER_STAFF, party_id: null });
  const byId = Object.fromEntries(v.evidence.map((e) => [e.evidence_id, e]));
  assert.equal(byId["ev-mr"].content_ref, "[按最小可见范围遮蔽]");
  assert.equal(byId["ev-mr"].kind, "REDACTED");
  assert.equal(byId["ev-fee"].content_ref, "[按最小可见范围遮蔽]");
  // 保险内部通知材料对本方可见
  assert.notEqual(byId["ev-nt"].content_ref, "[按最小可见范围遮蔽]");
  assert.equal(v.totals.total, 7500);
});

test("复核者审计轨迹：三分标注、归并链、去重扣减、快照重放校验与裁决链", () => {
  const { store, claimId } = buildStandardCase();
  classifyDadExcluded(store, claimId);
  // 归并一份重复费用单
  cmd.submitEvidence(store, claimId, { evidence_id: "ev-fee-dup", kind: "FEE_DETAIL", submitted_by: "家属", submitted_by_role: "FAMILY_MEMBER", fingerprints: ["fp-fee-001"] }, T("04-11"));
  cmd.mergeEvidence(store, claimId, ACTORS.adjudicator, { canonical_id: "ev-fee", duplicate_ids: ["ev-fee-dup"] }, T("04-11"));

  dec.freezeCalculation(store, claimId, { snapshot_id: "snap-1" }, T("04-15"));
  dec.issueDecision(store, claimId, ACTORS.adjudicator, { decision_id: "dec-1", snapshot_id: "snap-1", outcome: "PARTIALLY_APPROVED" }, T("04-16"));
  dec.openReview(store, claimId, ACTORS.reviewer, { review_id: "rv-1", reason: "争议复核" }, T("05-01"));

  const audit = reviewerAuditTrail(store, claimId);
  assert.equal(audit.pinned_rule_version, "RULES-2026");
  assert.ok(audit.timeline.length >= 10);
  assert.ok(audit.timeline.every((t, i) => i === 0 || audit.timeline[i - 1].seq <= t.seq));

  // 归并链可审计
  const dup = audit.evidence_chain.find((e) => e.evidence_id === "ev-fee-dup");
  assert.equal(dup.status, "MERGED_DUPLICATE");
  assert.equal(dup.canonical_id, "ev-fee");

  // 三分标注：父亲守候排除理由含事实与关键词两层，且关键词标注 keyword_only
  const dad = audit.classifications.find((c) => c.target === "FAMILY_ACTIVITY/fa-dad-standby");
  const layers = Object.fromEntries(dad.basis_separation.map((b) => [b.reason_code, b]));
  assert.equal(layers.FACT_NO_PATIENT_CONTACT_CARE.layer, "证据事实");
  assert.equal(layers.KEYWORD_WAIT_OUTSIDE_ONLY.keyword_only, true);

  // 去重轨迹：ICU 11 天的医疗/生活照护重叠扣减
  assert.equal(audit.medical_paid_days, 11);
  assert.equal(audit.overlap_deductions.reduce((s, d) => s + d.day_count, 0), 11);

  // 两张快照均可重放校验
  assert.ok(audit.snapshots.every((s) => s.verification.consistent));
  assert.equal(audit.snapshots.length, 2); // 原裁决 + 复核基准
  assert.equal(audit.review_open.review_id, "rv-1");
  assert.equal(audit.decision_chain[0].decision_id, "dec-1");
});

test("projectionFor 按角色分派；未知角色拒绝", () => {
  const { store, claimId } = buildStandardCase();
  assert.ok(projectionFor(store, claimId, { role: VIEWER_ROLES.VICTIM }).claim_id);
  assert.ok(projectionFor(store, claimId, { role: VIEWER_ROLES.REVIEWER }).timeline);
  assert.throws(() => projectionFor(store, claimId, { role: "GHOST" }), /未知视角/);
});
