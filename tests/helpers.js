/**
 * 测试夹具：构造一个标准案件，供各测试在此基础上增减。
 * 全部编号确定，时间显式传入，避免跨测试串扰。
 */

import { EventStore } from "../src/store.js";
import * as cmd from "../src/commands.js";

export const ACTORS = Object.freeze({
  adjudicator: { actor_id: "adj-001", role: "ADJUDICATOR" },
  reviewer: { actor_id: "rev-001", role: "REVIEWER" },
  family: { actor_id: "fam-001", role: "FAMILY_MEMBER" },
  insurer: { actor_id: "ins-001", role: "INSURER_STAFF" },
});

const T = (day, hh = 10) => `2026-${day}T${String(hh).padStart(2, "0")}:00:00+08:00`;

/**
 * 标准案件：事故 2026-03-10（适用 RULES-2026），
 * ICU 11 天 + 普通病房 20 天；医院专业护理与母亲陪护在 ICU 期重叠。
 */
export function buildStandardCase(store = new EventStore()) {
  const claimId = "claim-001";
  cmd.openClaim(store, { claim_id: claimId, accident_date: "2026-03-10", accident_region: "310000" }, T("03-10", 9));
  cmd.pinRules(store, claimId, T("03-10", 9));

  const evidence = {};
  const submit = (id, kind, role, by, extra = {}) => {
    cmd.submitEvidence(
      store,
      claimId,
      {
        evidence_id: id,
        kind,
        submitted_by_role: role,
        submitted_by: by,
        content_ref: `oss://${claimId}/${id}.pdf`,
        ...extra,
      },
      T("03-11"),
    );
    evidence[id] = id;
  };
  submit("ev-mr", "MEDICAL_RECORD", "HOSPITAL", "医院");
  submit("ev-fee", "FEE_DETAIL", "HOSPITAL", "医院", { fingerprints: ["fp-fee-001"] });
  submit("ev-nr", "NURSING_RECORD", "HOSPITAL", "医院");
  submit("ev-rel", "IDENTITY_RELATION", "FAMILY_MEMBER", "母亲");
  submit("ev-nt", "REQUEST_NOTICE", "INSURER_STAFF", "保险公司");

  cmd.recordHospitalization(
    store,
    claimId,
    { phase_id: "ph-icu", ward: "ICU", period: { start: "2026-03-10", end: "2026-03-20" }, evidence_refs: ["ev-mr"] },
    T("03-21"),
  );
  cmd.recordHospitalization(
    store,
    claimId,
    { phase_id: "ph-ward", ward: "WARD", period: { start: "2026-03-21", end: "2026-04-09" }, evidence_refs: ["ev-mr"] },
    T("04-10"),
  );

  // 医院专业护理项目：ICU 11 天，300/天，合计 3300
  cmd.recordMedicalCareItem(
    store,
    claimId,
    {
      item_id: "mi-nurse",
      name: "重症监护室特级护理费",
      period: { start: "2026-03-10", end: "2026-03-20" },
      amount: 3300,
      fee_evidence_refs: ["ev-fee"],
    },
    T("03-21"),
  );

  // 母亲全程陪护 31 天，按地区劳务标准
  cmd.recordLivingCareNeed(
    store,
    claimId,
    {
      need_id: "ln-mom",
      caregiver_id: "mom",
      caregiver_name: "母亲",
      period: { start: "2026-03-10", end: "2026-04-09" },
      income_basis: "LOCAL_LABOR_STANDARD",
      evidence_refs: ["ev-nr", "ev-rel"],
    },
    T("04-10"),
  );

  // 父亲门外守候 + 一次缴费跑腿
  cmd.recordFamilyActivity(
    store,
    claimId,
    {
      activity_id: "fa-dad-standby",
      family_member_id: "dad",
      activity_type: "STANDBY",
      period: { start: "2026-03-10", end: "2026-03-20" },
      evidence_refs: ["ev-nt"],
    },
    T("03-21"),
  );
  cmd.recordFamilyActivity(
    store,
    claimId,
    {
      activity_id: "fa-dad-errand",
      family_member_id: "dad",
      activity_type: "ERRAND",
      errand_kind: "PAY_FEES",
      period: { start: "2026-03-15", end: "2026-03-15" },
      evidence_refs: ["ev-fee"],
    },
    T("03-21"),
  );

  // 有权人员判断
  cmd.classifyCare(
    store,
    claimId,
    ACTORS.adjudicator,
    {
      classification_id: "cc-mi",
      target_type: "MEDICAL_CARE_ITEM",
      target_id: "mi-nurse",
      care_class: "MEDICAL_CARE",
      reason_codes: ["FACT_HOSPITAL_PROFESSIONAL_NURSING", "FACT_FEE_ITEM_PAID"],
      evidence_refs: ["ev-fee"],
    },
    T("04-12"),
  );
  cmd.classifyCare(
    store,
    claimId,
    ACTORS.adjudicator,
    {
      classification_id: "cc-mom",
      target_type: "LIVING_CARE_NEED",
      target_id: "ln-mom",
      care_class: "LIVING_CARE",
      reason_codes: ["FACT_DOCTOR_ORDER_CARE", "FACT_FAMILY_CARE_ATTESTED"],
      evidence_refs: ["ev-nr", "ev-rel"],
    },
    T("04-12"),
  );

  return { store, claimId, evidence };
}

/** 对父亲两项行为判排除：门外守候不自动拒，须有可证的事实理由 */
export function classifyDadExcluded(store, claimId) {
  cmd.classifyCare(
    store,
    claimId,
    ACTORS.adjudicator,
    {
      classification_id: "cc-dad-standby",
      target_type: "FAMILY_ACTIVITY",
      target_id: "fa-dad-standby",
      care_class: "EXCLUDED",
      reason_codes: ["FACT_NO_PATIENT_CONTACT_CARE", "KEYWORD_WAIT_OUTSIDE_ONLY"],
      evidence_refs: ["ev-nt"],
    },
    "2026-04-12T11:00:00+08:00",
  );
  cmd.classifyCare(
    store,
    claimId,
    ACTORS.adjudicator,
    {
      classification_id: "cc-dad-errand",
      target_type: "FAMILY_ACTIVITY",
      target_id: "fa-dad-errand",
      care_class: "EXCLUDED",
      reason_codes: ["FACT_ACTIVITY_IS_ERRAND"],
      evidence_refs: ["ev-fee"],
    },
    "2026-04-12T11:00:00+08:00",
  );
}

export { T, cmd };
