/**
 * 只追加事件存储。
 *
 * 保证：
 *  - event_id 全局唯一、重放提交幂等（重复提交同一 event_id 直接忽略）；
 *  - 同一聚合 version 从 1 起连续、单调，不允许并发覆盖；
 *  - 全局 seq 单调，按 seq 重放即得到确定的事实时间线；
 *  - 补证只追加新事件，历史事件不可修改、不可删除。
 */

import { validateEvent } from "./validator.js";

export class EventStore {
  #events = [];
  #byId = new Map();
  #aggregates = new Map(); // aggregate_key -> 最新 version
  #listeners = new Set();

  /**
   * 追加一个或多个事件（顺序写入）。
   * 已存在的 event_id 视为重放提交，跳过且不报错。
   * @returns {{ appended: DomainEvent[], skipped: DomainEvent[] }}
   */
  append(events) {
    const batch = Array.isArray(events) ? events : [events];
    const appended = [];
    const skipped = [];
    for (const event of batch) {
      const errors = validateEvent(event);
      if (errors.length) throw new Error(`事件信封非法（${event.event_id ?? "?"}）：${errors.join("；")}`);

      if (this.#byId.has(event.event_id)) {
        skipped.push(this.#byId.get(event.event_id));
        continue;
      }

      const key = `${event.aggregate_type}:${event.aggregate_id}`;
      const expected = (this.#aggregates.get(key) ?? 0) + 1;
      if (event.version !== expected) {
        throw new Error(
          `聚合 ${key} 版本冲突：期望 v${expected}，收到 v${event.version}（历史不可覆盖，请追加新事件）`,
        );
      }

      const stored = { ...event, seq: this.#events.length + 1 };
      this.#events.push(stored);
      this.#byId.set(stored.event_id, stored);
      this.#aggregates.set(key, stored.version);
      appended.push(stored);
      for (const listener of this.#listeners) listener(stored);
    }
    return { appended, skipped };
  }

  /** 按全局顺序读取事件；upToSeq 用于重放冻结时点的历史 */
  read({ claimId, upToSeq } = {}) {
    return this.#events
      .filter((e) => (claimId ? (e.claim_id ?? (e.aggregate_type === "injury_claim" ? e.aggregate_id : null)) === claimId : true))
      .filter((e) => (upToSeq ? e.seq <= upToSeq : true));
  }

  /** 某聚合的下一个 version（追加前调用） */
  nextVersion(aggregateType, aggregateId) {
    return (this.#aggregates.get(`${aggregateType}:${aggregateId}`) ?? 0) + 1;
  }

  eventsForAggregate(aggregateType, aggregateId) {
    return this.#events.filter((e) => e.aggregate_type === aggregateType && e.aggregate_id === aggregateId);
  }

  get byId() {
    return this.#byId;
  }

  get size() {
    return this.#events.length;
  }

  /** 订阅追加（用于构建实时读模型，测试也可用） */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

/**
 * 单例存储供应用代码共享；测试可直接 new EventStore() 获得隔离实例。
 */
export const sharedStore = new EventStore();
