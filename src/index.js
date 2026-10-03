/**
 * ICU 场外照护举证后端 —— 统一出口。
 *
 * 分层：
 *   domain       领域词汇、事件信封与注册表
 *   validator    交换格式基础校验
 *   store        只追加事件存储（幂等、版本连续、全局 seq）
 *   model        foldClaim 纯重放读模型
 *   periods      日历日区间工具
 *   rules        按事故时生效的规则版本簿与例外授权
 *   commands     写侧：证据/事实录入、重复归并、护理性质判断（三分守卫）
 *   calculation  计算引擎：医疗护理与生活照护不重复给付、期限/人数/标准规则
 *   decisions    快照冻结、裁决、复核、二审/新鉴定后继更正
 *   projections  受害方、对方保险人员、复核者三类最小可见视图
 *   canonical    规范化哈希
 */

export * as domain from "./domain.js";
export { validateEvent } from "./validator.js";
export { EventStore, sharedStore } from "./store.js";
export { foldClaim, loadClaim } from "./model.js";
export * as periods from "./periods.js";
export { RULE_BOOKS, pinRuleBook, grantException, EXCEPTION_KEYS } from "./rules.js";
export * as commands from "./commands.js";
export {
  calculate,
  calculateWithHash,
  missingRequirements,
  DEDUCTION_REASONS,
} from "./calculation.js";
export * as decisions from "./decisions.js";
export {
  evidenceChecklist,
  victimView,
  insurerView,
  reviewerAuditTrail,
  projectionFor,
  VIEWER_ROLES,
} from "./projections.js";
export { stableStringify, snapshotHash } from "./canonical.js";
