/**
 * 计算规则版本簿。
 *
 * 不变量：护理人数上限、护理期限上限、地区劳务报酬标准，一律按
 * “事故发生时”正在生效的规则版本计算；任何偏离默认值的例外，
 * 都必须引用医疗意见或鉴定意见（见 EXCEPTION_KEYS）。
 */

import { isBeforeOrEqual } from "./periods.js";
import { REQUIREMENT_CODES } from "./domain.js";

/** 例外类型：每种例外只允许由机构意见开启 */
export const EXCEPTION_KEYS = Object.freeze({
  MULTI_CAREGIVER: "MULTI_CAREGIVER", // 多人护理
  PERIOD_CAP: "PERIOD_CAP", // 超过期限上限
  REGIONAL_STANDARD: "REGIONAL_STANDARD", // 适用非事故地/非默认地区劳务标准
  OVERLAP: "OVERLAP", // 医疗护理与生活照护重叠日的取舍
});

/**
 * @typedef {Object} RuleBook
 * @property {string} version            版本标识
 * @property {string} effective_from     生效日（含）
 * @property {string|null} effective_to  失效日（含），null 表示至今
 * @property {number} caregiver_limit    默认护理人数（原则上 1 人）
 * @property {number} period_cap_days    生活照护期限上限（日历日）
 * @property {string} default_region     默认地区编码（事故地）
 * @property {Record<string,{daily_rate:number, source:string}>} regional_labor_standards
 * @property {string[]} requirements     该版本要求的举证清单
 */

/** @type {RuleBook[]} 按生效时间排列，实际部署可由规则平台下发 */
export const RULE_BOOKS = [
  {
    version: "RULES-2020",
    effective_from: "2020-01-01",
    effective_to: "2025-12-31",
    caregiver_limit: 1,
    period_cap_days: 150,
    default_region: "310000",
    regional_labor_standards: {
      310000: { daily_rate: 180, source: "上海市2020年度居民服务业劳务报酬参考" },
      320000: { daily_rate: 150, source: "江苏省2020年度居民服务业劳务报酬参考" },
    },
    requirements: [
      REQUIREMENT_CODES.REQ_HOSPITALIZATION.code,
      REQUIREMENT_CODES.REQ_CARE_DEPENDENCY.code,
      REQUIREMENT_CODES.REQ_RELATION.code,
      REQUIREMENT_CODES.REQ_NOTICE.code,
    ],
  },
  {
    version: "RULES-2026",
    effective_from: "2026-01-01",
    effective_to: null,
    caregiver_limit: 1,
    period_cap_days: 180,
    default_region: "310000",
    regional_labor_standards: {
      310000: { daily_rate: 210, source: "上海市2026年度居民服务业劳务报酬参考" },
      320000: { daily_rate: 175, source: "江苏省2026年度居民服务业劳务报酬参考" },
    },
    requirements: [
      REQUIREMENT_CODES.REQ_HOSPITALIZATION.code,
      REQUIREMENT_CODES.REQ_CARE_DEPENDENCY.code,
      REQUIREMENT_CODES.REQ_RELATION.code,
      REQUIREMENT_CODES.REQ_NOTICE.code,
    ],
  },
];

/**
 * 按事故发生日钉选规则版本。
 * @param {string} accidentDate YYYY-MM-DD
 * @param {RuleBook[]} [books]
 * @returns {RuleBook}
 */
export function pinRuleBook(accidentDate, books = RULE_BOOKS) {
  const hit = books.find(
    (b) =>
      isBeforeOrEqual(b.effective_from, accidentDate) &&
      (b.effective_to === null || isBeforeOrEqual(accidentDate, b.effective_to)),
  );
  if (!hit) throw new Error(`事故发生日 ${accidentDate} 没有可用的规则版本`);
  return hit;
}

/**
 * 申请例外。例外必须携带医疗/鉴定意见引用，否则拒绝。
 * @returns {{allowed:true, opinion_ref:string, opinion_id:string, reason_code:string}}
 */
export function grantException(exceptionKey, opinionRef, ruleVersion) {
  if (!EXCEPTION_KEYS[exceptionKey]) throw new Error(`未知例外类型：${exceptionKey}`);
  if (!opinionRef || !opinionRef.opinion_id || !opinionRef.reason_code) {
    throw new Error(`例外 ${exceptionKey} 必须引用医疗或鉴定意见`);
  }
  return {
    allowed: true,
    exception: exceptionKey,
    opinion_id: opinionRef.opinion_id,
    reason_code: opinionRef.reason_code,
    rule_version: ruleVersion,
  };
}
