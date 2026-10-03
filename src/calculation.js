/**
 * 计算引擎（纯函数）。
 *
 * 输入 foldClaim 重放得到的案件状态，输出可审计的计算明细。
 * 关键不变量：
 *  1. 只有经有权人员 CARE_CLASSIFIED 的对象才进入给付；未判断对象挂起，
 *     系统不替人下结论；
 *  2. 同一日的医院专业护理（医疗护理）与家属/护工陪护（生活照护）不重复
 *     给付，除非有权判断引用了机构意见的 OVERLAP 例外；
 *  3. 护理人数原则上 1 人/日，超员须引用 MULTI_CAREGIVER 意见；
 *  4. 生活照护总天数受事故时版本的期限上限约束，延期须引用 PERIOD_CAP 意见；
 *  5. 地区劳务标准按事故地默认版本，异地标准须引用 REGIONAL_STANDARD 意见；
 *  6. 主张实际收入却缺收入证明的，整线挂起（withheld），不按零元处理。
 */

import { CARE_CLASSES, CLASSIFICATION_REASONS, REQUIREMENT_CODES } from "./domain.js";
import { clamp, containedIn, coveredDays, days, fromDay, merge, subtract, toDay } from "./periods.js";
import { snapshotHash } from "./canonical.js";

export const DEDUCTION_REASONS = Object.freeze({
  OUTSIDE_HOSPITALIZATION: "OUTSIDE_HOSPITALIZATION", // 专业护理项目期间超出住院区间
  MEDICAL_OVERLAP: "MEDICAL_OVERLAP", // 同日已计医院专业护理
  CAREGIVER_LIMIT: "CAREGIVER_LIMIT", // 超过原则护理人数
  PERIOD_CAP: "PERIOD_CAP", // 超过事故时版本期限上限
  SUPERSEDED: "SUPERSEDED", // 已被补正记录取代
  NOT_CLASSIFIED: "NOT_CLASSIFIED", // 尚未经有权人员判断
  CLASSIFIED_EXCLUDED: "CLASSIFIED_EXCLUDED", // 经判断不予认定
  MISSING_INCOME_PROOF: "MISSING_INCOME_PROOF", // 主张实际收入但缺收入证明
});

const round2 = (n) => Math.round(n * 100) / 100;

function latestClassification(state, targetType, targetId) {
  const timeline = state.classificationsByTarget.get(`${targetType}:${targetId}`);
  return timeline?.length ? timeline[timeline.length - 1] : null;
}

function citedOpinions(state, cls) {
  return (cls?.opinion_refs ?? [])
    .map((ref) => ({ ref, opinion: state.opinions.get(ref.opinion_id) }))
    .filter((x) => x.opinion);
}

function periodCoversDay(period, day) {
  return period && toDay(period.start) <= day && day <= toDay(period.end);
}

/* ------------------------------------------------------------------ */
/* 举证清单缺口                                                        */
/* ------------------------------------------------------------------ */

export function missingRequirementCodes(state) {
  const book = state.pinnedRule;
  if (!book) return new Set();
  const active = [...state.evidence.values()].filter((e) => e.status === "ACTIVE" || e.status === "MERGED_DUPLICATE");
  const codes = new Set(book.requirements);
  const actualIncomeClaim = [...state.livingNeeds.values()].some(
    (n) => !n.superseded_by && n.income_basis === "ACTUAL_INCOME",
  );
  if (actualIncomeClaim) {
    codes.add(REQUIREMENT_CODES.REQ_CAREGIVER_INCOME.code);
    codes.add(REQUIREMENT_CODES.REQ_LOST_INCOME.code);
  }
  for (const ev of active) {
    if (ev.covers_requirement) codes.delete(ev.covers_requirement);
  }
  return codes;
}

export function missingRequirements(state) {
  return [...missingRequirementCodes(state)]
    .map((code) => ({ code, label: REQUIREMENT_CODES[code]?.label ?? code }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/* ------------------------------------------------------------------ */
/* 医疗护理（医院专业护理收费项目）                                    */
/* ------------------------------------------------------------------ */

function calculateMedical(state, hospitalizationUnion) {
  const lines = [];
  const paidPeriods = [];

  for (const item of [...state.medicalItems].sort((a, b) => a.item_id.localeCompare(b.item_id))) {
    const cls = latestClassification(state, "MEDICAL_CARE_ITEM", item.item_id);
    const base = {
      target_type: "MEDICAL_CARE_ITEM",
      target_id: item.item_id,
      name: item.name,
      period: item.period,
      billed_amount: item.amount,
      fee_evidence_refs: item.fee_evidence_refs,
    };

    if (!cls) {
      lines.push({ ...base, status: "PENDING", payable_amount: 0, reason: DEDUCTION_REASONS.NOT_CLASSIFIED });
      continue;
    }
    if (cls.care_class === CARE_CLASSES.EXCLUDED) {
      lines.push({
        ...base,
        status: "EXCLUDED",
        payable_amount: 0,
        reason: DEDUCTION_REASONS.CLASSIFIED_EXCLUDED,
        reason_codes: cls.reason_codes,
      });
      continue;
    }
    if (cls.care_class !== CARE_CLASSES.MEDICAL_CARE) {
      lines.push({ ...base, status: "PENDING", payable_amount: 0, reason: DEDUCTION_REASONS.NOT_CLASSIFIED });
      continue;
    }

    // 专业护理计费期间超出住院区间的部分按日比例剔除
    const inside = hospitalizationUnion.length
      ? merge(hospitalizationUnion.map((p) => clamp(item.period, p)).filter(Boolean))
      : [];
    const outside = subtract(item.period, inside);
    const totalDays = days(item.period.start, item.period.end);
    const insideDays = coveredDays(inside);
    const daily = item.amount / totalDays;
    const payable = round2(daily * insideDays);

    lines.push({
      ...base,
      status: "PAYABLE",
      payable_periods: inside,
      excluded_periods: outside,
      payable_days: insideDays,
      daily_prorated: round2(daily),
      payable_amount: payable,
      reason_codes: cls.reason_codes,
      classification_id: cls.classification_id,
      deductions: outside.length
        ? [
            {
              reason: DEDUCTION_REASONS.OUTSIDE_HOSPITALIZATION,
              periods: outside,
              amount: round2(item.amount - payable),
            },
          ]
        : [],
    });
    paidPeriods.push(...inside);
  }

  return { lines, paidPeriods: merge(paidPeriods), total: round2(lines.reduce((s, l) => s + (l.payable_amount ?? 0), 0)) };
}

/* ------------------------------------------------------------------ */
/* 生活照护（家属/护工陪护）                                           */
/* ------------------------------------------------------------------ */

function buildLivingEntries(state) {
  const entries = [];
  const book = state.pinnedRule;

  for (const need of [...state.livingNeeds.values()].sort((a, b) => a.need_id.localeCompare(b.need_id))) {
    const cls = latestClassification(state, "LIVING_CARE_NEED", need.need_id);
    const citations = citedOpinions(state, cls);
    const regionCitation = citations.find((c) =>
      c.ref.reason_code === CLASSIFICATION_REASONS.OPINION_NONLOCAL_STANDARD.code,
    );
    const multiCitation = citations.find((c) =>
      c.ref.reason_code === CLASSIFICATION_REASONS.OPINION_MULTI_CAREGIVER.code,
    );
    const overlapCitation = citations.find((c) =>
      c.ref.reason_code === CLASSIFICATION_REASONS.OPINION_OVERLAP_RESOLUTION.code,
    );
    const capCitation = citations.find((c) =>
      c.ref.reason_code === CLASSIFICATION_REASONS.OPINION_PERIOD_EXTENSION.code,
    );

    const region = regionCitation?.opinion.region_override ?? state.claim.accident_region ?? book.default_region;
    const standard = book.regional_labor_standards[region];

    entries.push({
      target_type: "LIVING_CARE_NEED",
      target_id: need.need_id,
      caregiver_id: need.caregiver_id,
      period: need.period,
      basis: need.income_basis,
      region,
      rate:
        need.income_basis === "ACTUAL_INCOME"
          ? need.daily_income // 可能为 null → 整线挂起
          : standard?.daily_rate ?? null,
      rate_source:
        need.income_basis === "ACTUAL_INCOME"
          ? "护理人实际日收入（待收入证明）"
          : standard?.source ?? `规则 ${book.version} 未收录地区 ${region} 的劳务标准`,
      superseded_by: need.superseded_by,
      cls,
      multi_count: multiCitation?.opinion.approved_caregiver_count ?? null,
      multi_period: multiCitation?.opinion.period ?? null,
      overlap_allow_periods: overlapCitation ? overlapCitation.opinion.overlap_allow_periods ?? [] : [],
      cap_opinion: capCitation?.opinion ?? null,
    });
  }

  // 家属行为（待命/事务）：未经判断为 PENDING；判生活照护才给付；判排除则列明
  for (const act of [...state.familyActivities.values()].sort((a, b) => a.activity_id.localeCompare(b.activity_id))) {
    const cls = latestClassification(state, "FAMILY_ACTIVITY", act.activity_id);
    const region = state.claim.accident_region ?? book.default_region;
    entries.push({
      target_type: "FAMILY_ACTIVITY",
      target_id: act.activity_id,
      caregiver_id: act.family_member_id,
      period: act.period,
      basis: "LOCAL_LABOR_STANDARD",
      region,
      rate: book.regional_labor_standards[region]?.daily_rate ?? null,
      rate_source: book.regional_labor_standards[region]?.source ?? "地区劳务标准缺失",
      superseded_by: null,
      cls,
      multi_count: null,
      multi_period: null,
      overlap_allow_periods: [],
      cap_opinion: null,
    });
  }

  return entries;
}

function eachDay(period) {
  const out = [];
  for (let d = toDay(period.start), end = toDay(period.end); d <= end; d++) out.push(d);
  return out;
}

/** 当日合法护理人数：任一条经判断的需求引用了覆盖当日的多人护理意见，即上调额度 */
function caregiverAllowance(rawEntries, book, day) {
  let allowed = book.caregiver_limit;
  for (const o of rawEntries) {
    if (o.multi_count && (!o.multi_period || periodCoversDay(o.multi_period, day))) {
      allowed = Math.max(allowed, o.multi_count);
    }
  }
  return allowed;
}

function calculateLiving(state, paidMedicalPeriods) {
  const book = state.pinnedRule;
  const rawEntries = buildLivingEntries(state);
  const missing = missingRequirementCodes(state);
  const lines = [];
  /** @type {{day:number, entry:object, rate:number}[]} */
  const payablePairs = [];

  for (const entry of rawEntries) {
    const base = {
      target_type: entry.target_type,
      target_id: entry.target_id,
      caregiver_id: entry.caregiver_id,
      period: entry.period,
      income_basis: entry.basis,
      region: entry.region,
      rate_source: entry.rate_source,
      classification_id: entry.cls?.classification_id ?? null,
    };

    if (entry.superseded_by) {
      lines.push({ ...base, status: "SUPERSEDED", payable_amount: 0, daily_rate: entry.rate, reason: DEDUCTION_REASONS.SUPERSEDED, superseded_by: entry.superseded_by });
      continue;
    }
    if (!entry.cls) {
      lines.push({ ...base, status: "PENDING", payable_amount: 0, daily_rate: entry.rate, reason: DEDUCTION_REASONS.NOT_CLASSIFIED });
      continue;
    }
    if (entry.cls.care_class === CARE_CLASSES.EXCLUDED) {
      lines.push({ ...base, status: "EXCLUDED", payable_amount: 0, daily_rate: entry.rate, reason: DEDUCTION_REASONS.CLASSIFIED_EXCLUDED, reason_codes: entry.cls.reason_codes });
      continue;
    }
    if (
      entry.basis === "ACTUAL_INCOME" &&
      (entry.rate === null || entry.rate === undefined || missing.has(REQUIREMENT_CODES.REQ_CAREGIVER_INCOME.code))
    ) {
      // 主张实际收入却缺收入证明（或减损材料）：整线挂起，绝不能按零元或地区标准替代
      lines.push({
        ...base,
        status: "WITHHELD",
        payable_amount: 0,
        daily_rate: entry.rate,
        reason: DEDUCTION_REASONS.MISSING_INCOME_PROOF,
      });
      continue;
    }
    if (entry.rate === null || entry.rate === undefined) {
      lines.push({
        ...base,
        status: "WITHHELD",
        payable_amount: 0,
        daily_rate: null,
        reason: "MISSING_REGIONAL_STANDARD",
      });
      continue;
    }

    const blocked = new Map(); // reason -> [days]
    const payableDays = [];
    for (const day of eachDay(entry.period)) {
      const coveredByMedical = paidMedicalPeriods.some((p) => periodCoversDay(p, day));
      const overlapAllowed = entry.overlap_allow_periods.some((p) => periodCoversDay(p, day));
      if (coveredByMedical && !overlapAllowed) {
        pushDay(blocked, DEDUCTION_REASONS.MEDICAL_OVERLAP, day);
        continue;
      }
      const allowed = caregiverAllowance(rawEntries, book, day);
      // 选择当日给付的护理人：日报酬高者优先，编号兜底，保证确定性
      const rivals = rawEntries
        .filter(
          (o) =>
            o !== entry &&
            !o.superseded_by &&
            o.cls?.care_class === CARE_CLASSES.LIVING_CARE &&
            o.rate !== null &&
            periodCoversDay(o.period, day),
        )
        .filter((o) => {
          // 当日被医疗护理去重的护理人不占给付名额（除非持有重叠例外）
          const medBlocked = paidMedicalPeriods.some((p) => periodCoversDay(p, day));
          const allow = o.overlap_allow_periods.some((p) => periodCoversDay(p, day));
          return !(medBlocked && !allow);
        });
      const ranked = [...rivals.map((o) => ({ id: o.caregiver_id, rate: o.rate })), { id: entry.caregiver_id, rate: entry.rate }]
        .filter((x, i, arr) => arr.findIndex((y) => y.id === x.id) === i)
        .sort((a, b) => b.rate - a.rate || a.id.localeCompare(b.id));
      if (ranked.findIndex((x) => x.id === entry.caregiver_id) >= allowed) {
        pushDay(blocked, DEDUCTION_REASONS.CAREGIVER_LIMIT, day);
        continue;
      }
      payableDays.push(day);
    }

    lines.push({
      ...base,
      status: "ALLOCATED",
      daily_rate: entry.rate,
      payable_days_pre_cap: payableDays.length,
      blocked_breakdown: [...blocked.entries()].map(([reason, ds]) => ({ reason, days: ds.map(fromDay), day_count: ds.length })),
      _payableDays: payableDays,
      _capOpinion: entry.cap_opinion,
    });
    for (const day of payableDays) payablePairs.push({ day, entry, rate: entry.rate });
  }

  /* 期限上限：按日历日计（同一日历日合法多人护理不重复消耗额度）。
     逐日放行；当日存在覆盖该日的 PERIOD_CAP 意见时，上限替换为意见核准天数。 */
  for (const line of lines) {
    if (line.status !== "ALLOCATED") continue;
    line.payable_days = 0;
    line.payable_dates = [];
    line.cap_deducted_days = 0;
    line.cap_deducted_dates = [];
  }
  const byTarget = new Map(lines.filter((l) => l._payableDays).map((l) => [l.target_id, l]));

  // 聚合到日历日：day -> 当日应给付的 {entry,rate} 列表
  const byDay = new Map();
  for (const pair of payablePairs) {
    if (!byDay.has(pair.day)) byDay.set(pair.day, []);
    byDay.get(pair.day).push(pair);
  }
  const capTrace = new Map(); // 口径 -> {used_days, cap_days}
  let payableDayOrdinal = 0;
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    const pairsOfDay = byDay.get(day);
    let cap = book.period_cap_days;
    let traceKey = `规则${book.version}默认上限`;
    const extension = pairsOfDay
      .map((p) => p.entry)
      .find((en) => en.cap_opinion && periodCoversDay(en.cap_opinion.period ?? en.period, day));
    if (extension) {
      cap = extension.cap_opinion.approved_cap_days ?? cap;
      traceKey = `${extension.cap_opinion.opinion_id} 核准上限`;
    }
    payableDayOrdinal++;
    if (!capTrace.has(traceKey)) capTrace.set(traceKey, { used_days: 0, cap_days: cap });
    if (payableDayOrdinal > cap) {
      for (const { entry } of pairsOfDay) {
        const line = byTarget.get(entry.target_id);
        line.cap_deducted_days++;
        line.cap_deducted_dates.push(fromDay(day));
      }
      continue;
    }
    capTrace.get(traceKey).used_days++;
    for (const { entry } of pairsOfDay) {
      const line = byTarget.get(entry.target_id);
      line.payable_days++;
      line.payable_dates.push(fromDay(day));
    }
  }

  for (const line of lines) {
    if (line.status !== "ALLOCATED") continue;
    line.payable_amount = round2((line.payable_days ?? 0) * line.daily_rate);
    line.deductions = [
      ...line.blocked_breakdown.map((b) => ({ reason: b.reason, day_count: b.day_count, dates: b.days, amount: round2(b.day_count * line.daily_rate) })),
      ...(line.cap_deducted_days
        ? [{ reason: DEDUCTION_REASONS.PERIOD_CAP, day_count: line.cap_deducted_days, dates: line.cap_deducted_dates, amount: round2(line.cap_deducted_days * line.daily_rate) }]
        : []),
    ];
    delete line._payableDays;
    delete line._capOpinion;
    delete line.blocked_breakdown;
    delete line.payable_days_pre_cap;
    delete line.cap_deducted_dates;
  }

  const total = round2(lines.reduce((s, l) => s + (l.payable_amount ?? 0), 0));
  const cap_trace = [...capTrace.entries()].map(([budget, v]) => ({ budget, ...v }));
  return { lines, total, cap_trace };
}

function pushDay(map, reason, day) {
  if (!map.has(reason)) map.set(reason, []);
  map.get(reason).push(day);
}

/* ------------------------------------------------------------------ */
/* 总计算                                                              */
/* ------------------------------------------------------------------ */

export function calculate(state) {
  if (!state.claim) throw new Error("案件尚未开启");
  if (!state.pinnedRule) throw new Error("规则版本尚未按事故发生时钉选");

  const hospitalizationUnion = merge(state.phases.map((p) => p.period));
  const medical = calculateMedical(state, hospitalizationUnion);
  const living = calculateLiving(state, medical.paidPeriods);
  const missing = missingRequirements(state);

  const calculation = {
    rule_version: state.pinnedRule.version,
    accident_date: state.claim.accident_date,
    hospitalization_union: hospitalizationUnion,
    medical_care: medical,
    living_care: living,
    total: round2(medical.total + living.total),
    currency: "CNY",
  };

  return { calculation, missing_requirements: missing, input_seq: state.lastSeq };
}

/** 计算并生成冻结哈希（不写事件；写事件由 decisions.freezeCalculation 完成） */
export function calculateWithHash(state) {
  const result = calculate(state);
  const hashInput = {
    input_seq: result.input_seq,
    rule_version: result.calculation.rule_version,
    calculation: result.calculation,
  };
  return { ...result, hash: snapshotHash(hashInput) };
}
