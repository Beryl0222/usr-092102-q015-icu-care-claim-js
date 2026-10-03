import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/store.js";
import * as cmd from "../src/commands.js";
import { calculate } from "../src/calculation.js";
import { loadClaim } from "../src/model.js";
import { ACTORS, T, buildStandardCase, classifyDadExcluded } from "./helpers.js";

function lineOf(result, id) {
  const all = [...result.calculation.medical_care.lines, ...result.calculation.living_care.lines];
  return all.find((l) => l.target_id === id);
}

test("标准案件：医疗护理与生活照护不重复给付，ICU 重叠日扣除", () => {
  const { store, claimId } = buildStandardCase();
  classifyDadExcluded(store, claimId);
  const r = calculate(loadClaim(store, claimId));

  assert.equal(r.calculation.rule_version, "RULES-2026");
  assert.equal(r.calculation.medical_care.total, 3300); // 11 天 × 300
  const mom = lineOf(r, "ln-mom");
  assert.equal(mom.status, "ALLOCATED");
  assert.equal(mom.payable_days, 20); // 31 天 - 11 天 ICU 重叠
  assert.deepEqual(mom.payable_dates[0], "2026-03-21");
  assert.equal(mom.payable_amount, 4200); // 20 × 210
  const overlap = mom.deductions.find((d) => d.reason === "MEDICAL_OVERLAP");
  assert.equal(overlap.day_count, 11);
  assert.equal(r.calculation.total, 7500);
  // 父亲两项均判排除
  assert.equal(lineOf(r, "fa-dad-standby").status, "EXCLUDED");
  assert.equal(lineOf(r, "fa-dad-errand").status, "EXCLUDED");
});

test("未作判断的对象挂起，系统不自动通过也不自动拒绝", () => {
  const { store, claimId } = buildStandardCase(); // 父亲行为未判断
  const r = calculate(loadClaim(store, claimId));
  assert.equal(lineOf(r, "fa-dad-standby").status, "PENDING");
  assert.equal(lineOf(r, "fa-dad-standby").payable_amount, 0);
});

test("护理人原则上一名：无多人意见时，同日第二名护理人受限（高报酬者优先）", () => {
  const { store, claimId } = buildStandardCase();
  // 祖母在普通病房期间（03-21~04-09）也来陪护，按外地标准 175/天（需异地意见）
  cmd.submitEvidence(store, claimId, { evidence_id: "ev-rel2", kind: "IDENTITY_RELATION", submitted_by: "祖母", submitted_by_role: "FAMILY_MEMBER" }, T("04-10"));
  cmd.recordExpertOpinion(
    store,
    claimId,
    {
      opinion_id: "op-region",
      opinion_kind: "MEDICAL_OPINION",
      issuer: "医院",
      issued_on: "2026-04-05",
      exceptions: ["REGIONAL_STANDARD"],
      region_override: "320000",
      evidence_refs: ["ev-nr"],
    },
    T("04-06"),
  );
  cmd.recordLivingCareNeed(
    store,
    claimId,
    {
      need_id: "ln-grandma",
      caregiver_id: "grandma",
      period: { start: "2026-03-21", end: "2026-04-09" },
      income_basis: "LOCAL_LABOR_STANDARD",
      evidence_refs: ["ev-rel2"],
    },
    T("04-10"),
  );
  cmd.classifyCare(
    store,
    claimId,
    ACTORS.adjudicator,
    {
      classification_id: "cc-grandma",
      target_type: "LIVING_CARE_NEED",
      target_id: "ln-grandma",
      care_class: "LIVING_CARE",
      reason_codes: ["FACT_FAMILY_CARE_ATTESTED", "OPINION_NONLOCAL_STANDARD"],
      opinion_refs: [{ opinion_id: "op-region", reason_code: "OPINION_NONLOCAL_STANDARD" }],
      evidence_refs: ["ev-rel2"],
    },
    T("04-12"),
  );

  const r = calculate(loadClaim(store, claimId));
  const mom = lineOf(r, "ln-mom");
  const grandma = lineOf(r, "ln-grandma");
  // 母亲 210 > 祖母 175，同日只给付母亲；祖母 20 天全部受护理人数限制
  assert.equal(mom.payable_days, 20);
  assert.equal(grandma.daily_rate, 175);
  const limited = grandma.deductions.find((d) => d.reason === "CAREGIVER_LIMIT");
  assert.equal(limited.day_count, 20);
  assert.equal(grandma.payable_amount, 0);
});

test("多人护理例外：鉴定意见核准 2 人时，同日两名护理人均获给付", () => {
  const { store, claimId } = buildStandardCase();
  cmd.submitEvidence(store, claimId, { evidence_id: "ev-rel2", kind: "IDENTITY_RELATION", submitted_by: "祖母", submitted_by_role: "FAMILY_MEMBER" }, T("04-10"));
  cmd.recordExpertOpinion(
    store,
    claimId,
    {
      opinion_id: "op-multi",
      opinion_kind: "APPRAISAL",
      issuer: "司法鉴定中心",
      issued_on: "2026-04-05",
      period: { start: "2026-03-21", end: "2026-04-09" },
      exceptions: ["MULTI_CAREGIVER"],
      approved_caregiver_count: 2,
    },
    T("04-06"),
  );
  cmd.recordLivingCareNeed(
    store,
    claimId,
    {
      need_id: "ln-grandma",
      caregiver_id: "grandma",
      period: { start: "2026-03-21", end: "2026-04-09" },
      income_basis: "LOCAL_LABOR_STANDARD",
      evidence_refs: ["ev-rel2"],
    },
    T("04-10"),
  );
  cmd.classifyCare(
    store,
    claimId,
    ACTORS.adjudicator,
    {
      classification_id: "cc-grandma",
      target_type: "LIVING_CARE_NEED",
      target_id: "ln-grandma",
      care_class: "LIVING_CARE",
      reason_codes: ["FACT_FAMILY_CARE_ATTESTED", "OPINION_MULTI_CAREGIVER"],
      opinion_refs: [{ opinion_id: "op-multi", reason_code: "OPINION_MULTI_CAREGIVER" }],
      evidence_refs: ["ev-rel2"],
    },
    T("04-12"),
  );

  const r = calculate(loadClaim(store, claimId));
  assert.equal(lineOf(r, "ln-mom").payable_days, 20);
  assert.equal(lineOf(r, "ln-grandma").payable_days, 20);
  assert.equal(lineOf(r, "ln-grandma").payable_amount, 4200);
});

test("期限上限按事故时版本执行（180 天），超期部分扣除", () => {
  const store = new EventStore();
  cmd.openClaim(store, { claim_id: "long", accident_date: "2026-01-01", accident_region: "310000" }, T("01-01"));
  cmd.pinRules(store, "long", T("01-01"));
  cmd.submitEvidence(store, "long", { evidence_id: "nr", kind: "NURSING_RECORD", submitted_by: "医院", submitted_by_role: "HOSPITAL" }, T("01-02"));
  cmd.submitEvidence(store, "long", { evidence_id: "rel", kind: "IDENTITY_RELATION", submitted_by: "母亲", submitted_by_role: "FAMILY_MEMBER" }, T("01-02"));
  cmd.recordLivingCareNeed(
    store,
    "long",
    { need_id: "ln", caregiver_id: "mom", period: { start: "2026-01-01", end: "2026-07-19" }, income_basis: "LOCAL_LABOR_STANDARD", evidence_refs: ["nr", "rel"] }, // 200 天
    T("07-20"),
  );
  cmd.classifyCare(
    store,
    "long",
    ACTORS.adjudicator,
    {
      classification_id: "cc", target_type: "LIVING_CARE_NEED", target_id: "ln",
      care_class: "LIVING_CARE", reason_codes: ["FACT_DOCTOR_ORDER_CARE", "FACT_FAMILY_CARE_ATTESTED"], evidence_refs: ["nr"],
    },
    T("07-21"),
  );
  let r = calculate(loadClaim(store, "long"));
  const line = lineOf(r, "ln");
  assert.equal(line.payable_days, 180);
  assert.equal(line.deductions.find((d) => d.reason === "PERIOD_CAP").day_count, 20);

  // 鉴定意见核准 200 天并覆盖全程 → 全部给付
  cmd.recordExpertOpinion(
    store,
    "long",
    {
      opinion_id: "op-cap",
      opinion_kind: "APPRAISAL",
      issuer: "鉴定中心",
      issued_on: "2026-07-25",
      period: { start: "2026-01-01", end: "2026-07-19" },
      exceptions: ["PERIOD_CAP"],
      approved_cap_days: 200,
    },
    T("07-26"),
  );
  cmd.classifyCare(
    store,
    "long",
    ACTORS.adjudicator,
    {
      classification_id: "cc2", target_type: "LIVING_CARE_NEED", target_id: "ln",
      care_class: "LIVING_CARE",
      reason_codes: ["FACT_DOCTOR_ORDER_CARE", "OPINION_PERIOD_EXTENSION"],
      opinion_refs: [{ opinion_id: "op-cap", reason_code: "OPINION_PERIOD_EXTENSION" }],
    },
    T("07-27"),
  );
  r = calculate(loadClaim(store, "long"));
  assert.equal(lineOf(r, "ln").payable_days, 200);
});

test("主张实际收入但缺收入证明：整线挂起，不按零或地区标准替代；补齐后按实际收入", () => {
  const store = new EventStore();
  cmd.openClaim(store, { claim_id: "inc", accident_date: "2026-03-10", accident_region: "310000" }, T("03-10"));
  cmd.pinRules(store, "inc", T("03-10"));
  cmd.submitEvidence(store, "inc", { evidence_id: "mr", kind: "MEDICAL_RECORD", submitted_by: "医院", submitted_by_role: "HOSPITAL" }, T("03-11"));
  cmd.submitEvidence(store, "inc", { evidence_id: "rel", kind: "IDENTITY_RELATION", submitted_by: "母亲", submitted_by_role: "FAMILY_MEMBER" }, T("03-11"));
  cmd.submitEvidence(store, "inc", { evidence_id: "nt", kind: "REQUEST_NOTICE", submitted_by: "保险", submitted_by_role: "INSURER_STAFF" }, T("03-11"));
  cmd.submitEvidence(store, "inc", { evidence_id: "nr", kind: "NURSING_RECORD", submitted_by: "医院", submitted_by_role: "HOSPITAL" }, T("03-11"));
  cmd.recordLivingCareNeed(
    store,
    "inc",
    { need_id: "ln", caregiver_id: "mom", period: { start: "2026-03-21", end: "2026-03-30" }, income_basis: "ACTUAL_INCOME", daily_income: 400, evidence_refs: ["nr"] },
    T("03-31"),
  );
  cmd.classifyCare(
    store,
    "inc",
    ACTORS.adjudicator,
    {
      classification_id: "cc", target_type: "LIVING_CARE_NEED", target_id: "ln",
      care_class: "LIVING_CARE", reason_codes: ["FACT_FAMILY_CARE_ATTESTED"], evidence_refs: ["nr"],
    },
    T("04-01"),
  );
  let r = calculate(loadClaim(store, "inc"));
  const line = lineOf(r, "ln");
  assert.equal(line.status, "WITHHELD");
  assert.equal(line.reason, "MISSING_INCOME_PROOF");
  assert.ok(r.missing_requirements.some((m) => m.code === "REQ_CAREGIVER_INCOME"));

  // 多主体补交收入与误工材料
  cmd.submitEvidence(store, "inc", { evidence_id: "ip", kind: "INCOME_PROOF", submitted_by: "母亲单位", submitted_by_role: "FAMILY_MEMBER" }, T("04-02"));
  cmd.submitEvidence(store, "inc", { evidence_id: "li", kind: "LOST_INCOME_MATERIAL", submitted_by: "母亲单位", submitted_by_role: "FAMILY_MEMBER" }, T("04-02"));
  r = calculate(loadClaim(store, "inc"));
  assert.equal(lineOf(r, "ln").status, "ALLOCATED");
  assert.equal(lineOf(r, "ln").daily_rate, 400);
  assert.equal(lineOf(r, "ln").payable_amount, 4000);
  assert.deepEqual(r.missing_requirements, []);
});

test("医院专业护理计费期间超出住院区间（出院后）的部分按日比例剔除", () => {
  const { store, claimId } = buildStandardCase();
  // 出院日为 04-09，费用单却收到 04-12：5 天 × 100，仅住院期内 2 天可计
  cmd.recordMedicalCareItem(
    store,
    claimId,
    {
      item_id: "mi-extra",
      name: "监护项目延收至出院后",
      period: { start: "2026-04-08", end: "2026-04-12" },
      amount: 500,
      fee_evidence_refs: ["ev-fee"],
    },
    T("04-13"),
  );
  cmd.classifyCare(
    store,
    claimId,
    ACTORS.adjudicator,
    {
      classification_id: "cc-extra", target_type: "MEDICAL_CARE_ITEM", target_id: "mi-extra",
      care_class: "MEDICAL_CARE", reason_codes: ["FACT_HOSPITAL_PROFESSIONAL_NURSING", "FACT_FEE_ITEM_PAID"], evidence_refs: ["ev-fee"],
    },
    T("04-14"),
  );
  const r = calculate(loadClaim(store, claimId));
  const extra = lineOf(r, "mi-extra");
  assert.equal(extra.payable_days, 2); // 04-08~04-09 在住院区间
  assert.equal(extra.payable_amount, 200);
  assert.deepEqual(extra.excluded_periods, [{ start: "2026-04-10", end: "2026-04-12" }]);
});
