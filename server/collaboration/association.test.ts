import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { decideMessageAssociation } from "./association.ts";
import { renderAssociationChoiceCard } from "./message-renderer.ts";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function database(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE collaboration_work_items (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE collaboration_external_events (
      source TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      work_item_id TEXT
    );
  `);
  return database;
}

function insertWorkItem(
  database: DatabaseSync,
  id: string,
  title: string,
  updatedAt: number,
  status = "collecting",
): void {
  database
    .prepare(
      "INSERT INTO collaboration_work_items (id, conversation_id, title, status, updated_at) VALUES (?, 'conversation-1', ?, ?, ?)",
    )
    .run(id, title, status, updatedAt);
}

function decide(database: DatabaseSync, text: string, replyToSourceEventId?: string) {
  if (replyToSourceEventId) {
    return decideMessageAssociation(database, {
      source: "dingtalk",
      conversationId: "conversation-1",
      text,
      replyToSourceEventId,
    });
  }
  return decideMessageAssociation(database, {
    source: "dingtalk",
    conversationId: "conversation-1",
    text,
  });
}

describe("natural message association", () => {
  it.each(["补充：失败时显示原因", "这是新问题：支付失败", "第二个"])("does not ignore an unresolved reply when interpreting %s", text => {
    const db = database();
    expect(decide(db, text, "unknown-bot-message")).toMatchObject({ kind: "ambiguous", workItemIds: [] });
    insertWorkItem(db, "WI-AAA1", "登录失败提示", 1);
    expect(decide(db, text, "unknown-bot-message")).toMatchObject({ kind: "ambiguous" });
    db.prepare("INSERT INTO collaboration_external_events VALUES ('dingtalk','foreign-parent','other-group','WI-AAA1')").run();
    expect(decide(db, text, "foreign-parent")).toMatchObject({ kind: "ambiguous" });
  });
  it("keeps explicit WI references ahead of a different valid reply chain", () => {
    const db = database();
    insertWorkItem(db, "WI-AAA1", "登录失败提示", 1);
    insertWorkItem(db, "WI-BBB2", "支付页按钮", 2);
    db.prepare(
      "INSERT INTO collaboration_external_events (source, source_event_id, conversation_id, work_item_id) VALUES ('dingtalk', 'event-parent', 'conversation-1', 'WI-AAA1')",
    ).run();

    expect(decide(db, "WI-BBB2 补充：按钮应使用品牌色", "event-parent")).toEqual({
      kind: "associate",
      workItemId: "WI-BBB2",
    });
  });

  it("keeps a valid reply ahead of new-task language", () => {
    const db = database();
    insertWorkItem(db, "WI-AAA1", "登录失败提示", 1);
    db.prepare(
      "INSERT INTO collaboration_external_events (source, source_event_id, conversation_id, work_item_id) VALUES ('dingtalk', 'event-parent', 'conversation-1', 'WI-AAA1')",
    ).run();

    expect(decide(db, "另一个问题：错误提示还要给出处理建议", "event-parent")).toEqual({
      kind: "associate",
      workItemId: "WI-AAA1",
    });
  });

  it.each(["新任务：优化个人中心", "另一个问题：支付按钮无响应", "另外一个需求，补充导出功能"])(
    "creates a new item for explicit topic-switch language: %s",
    (text) => {
      const db = database();
      insertWorkItem(db, "WI-AAA1", "登录失败提示", 1);
      expect(decide(db, text)).toEqual({ kind: "create" });
    },
  );

  it("creates a new item for the exact plain-language choice shown to users", () => {
    const db = database();
    insertWorkItem(db, "WI-AAA1", "登录失败提示", 1);
    expect(decide(db, "这是新问题：支付页按钮颜色需要调整")).toEqual({ kind: "create" });
  });

  it("associates only clear supplement or answer language to the sole active item", () => {
    const db = database();
    insertWorkItem(db, "WI-AAA1", "登录失败提示", 1);

    expect(decide(db, "补充复现条件：token 为空时出现")).toEqual({
      kind: "associate",
      workItemId: "WI-AAA1",
    });
    expect(decide(db, "确认，按第一个方案处理")).toEqual({
      kind: "associate",
      workItemId: "WI-AAA1",
    });
  });

  it("returns at most three recent titled candidates when attribution is uncertain", () => {
    const db = database();
    insertWorkItem(db, "WI-1111", "最早的问题", 1);
    insertWorkItem(db, "WI-2222", "登录失败提示", 2);
    insertWorkItem(db, "WI-3333", "支付页按钮", 3);
    insertWorkItem(db, "WI-4444", "导出报表为空", 4);

    expect(decide(db, "这个页面还要调整一下")).toEqual({
      kind: "ambiguous",
      workItemIds: ["WI-4444", "WI-3333", "WI-2222"],
      candidateWorkItems: [
        { id: "WI-4444", title: "导出报表为空" },
        { id: "WI-3333", title: "支付页按钮" },
        { id: "WI-2222", title: "登录失败提示" },
      ],
    });
  });

  it("associates an explicit business-title continuation without requiring a WI number", () => {
    const db = database();
    insertWorkItem(db, "WI-AAA1", "登录失败提示", 1);
    insertWorkItem(db, "WI-BBB2", "支付页按钮", 2);

    expect(decide(db, "继续【登录失败提示】，补充：空 token 时稳定复现")).toEqual({
      kind: "associate",
      workItemId: "WI-AAA1",
    });
  });

  it("returns one titled candidate rather than guessing for an unrelated message", () => {
    const db = database();
    insertWorkItem(db, "WI-AAA1", "登录失败提示", 1);

    expect(decide(db, "支付页按钮颜色需要调整")).toEqual({
      kind: "ambiguous",
      workItemIds: ["WI-AAA1"],
      candidateWorkItems: [{ id: "WI-AAA1", title: "登录失败提示" }],
    });
  });

  it("renders business titles for a user-facing attribution choice", () => {
    expect(
      renderAssociationChoiceCard(
        ["WI-AAA1", "WI-BBB2"],
        [
          { id: "WI-AAA1", title: "登录失败提示" },
          { id: "WI-BBB2", title: "支付页按钮" },
        ],
      ),
    ).toMatchObject({
      headline: "请选择问题归属",
      candidateWorkItems: [
        { id: "WI-AAA1", title: "登录失败提示" },
        { id: "WI-BBB2", title: "支付页按钮" },
      ],
    });
  });
});
