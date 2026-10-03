import { AGGREGATE_TYPES, EVENT_AGGREGATE, EVENT_TYPES } from "./domain.js";

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

/**
 * 校验领域事件信封的基础一致性。
 * 业务 payload 的校验由各模型负责，这里只约束交换格式。
 * @returns {string[]} 错误信息数组，空数组表示通过
 */
export function validateEvent(record) {
  const errors = required
    .filter((name) => record[name] === undefined || record[name] === null || record[name] === "")
    .map((name) => `缺少字段：${name}`);

  if (record.event_type !== undefined && !EVENT_AGGREGATE[record.event_type]) {
    errors.push(`未知事件类型：${record.event_type}`);
  }
  if (record.aggregate_type !== undefined && !Object.values(AGGREGATE_TYPES).includes(record.aggregate_type)) {
    errors.push(`未知聚合类型：${record.aggregate_type}`);
  }
  if (
    record.event_type !== undefined &&
    record.aggregate_type !== undefined &&
    EVENT_AGGREGATE[record.event_type] &&
    EVENT_AGGREGATE[record.event_type] !== record.aggregate_type
  ) {
    errors.push(
      `事件 ${record.event_type} 必须属于聚合 ${EVENT_AGGREGATE[record.event_type]}，实际为 ${record.aggregate_type}`,
    );
  }
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("occurred_at" in record && record.occurred_at !== "" && Number.isNaN(Date.parse(record.occurred_at))) {
    errors.push("occurred_at 必须是合法的 date-time");
  }
  return errors;
}

export const KNOWN_EVENT_TYPES = Object.freeze(Object.values(EVENT_TYPES));
