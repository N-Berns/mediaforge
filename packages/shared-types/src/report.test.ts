import { describe, expect, it } from "vitest";
import { buildReportBody, MAX_DETAILS, REPORT_FORM, type Report, sendReport } from "./report.ts";

const base: Report = {
  description: "x",
  type: "Extension",
  extensionVersion: "0.2.0",
  appVersion: "0.2.0",
  os: "Windows 10/11",
  browser: "Firefox 128.0",
};

const reply = (status: number) => (async () => new Response("", { status })) as typeof fetch;

describe("report", () => {
  it("maps the report onto the form fields", () => {
    const body = buildReportBody({ ...base, description: " broke ", type: "App", details: "log" });
    expect(body.get(REPORT_FORM.fields.description)).toBe("broke");
    expect(body.get(REPORT_FORM.fields.type)).toBe("App");
    expect(body.get(REPORT_FORM.fields.extensionVersion)).toBe("0.2.0");
    expect(body.get(REPORT_FORM.fields.appVersion)).toBe("0.2.0");
    expect(body.get(REPORT_FORM.fields.os)).toBe("Windows 10/11");
    expect(body.get(REPORT_FORM.fields.browser)).toBe("Firefox 128.0");
    expect(body.get(REPORT_FORM.fields.details)).toBe("log");
  });

  it("says details were left out and clips long ones", () => {
    const none = buildReportBody(base);
    expect(none.get(REPORT_FORM.fields.details)).toBe("(not included)");
    const long = buildReportBody({ ...base, details: "a".repeat(99999) });
    expect(long.get(REPORT_FORM.fields.details)).toHaveLength(MAX_DETAILS);
  });

  it("refuses an empty description without sending", async () => {
    let sent = false;
    const post = (async () => {
      sent = true;
      return new Response("");
    }) as typeof fetch;
    const result = await sendReport({ ...base, description: "  " }, post);
    expect(result.ok).toBe(false);
    expect(sent).toBe(false);
  });

  it("reports success, a bad status and a network failure", async () => {
    const report = base;
    expect(await sendReport(report, reply(200))).toEqual({ ok: true });
    expect((await sendReport(report, reply(500))).ok).toBe(false);
    const failing = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect((await sendReport(report, failing)).ok).toBe(false);
  });
});
