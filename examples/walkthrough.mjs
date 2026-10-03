/**
 * 端到端走读：一个事故案件从立案、多主体补证、护理判断、计算冻结、
 * 裁决、复核到二审更正的全过程，并打印三类角色视图。
 *
 * 运行：node examples/walkthrough.mjs
 */

import { buildStandardCase, classifyDadExcluded, ACTORS, T } from "../tests/helpers.js";
import * as dec from "../src/decisions.js";
import { victimView, insurerView, reviewerAuditTrail } from "../src/projections.js";

const { store, claimId } = buildStandardCase();
classifyDadExcluded(store, claimId);

// 1) 冻结计算快照并裁决
dec.freezeCalculation(store, claimId, { snapshot_id: "snap-1" }, T("04-15"));
dec.issueDecision(
  store,
  claimId,
  ACTORS.adjudicator,
  {
    decision_id: "dec-1",
    snapshot_id: "snap-1",
    outcome: "PARTIALLY_APPROVED",
    rationale: ["ICU 期专业护理凭票认定；普通病房期生活照护按事故时版本劳务标准认定"],
  },
  T("04-16"),
);

// 2) 争议进入复核，冻结当时快照；二审裁判后继更正
dec.openReview(store, claimId, ACTORS.reviewer, { review_id: "rv-1", reason: "家属对护理人数有异议" }, T("05-10"));
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
    changes: ["二审意见（此处仅登记事实，是否改变给付仍须重新举证、重算与裁决）"],
  },
  T("08-05"),
);

const victim = victimView(store, claimId);
console.log("【受害方视图】");
console.log("  缺证：", victim.evidence_status.missing.map((m) => m.label));
console.log("  住院区间：", victim.hospitalization_periods);
for (const l of victim.recognized.living_care) {
  console.log(
    `  生活照护 ${l.target_id}：${l.status}，认定 ${l.recognized_days} 天（${l.recognized_dates[0] ?? "-"} ~ ${l.recognized_dates.at(-1) ?? "-"}），单价 ${l.daily_rate ?? "-"}，金额 ${l.amount}`,
  );
  for (const d of l.deductions ?? []) console.log(`      扣减：${d.explanation}（${d.day_count} 天，${d.amount} 元）`);
}
console.log("  金额形成：医疗", victim.amount_formation.medical_total, "+ 生活", victim.amount_formation.living_total, "=", victim.amount_formation.total);
console.log("  裁决：", victim.decision);

console.log("\n【对方保险人员视图】医疗/收入材料被遮蔽，仅见通知材料与总额");
const insurer = insurerView(store, claimId);
console.log("  证据遮蔽示例：", insurer.evidence.slice(0, 3));
console.log("  总额：", insurer.totals);

console.log("\n【复核者视图】可重放全过程");
const audit = reviewerAuditTrail(store, claimId);
console.log("  规则版本：", audit.pinned_rule_version);
console.log("  事件数：", audit.timeline.length);
console.log("  医疗护理已给付区间：", audit.paid_medical_periods, "（", audit.medical_paid_days, "天）");
console.log("  重叠扣减：", audit.overlap_deductions.map((d) => `${d.target_id} ${d.day_count}天`));
console.log("  快照重放校验：", audit.snapshots.map((s) => `${s.snapshot_id}=${s.verification.consistent}`));
console.log("  裁决链：", audit.decision_chain.map((d) => `${d.decision_id}${d.revision_of ? `(更正自${d.revision_of})` : ""}`));
