import { validateEvent } from "./validator.js";

/**
 * 事件存储：以事件标识（event_id）接收事件。
 * 同一标识重复接收且内容一致时幂等返回；内容不一致时拒绝，防止身份被重用。
 */
export class EventStore {
  #events = new Map();

  append(event) {
    const errors = validateEvent(event);
    if (errors.length > 0) {
      throw new Error(`事件校验失败：${errors.join("；")}`);
    }
    const existing = this.#events.get(event.event_id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(event)) {
        throw new Error(`事件标识冲突：${event.event_id}`);
      }
      return { appended: false, event: existing };
    }
    this.#events.set(event.event_id, event);
    return { appended: true, event };
  }

  appendAll(events) {
    return events.map((event) => this.append(event));
  }

  get(eventId) {
    return this.#events.get(eventId) ?? null;
  }

  all() {
    return [...this.#events.values()];
  }

  byType(eventType) {
    return this.all().filter((event) => event.event_type === eventType);
  }
}
