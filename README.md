# ICU 场外照护举证后端

保险理赔中 ICU 护理费的场外照护举证与计算后端。它把**证据事实**、**法律规则匹配**与**有权人员判断**严格分层，
事件溯源、只追加、可重放，保证“采用了哪些事实、适用哪版规则、金额如何形成、争议时依据什么”全程可查。

## 设计原则（对应业务红线）

1. **不得仅凭关键词自动通过或拒绝**：系统不会因为材料里出现“ICU”就整段通过，也不会因为家属“门外守候、没进病房”就整段拒绝。
   通过/拒绝只能由 `ADJUDICATOR` 经 `CARE_CLASSIFIED` 作出，且理由必须含可证的证据事实或机构意见；
   `KEYWORD_ICU_ONLY`、`KEYWORD_WAIT_OUTSIDE_ONLY` 只能作备注，单独出现即被守卫拒绝。
2. **事实 / 规则 / 判断三分**：
   - 证据事实：谁在何时提交了什么（`EVIDENCE_SUBMITTED` 等），任何授权主体可补交，只追加；
   - 规则匹配：人数上限、期限上限、地区劳务标准由规则版本簿自动给出，不产生人工结论；
   - 有权判断：仅裁决人员可定性（医疗护理 / 生活照护 / 不予认定）。
3. **按事故发生时版本计算**：护理人数（原则 1 人）、期限上限、地区劳务标准一律按事故发生日生效的规则版本钉选（`RULE_VERSION_PINNED`），
   与理赔处理日期无关。任何例外（多人护理、超期、异地标准、医疗/生活重叠）**必须引用医疗意见或鉴定意见**。
4. **重复材料只归并引用**：指纹相同的材料由人工确认归并（`EVIDENCE_MERGED`），正本保留、重复件转引用，原始提交事件不删除、不覆盖。
5. **补证不覆盖原提交**：每次补交都是独立证据编号与独立事件；对原生活照护主张的更正用 `supersedes` 形成补正链，原记录保留。
6. **争议冻结当时快照**：进入复核自动冻结当时计算快照（`CALCULATION_FROZEN`，含 `input_seq` + 规则版本 + 规范化 SHA-256），
   之后任何补交都不改快照；复核者可重放至 `input_seq` 复算并校验哈希。
7. **后继更正只追加**：二审裁判、新鉴定结果以 `FOLLOWUP_RESULT_RECORDED` 登记，再经 `DECISION_REVISED` 形成新裁决，
   原裁决与原快照永久保留、可比对。
8. **最小可见范围**：
   - 医疗详情（病历、费用单、护理记录原文）：裁决/复核可见，受害方只见结论性期间与金额，对方保险人员不可见；
   - 家属收入与误工材料原文：裁决/复核可见；
   - 对方保险内部通知材料：对方保险人员可见。

## 目录

- `contracts/domain.schema.json`：领域事件信封、事件与聚合枚举（向后兼容扩展）。
- `src/domain.js`：领域词汇——事件/聚合、证据种类、密级标签、护理类别、三分理由码、事件工厂。
- `src/validator.js`：信封基础校验。
- `src/store.js`：只追加事件存储（`event_id` 幂等、聚合版本连续、全局 `seq`）。
- `src/model.js`：`foldClaim` 纯重放读模型，支持 `upToSeq` 重放任一历史时点。
- `src/periods.js`：闭区间日历日工具（交并差、重叠、覆盖天数）。
- `src/rules.js`：规则版本簿、事故时钉选、例外授权。
- `src/commands.js`：写侧命令——立案、钉选规则、多主体补证、重复归并、事实录入、护理性质判断守卫。
- `src/calculation.js`：计算引擎（见下）。
- `src/canonical.js`：规范化 JSON 与快照哈希。
- `src/decisions.js`：快照冻结/校验、裁决、复核、二审/新鉴定后继更正。
- `src/projections.js`：受害方 / 对方保险人员 / 复核者三类视图。
- `src/index.js`：统一出口。
- `tests/`：37 个 node:test 用例。
- `examples/walkthrough.mjs`：端到端走读。

## 计算引擎要点（`src/calculation.js`）

- **医院专业护理项目 = 医疗护理**：凭费用单按票计，计费期间超出住院区间（出院后）的部分按日比例剔除。
- **家属/护工陪护 = 生活照护**：按事故时版本地区劳务标准，或按护理人实际收入（须收入证明与误工材料，否则整线 `WITHHELD`，绝不按零或地区标准替代）。
- **同日不重复给付**：某日已计医院专业护理的，该日生活照护扣除（`MEDICAL_OVERLAP`），除非判断引用了机构意见的 `OVERLAP` 例外。
- **护理人数**：原则 1 人/日；同日多人按高报酬者优先、编号兜底确定给付；`MULTI_CAREGIVER` 鉴定意见覆盖当日才上调名额。
- **期限上限**：按日历日（多人同日不重复消耗额度）适用事故时版本上限；`PERIOD_CAP` 意见核准更长期限时替换上限。
- **未判断对象挂起 `PENDING`**：系统不替人定性，受害方视图明确显示“等待审查认定”。
- 每条线输出 `status`、认定日期清单、单价、金额与逐项扣减（原因/天数/日期/金额），金额形成完全可解释。

## 典型用法

```js
import { EventStore } from "./src/store.js";
import * as cmd from "./src/commands.js";
import * as dec from "./src/decisions.js";
import { victimView, reviewerAuditTrail } from "./src/projections.js";

const store = new EventStore();
cmd.openClaim(store, { claim_id: "c1", accident_date: "2026-03-10", accident_region: "310000" });
cmd.pinRules(store, "c1");                       // → RULES-2026（事故发生时生效版本）
cmd.submitEvidence(store, "c1", { evidence_id: "mr", kind: "MEDICAL_RECORD",
  submitted_by: "医院", submitted_by_role: "HOSPITAL" });
// …录入住院阶段、专业护理项目、生活照护需求、家属行为、机构意见…
cmd.classifyCare(store, "c1", adjudicator, { classification_id: "cc1",
  target_type: "MEDICAL_CARE_ITEM", target_id: "mi1",
  care_class: "MEDICAL_CARE", reason_codes: ["FACT_HOSPITAL_PROFESSIONAL_NURSING", "FACT_FEE_ITEM_PAID"] });
dec.freezeCalculation(store, "c1", { snapshot_id: "snap-1" });
dec.issueDecision(store, "c1", adjudicator, { decision_id: "d1", snapshot_id: "snap-1", outcome: "PARTIALLY_APPROVED" });

victimView(store, "c1");            // 缺什么、认定哪些时段、金额如何形成
reviewerAuditTrail(store, "c1");   // 全事件时间线 + 三分标注 + 快照重放校验 + 去重轨迹
```

## 本地检查

```bash
npm test
node examples/walkthrough.mjs
```
