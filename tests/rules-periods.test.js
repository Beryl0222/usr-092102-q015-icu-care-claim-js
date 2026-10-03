import assert from "node:assert/strict";
import test from "node:test";

import {
  clamp,
  coveredDays,
  days,
  intersection,
  merge,
  overlaps,
  subtract,
} from "../src/periods.js";
import { EXCEPTION_KEYS, grantException, pinRuleBook } from "../src/rules.js";

test("闭区间天数首尾各计一天", () => {
  assert.equal(days("2026-03-10", "2026-03-20"), 11);
});

test("区间交集与重叠判定", () => {
  assert.equal(overlaps({ start: "2026-03-10", end: "2026-03-20" }, { start: "2026-03-20", end: "2026-03-21" }), true);
  assert.deepEqual(
    intersection({ start: "2026-03-10", end: "2026-03-20" }, { start: "2026-03-15", end: "2026-03-25" }),
    { start: "2026-03-15", end: "2026-03-20" },
  );
  assert.equal(clamp({ start: "2026-03-01", end: "2026-03-31" }, { start: "2026-03-10", end: "2026-03-20" }).start, "2026-03-10");
});

test("并集天数重叠日只计一次；挖洞后正确扣减", () => {
  assert.equal(
    coveredDays([
      { start: "2026-03-10", end: "2026-03-20" },
      { start: "2026-03-15", end: "2026-03-25" },
    ]),
    16,
  );
  const rest = subtract({ start: "2026-03-10", end: "2026-03-20" }, [{ start: "2026-03-15", end: "2026-03-20" }]);
  assert.deepEqual(rest, [{ start: "2026-03-10", end: "2026-03-14" }]);
  assert.equal(merge([{ start: "2026-03-10", end: "2026-03-11" }, { start: "2026-03-12", end: "2026-03-13" }]).length, 1);
});

test("规则版本按事故发生时钉选，而非处理时", () => {
  // 事故在 2024 年，即使 2026 年才理赔，仍用 RULES-2020
  const old = pinRuleBook("2024-06-01");
  assert.equal(old.version, "RULES-2020");
  assert.equal(old.period_cap_days, 150);
  assert.equal(old.regional_labor_standards["310000"].daily_rate, 180);

  const now = pinRuleBook("2026-03-10");
  assert.equal(now.version, "RULES-2026");
  assert.equal(now.regional_labor_standards["310000"].daily_rate, 210);

  assert.throws(() => pinRuleBook("2001-01-01"), /没有可用的规则版本/);
});

test("例外必须引用医疗或鉴定意见", () => {
  assert.throws(() => grantException(EXCEPTION_KEYS.MULTI_CAREGIVER, null, "RULES-2026"), /必须引用/);
  const g = grantException(
    EXCEPTION_KEYS.PERIOD_CAP,
    { opinion_id: "op-1", reason_code: "OPINION_PERIOD_EXTENSION" },
    "RULES-2026",
  );
  assert.equal(g.allowed, true);
  assert.equal(g.opinion_id, "op-1");
});
